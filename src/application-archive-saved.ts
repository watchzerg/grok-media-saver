import type { ReservedSQL } from "bun";
import { inspectFirstPage } from "./application";
import {
  archivePostInRun,
  type SavePostOptions,
  safeSaveError,
} from "./application-save-post";
import { type BrowserSession, connectBrowserSession } from "./browser/session";
import type { SaveConfig } from "./config";
import {
  classifyPostResult,
  emptyRunSummary,
  type RunSummary,
} from "./core/run-summary";
import { normalizePostId } from "./grok/adapter";
import { createRequestScheduler } from "./grok/request-scheduler";
import { connectDatabase } from "./store/database";
import {
  assertExecutorLock,
  releaseExecutorLock,
  tryAcquireExecutorLock,
} from "./store/executor";
import { interruptOrphanedRuns } from "./store/save-run";
import { KnownSaveFailure } from "./store/save-work";
import { verifySchema } from "./store/schema";

export type ArchiveSavedSummary = RunSummary & {
  discovered: number;
  newRemovals: number;
  rounds: number;
  lastRoundComplete: boolean | null;
  lastPage: "not-read" | "nonempty" | "empty" | "failed";
  endReason:
    | "completed"
    | "leftovers"
    | "no-progress"
    | "page-failed"
    | "stopped"
    | "blocked"
    | "fault";
  leftovers: { save: number; archive: number } | null;
};

export type ArchiveSavedOptions = {
  signal?: AbortSignal;
  onStage?: SavePostOptions["onStage"];
  connect?: (
    signal: AbortSignal,
    requestStarted: () => void,
  ) => Promise<BrowserSession>;
};

export type ArchiveSavedResult = {
  status: "ok" | "failed" | "blocked" | "cancelled";
  message: string;
  cleanupErrors: string[];
  summary: ArchiveSavedSummary;
  summaryRecorded: boolean | null;
  posts: {
    postId: string;
    goal: "archive";
    result: Awaited<ReturnType<typeof archivePostInRun>>;
  }[];
};

export async function archiveSaved(
  config: SaveConfig,
  options: ArchiveSavedOptions = {},
): Promise<ArchiveSavedResult> {
  const signal = options.signal ?? new AbortController().signal;
  const summary: ArchiveSavedSummary = {
    ...emptyRunSummary(),
    discovered: 0,
    newRemovals: 0,
    rounds: 0,
    lastRoundComplete: null,
    lastPage: "not-read",
    endReason: "fault",
    leftovers: null,
  };
  const result: ArchiveSavedResult = {
    status: "failed",
    message: "Saved 批量归档未完成。",
    cleanupErrors: [],
    summary,
    summaryRecorded: false,
    posts: [],
  };
  let sql: ReturnType<typeof connectDatabase> | undefined;
  let session: ReservedSQL | undefined;
  let locked = false;
  let runId: string | undefined;
  let browser: BrowserSession | undefined;
  let writeUnknown = false;
  let unsafeDatabase = false;
  const discovered = new Set<string>();
  const scheduled = new Set<string>();
  const handled = new Set<string>();
  const budgets: SavePostOptions["requestBudgets"] = new Map();
  const scheduler = createRequestScheduler({
    minSeconds: config.requestIntervalMinSeconds,
    maxSeconds: config.requestIntervalMaxSeconds,
  });
  const assertHeld = async () => {
    if (!session) throw new Error("未取得执行器会话。");
    try {
      await assertExecutorLock(session);
    } catch (error) {
      unsafeDatabase = true;
      throw error;
    }
  };
  const write = async <T>(operation: () => Promise<T>) => {
    writeUnknown = true;
    try {
      const value = await operation();
      writeUnknown = false;
      return value;
    } catch (error) {
      if (error instanceof KnownSaveFailure) writeUnknown = false;
      throw error;
    }
  };
  const connected = () => {
    if (browser && !browser.isConnected())
      throw new Error("Chrome Extension 连接已断开。");
  };
  const connect = async (connectSignal: AbortSignal) => {
    connected();
    browser ??= await (options.connect
      ? options.connect(connectSignal, scheduler.requestStarted)
      : connectBrowserSession(
          config.savedPageUrl,
          scheduler.requestStarted,
          connectSignal,
        ));
    connected();
    const activeBrowser = browser;
    return {
      ...activeBrowser,
      getFirstPage: async (requestSignal: AbortSignal) => {
        await assertHeld();
        connected();
        await scheduler.beforeRequest(requestSignal);
        await assertHeld();
        connected();
        if (requestSignal.aborted) throw new Error("读页已停止。");
        return activeBrowser.getFirstPage(requestSignal);
      },
      close: () => activeBrowser.closePage(),
    };
  };
  const stop = () => {
    if (!signal.aborted) return false;
    summary.endReason = "stopped";
    result.status = "cancelled";
    result.message = "Saved 批量归档已停止。";
    return true;
  };
  try {
    if (!stop()) {
      sql = connectDatabase(config);
      await verifySchema(sql);
      session = await sql.reserve({ signal });
      locked = await tryAcquireExecutorLock(session);
      if (!locked) throw new Error("已有归档执行正在运行。");
      await assertHeld();
      if (!stop()) {
        await interruptOrphanedRuns(session);
        await assertHeld();
        runId = crypto.randomUUID();
        const activeSession = session;
        await write(
          () =>
            activeSession`INSERT INTO runs (id, command, started_at) VALUES (${runId}::uuid, 'archive-saved', now())`,
        );
        while (!stop()) {
          await assertHeld();
          connected();
          options.onStage?.("读取 Saved 第一页");
          if (stop()) break;
          const pageResult = await inspectFirstPage({
            signal,
            secrets: [config.extensionToken, config.password],
            connect,
            waitBeforeRetry: async (requestSignal) => {
              await assertHeld();
              connected();
              await scheduler.beforeRequest(requestSignal);
              await assertHeld();
              connected();
            },
          });
          result.cleanupErrors.push(...pageResult.cleanupErrors);
          // The complete decoded page is adopted atomically.
          if (pageResult.status !== "ok") {
            summary.lastPage = "failed";
            summary.endReason =
              pageResult.status === "blocked" ? "blocked" : "page-failed";
            result.status =
              pageResult.status === "blocked" ? "blocked" : "failed";
            result.message = pageResult.message;
            if (pageResult.cleanupErrors.length) summary.endReason = "fault";
            stop();
            break;
          }
          const targets: string[] = [];
          for (const asset of pageResult.assets) {
            const id = normalizePostId(asset.assetId);
            if (!id) throw new Error("Saved 第一页包含非法 Post ID。");
            if (!targets.includes(id)) targets.push(id);
          }
          summary.lastPage = targets.length ? "nonempty" : "empty";
          for (const id of targets)
            if (!discovered.has(id)) {
              discovered.add(id);
              summary.discovered += 1;
              summary.unprocessed += 1;
            }
          if (pageResult.cleanupErrors.length) {
            summary.endReason = "fault";
            result.message = pageResult.message;
            break;
          }
          await assertHeld();
          connected();
          if (stop()) break;
          if (!targets.length) {
            summary.endReason = "completed";
            break;
          }
          summary.rounds += 1;
          summary.lastRoundComplete = false;
          let progress = false;
          let roundFinished = true;
          for (const id of targets) {
            if (stop()) {
              roundFinished = false;
              break;
            }
            await assertHeld();
            connected();
            if (scheduled.has(id)) continue;
            scheduled.add(id);
            summary.unprocessed -= 1;
            summary.unconfirmed += 1;
            const post = await archivePostInRun(
              config,
              id,
              runId,
              session,
              {
                goal: "archive",
                signal,
                onStage: options.onStage,
                connect,
                requestBudgets: budgets,
                waitBeforeRetry: async (requestSignal) => {
                  await assertHeld();
                  connected();
                  await scheduler.beforeRequest(requestSignal);
                  await assertHeld();
                  connected();
                },
              },
              write,
              () => {},
              (message) => result.cleanupErrors.push(message),
            );
            result.posts.push({ postId: id, goal: "archive", result: post });
            if (!post.unprocessed) handled.add(id);
            summary.unconfirmed -= 1;
            summary[classifyPostResult("archive", post)] += 1;
            if (post.newRemovalConfirmed) {
              progress = true;
              summary.newRemovals += 1;
            }
            result.cleanupErrors.push(...post.cleanupErrors);
            if (post.fatalExecution || writeUnknown) {
              unsafeDatabase = true;
              throw new Error(post.message);
            }
            if (post.cleanupErrors.length || result.cleanupErrors.length) {
              summary.endReason = "fault";
              result.message = post.message;
              roundFinished = false;
              break;
            }
            connected();
            if (post.status === "blocked") {
              summary.endReason = "blocked";
              result.status = "blocked";
              result.message = post.message;
              roundFinished = false;
              break;
            }
            if (post.status === "cancelled" || stop()) {
              summary.endReason = "stopped";
              result.status = "cancelled";
              roundFinished = false;
              break;
            }
          }
          summary.lastRoundComplete =
            roundFinished || targets.every((id) => handled.has(id));
          if (!roundFinished || stop()) break;
          await assertHeld();
          connected();
          if (!progress) {
            summary.endReason = "no-progress";
            result.message = "Saved 第一页无新确认移除，No Progress。";
            break;
          }
          options.onStage?.("等待下一轮（5 秒）");
          await waitBetweenRounds(signal);
        }
      }
    }
  } catch (error) {
    summary.endReason = signal.aborted ? "stopped" : "fault";
    result.status = signal.aborted ? "cancelled" : "failed";
    result.message = `Saved 批量归档${signal.aborted ? "已停止" : "故障"}：${safeSaveError(error, config)}`;
  }

  // No new observation or write is allowed after lost lock or uncertain Post writes.
  if (runId && session && !writeUnknown && !unsafeDatabase) {
    try {
      await assertHeld();
      options.onStage?.("核对全部遗留工作");
      try {
        const [leftovers] = await session<{ save: number; archive: number }[]>`
          SELECT count(*) FILTER (WHERE goal = 'save' AND status <> 'saved')::integer AS save,
            count(*) FILTER (WHERE goal = 'archive' AND NOT archive_settled)::integer AS archive FROM post_work`;
        if (!leftovers) throw new Error("遗留工作查询未返回结果。");
        summary.leftovers = leftovers;
      } catch (error) {
        summary.leftovers = null;
        summary.endReason = "fault";
        result.status = "failed";
        result.message = `遗留工作数量未知：${safeSaveError(error, config)}`;
      }
      await assertHeld();
      stop();
      if (summary.endReason === "completed") {
        summary.endReason =
          summary.leftovers &&
          (summary.leftovers.save || summary.leftovers.archive)
            ? "leftovers"
            : "completed";
        result.status = summary.endReason === "completed" ? "ok" : "failed";
        result.message =
          summary.endReason === "completed"
            ? "Saved 批量归档已完成。"
            : "Saved 第一页为空，但数据库仍有未完成工作。";
      }
      options.onStage?.("收尾 Run");
      stop();
      await assertHeld();
      result.summaryRecorded = null;
      const activeSession = session;
      await write(
        () =>
          activeSession`UPDATE runs SET finished_at = now(), outcome = ${result.status === "ok" ? "succeeded" : result.status === "cancelled" ? "stopped" : "failed"}, summary = ${summary}::jsonb WHERE id = ${runId}::uuid`,
      );
      result.summaryRecorded = true;
      options.onStage?.("Run 已收尾");
    } catch (error) {
      summary.endReason = signal.aborted ? "stopped" : "fault";
      result.status = signal.aborted ? "cancelled" : "failed";
      result.message = `${result.message} ${writeUnknown ? "Run 摘要提交结果未知" : "遗留核对或 Run 收尾失败"}：${safeSaveError(error, config)}`;
    }
  }
  const cleanup = async (
    label: string,
    operation: () => Promise<void> | void,
  ) => {
    try {
      await operation();
    } catch (error) {
      result.cleanupErrors.push(
        `${label}失败：${safeSaveError(error, config)}`,
      );
    }
  };
  if (browser) {
    const activeBrowser = browser;
    await cleanup("浏览器清理", () => activeBrowser.close());
    if (browser.cleanupNotices.length)
      result.message += ` ${browser.cleanupNotices.join(" ")}`;
  }
  if (session) {
    const activeSession = session;
    if (locked)
      await cleanup("执行器锁清理", () => releaseExecutorLock(activeSession));
    await cleanup("执行器连接释放", () => activeSession.release());
  }
  if (sql) {
    const activeSql = sql;
    await cleanup("数据库关闭", () => activeSql.close({ timeout: 5 }));
  }
  if (result.cleanupErrors.length && result.status !== "cancelled") {
    result.status = "failed";
    summary.endReason = "fault";
    result.message += " 资源清理失败。";
  }
  stop();
  return result;
}

function waitBetweenRounds(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("轮间等待已停止。"));
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new Error("轮间等待已停止。"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 5000);
    signal.addEventListener("abort", abort, { once: true });
  });
}
