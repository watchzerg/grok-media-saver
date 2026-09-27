import type { ReservedSQL } from "bun";
import type { SaveConfig } from "./config";
import {
  MediaCapabilityUnavailableError,
  type MediaSource,
} from "./core/file-capabilities";
import { archivePost } from "./core/post-archiver";
import { discardDownloadedTemp, downloadToTemp } from "./files/download";
import { cleanupPublishedTemp, publishIntent } from "./files/publish-intent";
import { checkArchiveFile } from "./files/verify";
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
  failDownload,
  failUnreadableDetail,
  KnownSaveFailure,
  markFileNotReusable,
  markNeedsDownload,
  readSavedVersion,
  readWork,
  recordPublishIntent,
  recordReusedVersion,
  settleIntent,
  startWork,
} from "./store/save-work";
import { verifySchema } from "./store/schema";

export type SavePostSession = {
  getPostDetail(postId: string, signal: AbortSignal): Promise<PostResponse>;
  downloadMedia?: MediaSource;
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

type ArchivePostInRunResult = SavePostResult & { settledIntent: boolean };

export function safeSaveError(error: unknown, config: SaveConfig): string {
  let message = safeDatabaseError(error, config);
  for (const secret of [
    config.extensionToken,
    encodeURIComponent(config.extensionToken),
  ]) {
    if (secret) message = message.replaceAll(secret, "[已隐藏]");
  }
  return message.replace(/([?&](?:token|auth|key)=)[^&\s]+/gi, "$1[已隐藏]");
}

export async function archivePostInRun(
  config: SaveConfig,
  postId: string,
  runId: string,
  session: ReservedSQL,
  options: SavePostOptions,
  write: <T>(operation: () => Promise<T>) => Promise<T>,
  onSaved: () => void,
  onCleanupError: (message: string) => void,
): Promise<ArchivePostInRunResult> {
  const signal = options.signal ?? new AbortController().signal;
  let browser: SavePostSession | undefined;
  let postResult: ArchivePostInRunResult | undefined;
  let saved = false;
  let settledIntent = false;
  const recordSaved = () => {
    saved = true;
    onSaved();
  };
  try {
    const archived = await archivePost({
      postId,
      files: {
        checkArchiveFile: (path, bytes, sha256) =>
          checkArchiveFile(config.archiveRoot, path, bytes, sha256),
        downloadToTemp: (
          id,
          selection,
          source,
          transferSignal,
          onStage,
          timeouts,
        ) =>
          downloadToTemp(
            config.archiveRoot,
            id,
            selection,
            source,
            transferSignal,
            onStage,
            timeouts,
          ),
        discardDownloadedTemp: (id, intent) =>
          discardDownloadedTemp(config.archiveRoot, id, intent),
        publishIntent: (id, work, publishSignal, onStage) =>
          publishIntent(config.archiveRoot, id, work, publishSignal, onStage),
        cleanupPublishedTemp: (id, work) =>
          cleanupPublishedTemp(config.archiveRoot, id, work),
      },
      signal,
      onStage: options.onStage,
      store: {
        readWork: async (id) => {
          const work = await readWork(session, id);
          if (work?.status === "saved") recordSaved();
          return work;
        },
        startWork: (id, run) => write(() => startWork(session, id, run)),
        clearMissingIntent: (id, work, run) =>
          write(() => clearMissingIntent(session, id, work, run)),
        settleIntent: async (id, work, run) => {
          await write(() => settleIntent(session, id, work, run));
          settledIntent = true;
          recordSaved();
        },
        failUnreadableDetail: (id, run) =>
          write(() => failUnreadableDetail(session, id, run)),
        readSavedVersion: (id, version) =>
          readSavedVersion(session, id, version),
        recordReusedVersion: (id, run, version) =>
          write(() => recordReusedVersion(session, id, run, version)),
        markFileNotReusable: (id, run) =>
          write(() => markFileNotReusable(session, id, run)),
        markNeedsDownload: (id, run, selection) =>
          write(() => markNeedsDownload(session, id, run, selection)),
        recordPublishIntent: (id, run, selection, intent) =>
          write(() => recordPublishIntent(session, id, run, selection, intent)),
        failDownload: (id, run, reason) =>
          write(() => failDownload(session, id, run, reason)),
        assertLock: () => assertExecutorLock(session),
      },
      getDetail: async (detailSignal) => {
        browser ??= await options.connect(detailSignal);
        return browser.getPostDetail(postId, detailSignal);
      },
      waitBeforeRetry: options.waitBeforeRetry,
      downloadMedia: async (selection, onResponse, onChunk, transferSignal) => {
        if (!browser?.downloadMedia)
          throw new MediaCapabilityUnavailableError(
            "浏览器会话不支持媒体流传输。",
          );
        await browser.downloadMedia(
          selection,
          onResponse,
          onChunk,
          transferSignal,
        );
      },
      hasMediaCapability: () => Boolean(browser?.downloadMedia),
      mediaTimeouts: {
        firstByte: config.mediaFirstByteTimeoutSeconds * 1000,
        noProgress: config.mediaNoProgressTimeoutSeconds * 1000,
        total: config.mediaTotalTimeoutSeconds * 1000,
      },
      runId,
    });
    postResult = { ...archived, saveRecorded: saved, settledIntent };
    return postResult;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        const message = `浏览器清理失败：${safeSaveError(error, config)}`;
        if (postResult) postResult.cleanupErrors.push(message);
        else onCleanupError(message);
      }
      if (postResult && browser.cleanupNotices?.length)
        postResult.message = `${postResult.message} ${browser.cleanupNotices.join(" ")}`;
    }
  }
}

export async function savePost(
  config: SaveConfig,
  postId: string,
  options: SavePostOptions,
): Promise<SavePostResult> {
  const signal = options.signal ?? new AbortController().signal;
  let sql: ReturnType<typeof connectDatabase> | undefined;
  let session: ReservedSQL | undefined;
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
    if (!signal.aborted || result.status === "cancelled") return;
    result.message =
      result.status === "ok"
        ? "保存已停止；Post 已保存。"
        : `保存已停止；${result.message}`;
    result.status = "cancelled";
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
    const postResult = await archivePostInRun(
      config,
      postId,
      runId,
      session,
      options,
      write,
      () => {
        result.saveRecorded = true;
      },
      (message) => result.cleanupErrors.push(message),
    );
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
