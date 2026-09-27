import type { ReservedSQL } from "bun";
import type { SaveConfig } from "./config";
import { archivePost } from "./core/post-archiver";
import type { PostResponse } from "./grok/adapter";
import { connectDatabase, safeDatabaseError } from "./store/database";
import {
  assertExecutorLock,
  releaseExecutorLock,
  tryAcquireExecutorLock,
} from "./store/executor";
import {
  failSaveRun,
  finishSaveRun,
  interruptOrphanedRuns,
  startSaveRun,
} from "./store/save-run";
import {
  clearMissingIntent,
  failUnreadableDetail,
  KnownSaveFailure,
  markFileNotReusable,
  markNeedsDownload,
  readSavedVersion,
  readWork,
  settleIntent,
  startWork,
} from "./store/save-work";
import { verifySchema } from "./store/schema";

export type SavePostSession = {
  getPostDetail(postId: string, signal: AbortSignal): Promise<PostResponse>;
  close(): Promise<void>;
  cleanupNotices?: string[];
};

export type SavePostOptions = {
  connect(signal: AbortSignal): Promise<SavePostSession>;
  waitBeforeRetry: (signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  onStage?: (stage: string) => void;
};

export type SavePostResult = {
  status: "ok" | "blocked" | "failed" | "cancelled";
  message: string;
  // true: a saved fact for this Post was observed or committed; null: DB write outcome unknown.
  saveRecorded: boolean | null;
  cleanupErrors: string[];
};

function safeSaveError(error: unknown, config: SaveConfig): string {
  let message = safeDatabaseError(error, config);
  for (const secret of [
    config.extensionToken,
    encodeURIComponent(config.extensionToken),
  ]) {
    if (secret) message = message.replaceAll(secret, "[已隐藏]");
  }
  return message.replace(/([?&](?:token|auth|key)=)[^&\s]+/gi, "$1[已隐藏]");
}

export async function savePost(
  config: SaveConfig,
  postId: string,
  options: SavePostOptions,
): Promise<SavePostResult> {
  const signal = options.signal ?? new AbortController().signal;
  let sql: ReturnType<typeof connectDatabase> | undefined;
  let session: ReservedSQL | undefined;
  let browser: SavePostSession | undefined;
  let lockAcquired = false;
  let runId: string | undefined;
  let runWriteUnknown = false;
  const result: SavePostResult = {
    status: "failed",
    message: "Post 保存未完成。",
    saveRecorded: false,
    cleanupErrors: [],
  };
  const reportStopAfterSave = () => {
    if (signal.aborted && result.status === "ok") {
      result.status = "cancelled";
      result.message = "保存已停止；Post 已保存。";
    }
  };
  const write = async <T>(operation: () => Promise<T>): Promise<T> => {
    runWriteUnknown = true;
    try {
      const value = await operation();
      runWriteUnknown = false;
      return value;
    } catch (error) {
      if (error instanceof KnownSaveFailure) runWriteUnknown = false;
      throw error;
    }
  };
  try {
    if (signal.aborted)
      return { ...result, status: "cancelled", message: "保存已停止。" };
    sql = connectDatabase(config);
    await verifySchema(sql);
    session = await sql.reserve();
    lockAcquired = await tryAcquireExecutorLock(session);
    if (!lockAcquired) throw new Error("已有保存执行正在运行。");
    await assertExecutorLock(session);
    await interruptOrphanedRuns(session);
    runId = crypto.randomUUID();
    runWriteUnknown = true;
    await startSaveRun(session, runId, postId);
    runWriteUnknown = false;
    await assertExecutorLock(session);
    if (signal.aborted) throw new Error("保存已停止。");
    const activeSession = session;
    const postResult = await archivePost({
      postId,
      archiveRoot: config.archiveRoot,
      signal,
      onStage: options.onStage,
      store: {
        readWork: async (id) => {
          const work = await readWork(activeSession, id);
          if (work?.status === "saved") result.saveRecorded = true;
          return work;
        },
        startWork: (id, run) => write(() => startWork(activeSession, id, run)),
        clearMissingIntent: (id, work, run) =>
          write(() => clearMissingIntent(activeSession, id, work, run)),
        settleIntent: async (id, work, run) => {
          await write(() => settleIntent(activeSession, id, work, run));
          result.saveRecorded = true;
        },
        failUnreadableDetail: (id, run) =>
          write(() => failUnreadableDetail(activeSession, id, run)),
        readSavedVersion: (id, version) =>
          readSavedVersion(activeSession, id, version),
        markFileNotReusable: (id, run) =>
          write(() => markFileNotReusable(activeSession, id, run)),
        markNeedsDownload: (id, run, selection) =>
          write(() => markNeedsDownload(activeSession, id, run, selection)),
        assertLock: () => assertExecutorLock(activeSession),
      },
      getDetail: async (detailSignal) => {
        browser ??= await options.connect(detailSignal);
        return browser.getPostDetail(postId, detailSignal);
      },
      waitBeforeRetry: options.waitBeforeRetry,
      runId,
    });
    Object.assign(result, postResult);
    if (runId) {
      options.onStage?.("核对收尾执行器锁");
      await assertExecutorLock(session);
      options.onStage?.("收尾 Run");
      reportStopAfterSave();
      runWriteUnknown = true;
      await finishSaveRun(session, runId, result.status);
      runWriteUnknown = false;
      options.onStage?.("Run 已收尾");
    }
  } catch (error) {
    if (error instanceof KnownSaveFailure) runWriteUnknown = false;
    if (runWriteUnknown && result.saveRecorded === false)
      result.saveRecorded = null;
    result.status = signal.aborted && !runWriteUnknown ? "cancelled" : "failed";
    result.message = runWriteUnknown
      ? `数据库提交结果未知，已停止：${safeSaveError(error, config)}`
      : `保存失败：${safeSaveError(error, config)}`;
    if (runId && session && !runWriteUnknown) {
      try {
        await assertExecutorLock(session);
        runWriteUnknown = true;
        await failSaveRun(session, runId, signal.aborted);
        runWriteUnknown = false;
      } catch {
        result.message = `${result.message} Run 收尾结果未知。`;
      }
    }
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        result.cleanupErrors.push(
          `浏览器清理失败：${safeSaveError(error, config)}`,
        );
      }
      if (browser.cleanupNotices?.length)
        result.cleanupErrors.push(...browser.cleanupNotices);
    }
    if (session) {
      if (lockAcquired) {
        try {
          await releaseExecutorLock(session);
        } catch (error) {
          result.cleanupErrors.push(
            `执行器锁清理失败：${safeSaveError(error, config)}`,
          );
        }
      }
      try {
        session.release();
      } catch (error) {
        result.cleanupErrors.push(
          `执行器连接释放失败：${safeSaveError(error, config)}`,
        );
      }
    }
    if (sql) {
      try {
        await sql.close({ timeout: 5 });
      } catch (error) {
        result.cleanupErrors.push(
          `数据库关闭失败：${safeSaveError(error, config)}`,
        );
      }
    }
    reportStopAfterSave();
    if (result.cleanupErrors.length && result.status === "ok") {
      result.status = "failed";
      result.message = "Post 已保存，但资源清理失败。";
    }
  }
  return result;
}
