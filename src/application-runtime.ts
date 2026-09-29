import { resolve } from "node:path";
import type { SQL } from "bun";
import {
  type InspectOptions,
  inspectFirstPage,
  inspectPost,
} from "./application";
import {
  archivePostInRun,
  type SavePostOptions,
  safeSaveError,
  savePost,
} from "./application-save-post";
import { type BrowserSession, connectBrowserSession } from "./browser/session";
import type {
  DatabaseConfig,
  InspectConfig,
  SaveConfig,
  VerifyConfig,
} from "./config";
import {
  classifyPostResult,
  emptyRunSummary,
  formatRunSummary,
  type RunSummary,
} from "./core/run-summary";
import { PublishConflictError } from "./files/publish-intent";
import { checkArchiveFile } from "./files/verify";
import { normalizePostId, RetryableRequestError } from "./grok/adapter";
import { createRequestScheduler } from "./grok/request-scheduler";
import { connectDatabase, safeDatabaseError } from "./store/database";
import {
  assertExecutorLock,
  releaseExecutorLock,
  tryAcquireExecutorLock,
} from "./store/executor";
import { KnownSaveConflict, KnownSaveFailure } from "./store/save-work";
import { initializeSchema, verifySchema } from "./store/schema";

export type DatabaseResult = {
  status: "ok" | "failed";
  message: string;
  cleanupErrors: string[];
};

export type ProjectStatusResult = DatabaseResult & {
  latestRun: {
    command: string;
    startedAt: string;
    finishedAt: string | null;
    outcome: string | null;
    summary: Record<string, unknown> | null;
  } | null;
  unfinishedPosts: {
    postId: string;
    goal: "save" | "archive";
    status: string;
    removalState: "none" | "pending" | "removed";
    archiveSettled: boolean;
    lastError: string | null;
  }[];
};

export type VerifyResult = {
  status: "ok" | "failed";
  message: string;
  cleanupErrors: string[];
  versionId?: string;
  filePath?: string;
  fileStatus?:
    | "ok"
    | "missing"
    | "directory"
    | "symlink"
    | "mismatch"
    | "failed";
  archiveSettled?: boolean;
};

export type RetryResult = Omit<DatabaseResult, "status"> & {
  status: "ok" | "failed" | "cancelled" | "invalid";
  summary?: RunSummary | null;
  summaryRecorded?: boolean | null;
  posts?: {
    postId: string;
    goal: "save" | "archive";
    result: Awaited<ReturnType<typeof archivePostInRun>>;
  }[];
};

export type DatabaseCloser = (
  sql: SQL,
  timeoutSeconds: number,
) => Promise<void>;

const closeDatabase: DatabaseCloser = (sql, timeoutSeconds) =>
  sql.close({ timeout: timeoutSeconds });

export function initializeProjectDatabase(
  config: DatabaseConfig,
  close: DatabaseCloser = closeDatabase,
): Promise<DatabaseResult> {
  return withDatabase(
    config,
    async (sql) => {
      await initializeSchema(sql);
      return "数据库结构已初始化。";
    },
    close,
  );
}

export function checkProjectDatabase(
  config: DatabaseConfig,
  close: DatabaseCloser = closeDatabase,
): Promise<DatabaseResult> {
  return withDatabase(
    config,
    async (sql) => {
      await verifySchema(sql);
      return "数据库结构与当前版本一致。";
    },
    close,
  );
}

export function readProjectStatus(
  config: DatabaseConfig,
  close: DatabaseCloser = closeDatabase,
): Promise<ProjectStatusResult> {
  return withStatusDatabase(config, close);
}

export function retryUnfinishedPosts(
  config: DatabaseConfig,
  close: DatabaseCloser = closeDatabase,
  signal?: AbortSignal,
  prepareSave?: () => SaveConfig,
  connect?: SavePostOptions["connect"],
  onStage?: SavePostOptions["onStage"],
): Promise<RetryResult> {
  return runBatch(
    "retry",
    config,
    close,
    signal,
    prepareSave,
    connect,
    onStage,
  );
}

export function saveFirstPage(
  config: DatabaseConfig,
  close: DatabaseCloser = closeDatabase,
  signal?: AbortSignal,
  prepareSave?: () => SaveConfig,
  connect?: SavePostOptions["connect"],
  onStage?: SavePostOptions["onStage"],
  connectPage?: InspectOptions["connect"],
): Promise<RetryResult> {
  return runBatch(
    "save-first-page",
    config,
    close,
    signal,
    prepareSave,
    connect,
    onStage,
    connectPage,
  );
}

async function runBatch(
  command: "retry" | "save-first-page",
  config: DatabaseConfig,
  close: DatabaseCloser,
  signal?: AbortSignal,
  prepareSave?: () => SaveConfig,
  connect?: SavePostOptions["connect"],
  onStage?: SavePostOptions["onStage"],
  connectPage?: InspectOptions["connect"],
): Promise<RetryResult> {
  const label = command === "retry" ? "重试" : "单页保存";
  let sql: ReturnType<typeof connectDatabase> | undefined;
  let session:
    | Awaited<ReturnType<NonNullable<typeof sql>["reserve"]>>
    | undefined;
  let lockAcquired = false;
  let runId: string | undefined;
  let runCreated = false;
  let runTerminalWriteAcknowledged = false;
  let runWriteUnknown = false;
  let summaryRecorded: boolean | null = false;
  let invalidConfig = false;
  let fatalExecution = false;
  let saveConfig: SaveConfig | undefined;
  let runBrowserSession: BrowserSession | undefined;
  const counts = emptyRunSummary();
  let countsKnown = false;
  const postErrors: string[] = [];
  const posts: NonNullable<RetryResult["posts"]> = [];
  let result: RetryResult = {
    status: "failed",
    message: `${label}执行失败。`,
    cleanupErrors: [],
  };

  try {
    if (command === "save-first-page" && !signal?.aborted) {
      try {
        saveConfig = prepareSave?.();
        if (!saveConfig) throw new Error(`${label}缺少保存配置。`);
      } catch (error) {
        invalidConfig = true;
        throw error;
      }
    }
    if (signal?.aborted) {
      result = {
        status: "cancelled",
        message: runWriteUnknown
          ? `${label}已停止；Run 写入结果未知，未确认记账。`
          : `${label}已停止。`,
        cleanupErrors: [],
      };
      return result;
    }
    sql = connectDatabase(config);
    await verifySchema(sql);
    if (signal?.aborted) {
      result = {
        status: "cancelled",
        message: runWriteUnknown
          ? `${label}已停止；Run 写入结果未知，未确认记账。`
          : `${label}已停止。`,
        cleanupErrors: [],
      };
    } else {
      session = await sql.reserve(signal ? { signal } : undefined);
    }
    if (signal?.aborted) {
      result = {
        status: "cancelled",
        message: runWriteUnknown
          ? `${label}已停止；Run 写入结果未知，未确认记账。`
          : `${label}已停止。`,
        cleanupErrors: [],
      };
    }
    if (!session) throw new Error("未能取得执行器数据库会话。");
    lockAcquired = await tryAcquireExecutorLock(session);
    if (signal?.aborted) {
      result = {
        status: "cancelled",
        message: `${label}已停止。`,
        cleanupErrors: [],
      };
    } else if (!lockAcquired) {
      result.message = "已有保存执行正在运行。";
    } else {
      await assertExecutorLock(session);
      if (signal?.aborted) {
        result = {
          status: "cancelled",
          message: `${label}已停止。`,
          cleanupErrors: [],
        };
      } else {
        await session`
          UPDATE runs
          SET outcome = 'interrupted'
          WHERE finished_at IS NULL
        `;
        await assertExecutorLock(session);
        if (signal?.aborted) {
          result = {
            status: "cancelled",
            message: `${label}已停止。`,
            cleanupErrors: [],
          };
        } else {
          let targets =
            command === "retry"
              ? await session<{ postId: string; goal: "save" | "archive" }[]>`
            SELECT post_id AS "postId", goal FROM post_work
            WHERE (goal = 'save' AND status IN ('pending', 'finalizing', 'failed'))
              OR (goal = 'archive' AND NOT archive_settled)
            ORDER BY post_id
          `
              : [];
          if (command === "retry") {
            counts.unprocessed = targets.length;
            countsKnown = true;
          }
          await assertExecutorLock(session);
          if (command === "retry" && targets.length) {
            try {
              saveConfig = prepareSave?.();
              if (!saveConfig) throw new Error(`${label}缺少保存配置。`);
            } catch (error) {
              invalidConfig = true;
              throw error;
            }
          }
          runId = crypto.randomUUID();
          runWriteUnknown = true;
          const inserted = await session<{ id: string }[]>`
            INSERT INTO runs (id, command, started_at)
            VALUES (${runId}::uuid, ${command}, now())
            RETURNING id::text AS id
          `;
          runCreated = inserted.length === 1 && inserted[0]?.id === runId;
          runWriteUnknown = false;
          if (!runCreated) throw new Error("Run 创建结果未确认。");
          await assertExecutorLock(session);
          const scheduler = createRequestScheduler({
            minSeconds: saveConfig?.requestIntervalMinSeconds ?? 0,
            maxSeconds: saveConfig?.requestIntervalMaxSeconds ?? 0,
          });
          const requestBudgets: SavePostOptions["requestBudgets"] = new Map();
          const connectRunSession = async (connectSignal: AbortSignal) => {
            if (!saveConfig) throw new Error(`${label}缺少保存配置。`);
            runBrowserSession ??= await connectBrowserSession(
              saveConfig.savedPageUrl,
              scheduler.requestStarted,
              connectSignal,
            );
            const browser = runBrowserSession;
            if (!browser.isConnected())
              throw new Error("Chrome Extension 连接已断开。");
            return {
              getFirstPage: (requestSignal: AbortSignal) =>
                browser.getFirstPage(requestSignal),
              getPostDetail: (postId: string, requestSignal: AbortSignal) =>
                browser.getPostDetail(postId, requestSignal),
              checkPost: browser.checkPost,
              deletePost: browser.deletePost,
              prepareMediaPage: browser.prepareMediaPage,
              downloadMedia: browser.downloadMedia,
              close: () => browser.closePage(),
            };
          };

          if (signal?.aborted) {
            const stopped = await finishStoppedRun(
              session,
              runId,
              countsKnown ? counts : null,
              (unknown, finished) => {
                runWriteUnknown = unknown;
                if (finished) {
                  runTerminalWriteAcknowledged = true;
                  summaryRecorded = true;
                } else if (unknown) summaryRecorded = null;
              },
            );
            result = stopped
              ? {
                  status: "cancelled",
                  message: `${label}已停止。Run 已记录停止结果。`,
                  cleanupErrors: [],
                }
              : {
                  status: "cancelled",
                  message: `${label}已停止；Run 未记录停止结果。`,
                  cleanupErrors: [],
                };
          } else {
            if (signal?.aborted) {
              const stopped = await finishStoppedRun(
                session,
                runId,
                countsKnown ? counts : null,
                (unknown, finished) => {
                  runWriteUnknown = unknown;
                  if (finished) {
                    runTerminalWriteAcknowledged = true;
                    summaryRecorded = true;
                  } else if (unknown) summaryRecorded = null;
                },
              );
              result = stopped
                ? {
                    status: "cancelled",
                    message: `${label}已停止。Run 已记录停止结果。`,
                    cleanupErrors: [],
                  }
                : {
                    status: "cancelled",
                    message: `${label}已停止；Run 未记录停止结果。`,
                    cleanupErrors: [],
                  };
            } else {
              let stopReason = "";
              if (command === "save-first-page" && !signal?.aborted) {
                if (!saveConfig) throw new Error("单页保存缺少保存配置。");
                onStage?.("读取 Saved 第一页");
                const page = await inspectFirstPage({
                  signal,
                  secrets: [saveConfig.extensionToken, config.password],
                  waitBeforeRetry: scheduler.beforeRequest,
                  connect: connectPage ?? connectRunSession,
                });
                if (page.status === "ok") {
                  targets = page.assets.map((asset) => ({
                    postId: asset.assetId,
                    goal: "save" as const,
                  }));
                  counts.unprocessed = targets.length;
                  countsKnown = true;
                } else {
                  stopReason = page.message;
                }
                result.cleanupErrors.push(...page.cleanupErrors);
                if (page.cleanupErrors.length)
                  stopReason =
                    `${stopReason} ${page.cleanupErrors.join(" ")}`.trim();
              }
              if (targets.length && !stopReason && !signal?.aborted) {
                if (!saveConfig) throw new Error(`${label}缺少保存配置。`);
                for (const target of targets) {
                  if (signal?.aborted) break;
                  await assertExecutorLock(session);
                  counts.unprocessed -= 1;
                  counts.unconfirmed += 1;
                  let browserResult: Awaited<
                    ReturnType<typeof archivePostInRun>
                  >;
                  try {
                    browserResult = await archivePostInRun(
                      saveConfig,
                      target.postId,
                      runId,
                      session,
                      {
                        signal,
                        goal: target.goal,
                        requestBudgets,
                        onStage,
                        waitBeforeRetry: scheduler.beforeRequest,
                        connect: connect ?? connectRunSession,
                      },
                      async (operation) => {
                        runWriteUnknown = true;
                        try {
                          const value = await operation();
                          runWriteUnknown = false;
                          return value;
                        } catch (error) {
                          if (error instanceof KnownSaveFailure)
                            runWriteUnknown = false;
                          throw error;
                        }
                      },
                      () => undefined,
                      (message) => result.cleanupErrors.push(message),
                    );
                  } catch (error) {
                    if (runWriteUnknown) throw error;
                    if (
                      error instanceof RetryableRequestError ||
                      error instanceof PublishConflictError ||
                      error instanceof KnownSaveConflict
                    ) {
                      postErrors.push(
                        `Post ${target.postId} 失败：${safeSaveError(error, saveConfig)}`,
                      );
                      if (!signal?.aborted && result.cleanupErrors.length === 0)
                        continue;
                    }
                    stopReason = [
                      safeSaveError(error, saveConfig),
                      ...result.cleanupErrors,
                    ].join(" ");
                    break;
                  }
                  posts.push({ ...target, result: browserResult });
                  counts.unconfirmed -= 1;
                  counts[classifyPostResult(target.goal, browserResult)] += 1;
                  postErrors.push(
                    `Post ${target.postId}：${browserResult.message}`,
                  );
                  if (browserResult.fatalExecution) {
                    fatalExecution = true;
                    result.cleanupErrors.push(...browserResult.cleanupErrors);
                    throw new Error(browserResult.message);
                  }
                  if (browserResult.unprocessed || browserResult.alreadySettled)
                    continue;
                  if (browserResult.cleanupErrors.length) {
                    result.cleanupErrors.push(...browserResult.cleanupErrors);
                    stopReason = browserResult.cleanupErrors.join(" ");
                    break;
                  }
                  if (runBrowserSession && !runBrowserSession.isConnected()) {
                    stopReason = "Chrome Extension 连接已断开。";
                    break;
                  }
                  if (
                    browserResult.status === "blocked" ||
                    browserResult.status === "cancelled"
                  ) {
                    break;
                  }
                }
              }
              await assertExecutorLock(session);
              runWriteUnknown = true;
              summaryRecorded = null;
              const updated = await session<{ id: string }[]>`
                UPDATE runs SET finished_at = now(),
                  outcome = ${signal?.aborted ? "stopped" : counts.unconfirmed || counts.unprocessed || stopReason ? "failed" : "succeeded"},
                  summary = ${countsKnown ? counts : null}::jsonb
                WHERE id = ${runId}::uuid
                RETURNING id::text AS id
              `;
              runWriteUnknown = false;
              runTerminalWriteAcknowledged = true;
              summaryRecorded = true;
              if (updated.length !== 1) throw new Error("Run 结果未记录。");
              await assertExecutorLock(session);
              result = signal?.aborted
                ? {
                    status: "cancelled",
                    message: "收到停止信号；Run 已正常收尾。",
                    cleanupErrors: result.cleanupErrors,
                  }
                : {
                    status:
                      counts.unconfirmed || counts.unprocessed || stopReason
                        ? "failed"
                        : "ok",
                    message:
                      `${command === "retry" ? (targets.length ? "重试结束。" : "没有未完成 Post，重试 Run 已正常结束。") : "Saved 第一页处理结束。"} ${[...postErrors, stopReason].filter(Boolean).join(" ")}`.trim(),
                    cleanupErrors: result.cleanupErrors,
                  };
            }
          }
        }
      }
    }
  } catch (error) {
    if (invalidConfig && !signal?.aborted) {
      result.status = "invalid";
      result.message = `配置无效：${safeDatabaseError(error, config)}`;
    } else if (signal?.aborted) {
      result = {
        status: "cancelled",
        message: runWriteUnknown
          ? `${label}已停止；Run 写入结果未知，未确认记账。`
          : `${label}已停止。`,
        cleanupErrors: result.cleanupErrors,
      };
      if (
        runId &&
        runCreated &&
        !runTerminalWriteAcknowledged &&
        !runWriteUnknown &&
        !fatalExecution &&
        session
      ) {
        try {
          const stopped = await finishStoppedRun(
            session,
            runId,
            countsKnown ? counts : null,
            (unknown, finished) => {
              runWriteUnknown = unknown;
              if (finished) {
                runTerminalWriteAcknowledged = true;
                summaryRecorded = true;
              } else if (unknown) summaryRecorded = null;
            },
          );
          result.message = stopped
            ? `${label}已停止。Run 已记录停止结果。`
            : `${label}已停止；Run 未记录停止结果。`;
        } catch (stopError) {
          result.cleanupErrors.push(
            `停止 Run 收尾失败：${safeDatabaseError(stopError, config)}`,
          );
        }
      }
    } else {
      result.message = runWriteUnknown
        ? `${label}结果未知；未确认 Run 记账：${safeDatabaseError(error, config)}`
        : `${label}执行失败：${safeDatabaseError(error, config)}`;
    }
    if (
      !signal?.aborted &&
      runId &&
      runCreated &&
      !runTerminalWriteAcknowledged &&
      !runWriteUnknown &&
      !fatalExecution &&
      session
    ) {
      try {
        await assertExecutorLock(session);
        runWriteUnknown = true;
        summaryRecorded = null;
        await session`
          UPDATE runs
          SET finished_at = now(), outcome = 'failed', summary = ${countsKnown ? counts : null}::jsonb
          WHERE id = ${runId}::uuid AND finished_at IS NULL
        `;
        runWriteUnknown = false;
        runTerminalWriteAcknowledged = true;
        summaryRecorded = true;
      } catch {
        // A failed or unknown commit must not be followed by another Run write.
      }
    }
  }

  if (
    postErrors.length &&
    !postErrors.every((message) => result.message.includes(message))
  )
    result.message = `${result.message} ${postErrors.join(" ")}`;

  if (runBrowserSession) {
    try {
      await runBrowserSession.close();
    } catch (error) {
      const detail = `浏览器清理失败：${saveConfig ? safeSaveError(error, saveConfig) : safeDatabaseError(error, config)}`;
      result.cleanupErrors.push(detail);
      if (result.status === "ok")
        result.message = `${result.message} ${label} Run 已记录，但${detail}`;
      if (result.status !== "cancelled") result.status = "failed";
    }
    if (runBrowserSession.cleanupNotices.length)
      result.message = `${result.message} ${runBrowserSession.cleanupNotices.join(" ")}`;
  }
  if (session) {
    if (lockAcquired) {
      try {
        await releaseExecutorLock(session);
      } catch (error) {
        result.cleanupErrors.push(
          `执行器锁清理失败：${safeDatabaseError(error, config)}`,
        );
        if (result.status === "ok")
          result.message = `${result.message} ${label} Run 已记录，但执行器锁清理失败。`;
        if (result.status !== "cancelled") result.status = "failed";
      }
    }
    try {
      session.release();
    } catch (error) {
      result.cleanupErrors.push(
        `执行器连接释放失败：${safeDatabaseError(error, config)}`,
      );
      if (result.status === "ok")
        result.message = `${result.message} ${label} Run 已记录，但执行器连接释放失败。`;
      if (result.status !== "cancelled") result.status = "failed";
    }
  }
  if (sql) {
    try {
      await close(sql, 5);
    } catch (error) {
      result.cleanupErrors.push(
        `数据库关闭失败：${safeDatabaseError(error, config)}`,
      );
      if (result.status === "ok")
        result.message = `${result.message} ${label} Run 已记录，但数据库连接关闭失败。`;
      if (result.status !== "cancelled") result.status = "failed";
    }
  }
  if (signal?.aborted) {
    result.status = "cancelled";
    if (!result.message.includes("停止"))
      result.message = `${result.message} 收到停止信号；Run 已完成必要收尾。`;
  }
  result.posts = posts;
  result.summary = countsKnown ? counts : null;
  result.summaryRecorded = summaryRecorded;
  result.message = countsKnown
    ? `${result.message} ${formatRunSummary(counts)}。`
    : `${result.message} Run 摘要数量未知。`;
  result.message = `${result.message} ${result.summaryRecorded === true ? "Run 摘要已持久记录。" : result.summaryRecorded === null ? "Run 摘要提交结果未知。" : "Run 摘要未记录。"}`;
  return result;
}

async function finishStoppedRun(
  session: Awaited<
    ReturnType<NonNullable<ReturnType<typeof connectDatabase>>["reserve"]>
  >,
  runId: string,
  counts: RunSummary | null,
  writeState: (unknown: boolean, acknowledged?: boolean) => void,
): Promise<boolean> {
  await assertExecutorLock(session);
  writeState(true);
  const updated = await session<{ id: string }[]>`
    UPDATE runs SET finished_at = now(), outcome = 'stopped',
      summary = ${counts}::jsonb
    WHERE id = ${runId}::uuid AND finished_at IS NULL
    RETURNING id::text AS id
  `;
  writeState(false, true);
  await assertExecutorLock(session);
  return updated.length === 1;
}

export async function verifySavedPost(
  config: VerifyConfig,
  postId: string,
  close: DatabaseCloser = closeDatabase,
): Promise<VerifyResult> {
  let sql: ReturnType<typeof connectDatabase> | undefined;
  let result: VerifyResult = {
    status: "failed",
    message: "文件核验失败。",
    cleanupErrors: [],
  };
  try {
    sql = connectDatabase(config);
    await verifySchema(sql);
    const [saved] = await sql<
      {
        relativePath: string | null;
        byteCount: string | null;
        sha256: string | null;
        versionId: string | null;
        deletionVersionId: string | null;
        archiveSettled: boolean;
      }[]
    >`
      SELECT m.relative_path AS "relativePath", m.byte_count::text AS "byteCount",
        m.sha256, m.id::text AS "versionId",
        w.deletion_media_version_id::text AS "deletionVersionId",
        w.archive_settled AS "archiveSettled"
      FROM post_work w
      LEFT JOIN media_versions m ON m.post_id = w.post_id
        AND m.id = COALESCE(w.deletion_media_version_id, w.saved_media_version_id)
      WHERE w.post_id = ${postId}
    `;
    if (!saved) {
      result.message = `Post ${postId} 没有可核验的保存记录。`;
    } else if (saved.deletionVersionId && !saved.versionId) {
      result = {
        status: "failed",
        message: `Post ${postId} 的删除依据版本绑定异常，无法核验。`,
        cleanupErrors: [],
        archiveSettled: saved.archiveSettled,
      };
    } else if (
      !saved.versionId ||
      !saved.relativePath ||
      !saved.byteCount ||
      !saved.sha256
    ) {
      result = {
        status: "failed",
        message: `Post ${postId} 没有可核验的保存记录。`,
        cleanupErrors: [],
        archiveSettled: saved.archiveSettled,
      };
    } else {
      const check = await checkArchiveFile(
        config.archiveRoot,
        saved.relativePath,
        Number(saved.byteCount),
        saved.sha256,
      );
      const detail: Record<string, string> = {
        missing: "保存文件缺失。",
        directory: "保存路径是目录。",
        symlink: "保存路径是符号链接。",
        mismatch: "文件大小或 SHA-256 与保存记录不符。",
      };
      const filePath = resolve(config.archiveRoot, saved.relativePath);
      const history = saved.archiveSettled ? "数据库已记录归档结清。" : "";
      const currentResult =
        check.status === "ok"
          ? "当前文件核验通过。"
          : `当前文件核验异常：${check.status === "failed" ? check.reason : detail[check.status]}`;
      const settledText = history ? `${history} ` : "";
      const message = `Post ${postId} 核验版本 ${saved.versionId}；当前位置 ${filePath}。${settledText}${currentResult}`;
      result =
        check.status === "ok"
          ? {
              status: "ok",
              message,
              cleanupErrors: [],
              versionId: saved.versionId,
              filePath,
              fileStatus: "ok",
              archiveSettled: saved.archiveSettled,
            }
          : {
              status: "failed",
              message,
              cleanupErrors: [],
              versionId: saved.versionId,
              filePath,
              fileStatus: check.status,
              archiveSettled: saved.archiveSettled,
            };
    }
  } catch (error) {
    result.message = `文件核验失败：${safeDatabaseError(error, config)}.`;
  }
  if (sql) {
    try {
      await close(sql, 5);
    } catch (error) {
      result.cleanupErrors.push(
        `数据库关闭失败：${safeDatabaseError(error, config)}`,
      );
      result.status = "failed";
    }
  }
  return result;
}

async function withStatusDatabase(
  config: DatabaseConfig,
  close: DatabaseCloser,
): Promise<ProjectStatusResult> {
  let sql: ReturnType<typeof connectDatabase> | undefined;
  let result: ProjectStatusResult = {
    status: "failed",
    message: "状态查询失败。",
    cleanupErrors: [],
    latestRun: null,
    unfinishedPosts: [],
  };
  try {
    sql = connectDatabase(config);
    await verifySchema(sql);
    const [latestRun] = await sql<ProjectStatusResult["latestRun"][]>`
      SELECT command, started_at::text AS "startedAt",
        finished_at::text AS "finishedAt", outcome, summary
      FROM runs
      ORDER BY started_at DESC, id DESC
      LIMIT 1
    `;
    const unfinishedPosts = await sql<ProjectStatusResult["unfinishedPosts"]>`
      SELECT post_id AS "postId", goal, status,
        removal_state AS "removalState", archive_settled AS "archiveSettled",
        last_error AS "lastError"
      FROM post_work
      WHERE (goal = 'save' AND status <> 'saved')
        OR (goal = 'archive' AND NOT archive_settled)
      ORDER BY post_id
    `;
    result = {
      status: "ok",
      message: "状态查询完成。",
      cleanupErrors: [],
      latestRun: latestRun ?? null,
      unfinishedPosts,
    };
  } catch (error) {
    result.message = `状态查询失败：${safeDatabaseError(error, config)}`;
  }
  if (sql) {
    try {
      await close(sql, 5);
    } catch (error) {
      const detail = safeDatabaseError(error, config);
      result.cleanupErrors.push(`数据库关闭失败：${detail}`);
      if (result.status === "ok")
        result.message = "状态查询已完成，但数据库连接关闭失败。";
      result.status = "failed";
    }
  }
  return result;
}

async function withDatabase(
  config: DatabaseConfig,
  operation: (sql: ReturnType<typeof connectDatabase>) => Promise<string>,
  close: DatabaseCloser,
): Promise<DatabaseResult> {
  let sql: ReturnType<typeof connectDatabase> | undefined;
  let result: DatabaseResult = {
    status: "failed",
    message: "数据库操作失败。",
    cleanupErrors: [],
  };
  try {
    sql = connectDatabase(config);
    const message = await operation(sql);
    result = { status: "ok", message, cleanupErrors: [] };
  } catch (error) {
    result = {
      status: "failed",
      message: `数据库操作失败：${safeDatabaseError(error, config)}`,
      cleanupErrors: [],
    };
  }
  if (sql) {
    try {
      await close(sql, 5);
    } catch (error) {
      const detail = safeDatabaseError(error, config);
      result.cleanupErrors.push(`数据库关闭失败：${detail}`);
      if (result.status === "ok")
        result.message = "数据库操作已完成，但连接关闭失败。";
      result.status = "failed";
    }
  }
  return result;
}

export async function inspectSavedFirstPage(
  config: InspectConfig,
  signal: AbortSignal,
) {
  const scheduler = createRequestScheduler({
    minSeconds: config.requestIntervalMinSeconds,
    maxSeconds: config.requestIntervalMaxSeconds,
  });
  return inspectFirstPage({
    signal,
    secrets: [config.extensionToken],
    connect: (connectSignal) =>
      connectBrowserSession(
        config.savedPageUrl,
        scheduler.requestStarted,
        connectSignal,
      ),
    waitBeforeRetry: scheduler.beforeRequest,
  });
}

export async function inspectSavedPost(
  config: InspectConfig,
  assetId: string,
  signal: AbortSignal,
) {
  const scheduler = createRequestScheduler({
    minSeconds: config.requestIntervalMinSeconds,
    maxSeconds: config.requestIntervalMaxSeconds,
  });
  return inspectPost(assetId, {
    signal,
    secrets: [config.extensionToken],
    connect: (connectSignal) =>
      connectBrowserSession(
        config.savedPageUrl,
        scheduler.requestStarted,
        connectSignal,
      ),
    waitBeforeRetry: scheduler.beforeRequest,
  });
}

export async function saveSelectedPost(
  config: SaveConfig,
  postId: string,
  signal: AbortSignal,
  onStage?: (stage: string) => void,
  connect?: SavePostOptions["connect"],
) {
  const scheduler = createRequestScheduler({
    minSeconds: config.requestIntervalMinSeconds,
    maxSeconds: config.requestIntervalMaxSeconds,
  });
  return savePost(config, postId, {
    signal,
    onStage,
    waitBeforeRetry: scheduler.beforeRequest,
    connect:
      connect ??
      ((connectSignal) =>
        connectBrowserSession(
          config.savedPageUrl,
          scheduler.requestStarted,
          connectSignal,
        )),
  });
}

export async function archiveSelectedPost(
  config: SaveConfig,
  postId: string,
  signal: AbortSignal,
  onStage?: (stage: string) => void,
  connect?: SavePostOptions["connect"],
) {
  const normalized = normalizePostId(postId);
  if (!normalized)
    return {
      status: "failed" as const,
      message: "Post ID 必须是带连字符的 UUID。",
      saveRecorded: false,
      cleanupErrors: [],
      newRemovalConfirmed: false,
    };
  const scheduler = createRequestScheduler({
    minSeconds: config.requestIntervalMinSeconds,
    maxSeconds: config.requestIntervalMaxSeconds,
  });
  return savePost(config, normalized, {
    goal: "archive",
    signal,
    onStage,
    waitBeforeRetry: scheduler.beforeRequest,
    connect:
      connect ??
      ((connectSignal) =>
        connectBrowserSession(
          config.savedPageUrl,
          scheduler.requestStarted,
          connectSignal,
        )),
  });
}

export {
  type ArchiveSavedOptions,
  type ArchiveSavedResult,
  archiveSaved,
} from "./application-archive-saved";
