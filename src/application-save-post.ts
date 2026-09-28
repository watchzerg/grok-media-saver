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
import {
  type PostResponse,
  parseCheckResponse,
  parseDeleteResponse,
  type RawCheckResponse,
  type RawDeleteResponse,
} from "./grok/adapter";
import {
  confirmRemoval,
  promoteArchiveWork,
  recordDeletionIntent,
  settleArchive,
  settleRecoveredArchive,
} from "./store/archive-work";
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
  checkPost?(postId: string, signal: AbortSignal): Promise<RawCheckResponse>;
  deletePost?(postId: string, signal: AbortSignal): Promise<RawDeleteResponse>;
  close(): Promise<void>;
  cleanupNotices?: string[];
  // aggregate close 已为每项资源分别持有 5 秒清理期限。
  cleanupBounded?: true;
};

export type SavePostOptions = {
  connect(signal: AbortSignal): Promise<SavePostSession>;
  waitBeforeRetry: (signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  goal?: "save" | "archive";
  onStage?: (stage: string) => void;
};

export type SavePostResult = {
  status: "ok" | "blocked" | "failed" | "cancelled";
  message: string;
  // true: a saved fact for this Post was observed or committed; null: DB write outcome unknown.
  saveRecorded: boolean | null;
  cleanupErrors: string[];
  remoteObservation?: "not-requested" | "unknown" | "removed" | "present";
  archiveRecorded?: boolean | null;
  fatalExecution?: boolean;
};

type ArchivePostInRunResult = SavePostResult & {
  settledIntent: boolean;
  unprocessed?: boolean;
  alreadySettled?: boolean;
};

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
      goal: options.goal,
      checkPost: async (id, checkSignal) => {
        browser ??= await options.connect(checkSignal);
        if (!browser.checkPost)
          throw new Error("浏览器会话不支持精确 Post 核对 GET。");
        return parseCheckResponse(id, await browser.checkPost(id, checkSignal));
      },
      deletePost: async (id, deleteSignal) => {
        if (!browser?.deletePost)
          throw new Error("浏览器会话不支持精确 Post DELETE。");
        return parseDeleteResponse(
          id,
          await browser.deletePost(id, deleteSignal),
        );
      },
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
          if (
            work?.status === "saved" &&
            (work.goal === "save" || options.goal === "archive")
          )
            recordSaved();
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
        promoteArchiveWork: () =>
          write(() => promoteArchiveWork(session, postId, runId)),
        recordDeletionIntent: (versionId) =>
          write(() => recordDeletionIntent(session, postId, versionId, runId)),
        confirmRemoval: (versionId) =>
          write(() => confirmRemoval(session, postId, versionId, runId)),
        settleRecoveredArchive: (versionId) =>
          write(() =>
            settleRecoveredArchive(session, postId, versionId, runId),
          ),
        settleArchive: (versionId) =>
          write(() => settleArchive(session, postId, versionId, runId)),
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
    postResult = {
      ...archived,
      message: safeSaveError(new Error(archived.message), config),
      saveRecorded: saved,
      settledIntent,
    };
    return postResult;
  } finally {
    if (browser) {
      try {
        if (browser.cleanupBounded) await browser.close();
        else await boundedCleanup(browser.close(), "浏览器关闭");
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
  let finishingRun = false;
  const result: SavePostResult = {
    status: "failed",
    message: "Post 保存未完成。",
    saveRecorded: false,
    cleanupErrors: [],
  };
  const reportStopAfterSave = () => {
    if (!signal.aborted || result.status === "cancelled") return;
    result.message =
      options.goal === "archive"
        ? `归档已停止；${result.message}`
        : result.status === "ok"
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
    await startSaveRun(session, runId, postId, options.goal);
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
    if (runId && !result.fatalExecution) {
      finishingRun = true;
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
    result.message =
      finishingRun && options.goal === "archive"
        ? `${result.message} ${runWriteUnknown ? "Run 收尾提交结果未知，已停止" : "Run 收尾失败"}：${safeSaveError(error, config)}`
        : runWriteUnknown
          ? `数据库提交结果未知，已停止：${safeSaveError(error, config)}`
          : `保存失败：${safeSaveError(error, config)}`;
    if (runId && session && !runWriteUnknown && !result.fatalExecution) {
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
          await boundedCleanup(releaseExecutorLock(session), "执行器解锁");
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
        await boundedCleanup(sql.close({ timeout: 5 }), "数据库关闭");
      } catch (error) {
        result.cleanupErrors.push(
          `数据库关闭失败：${safeSaveError(error, config)}`,
        );
      }
    }
    reportStopAfterSave();
    if (result.cleanupErrors.length && result.status === "ok") {
      result.status = "failed";
      result.message =
        options.goal === "archive"
          ? `${result.message} 资源清理失败。`
          : "Post 已保存，但资源清理失败。";
    }
  }
  return result;
}

async function boundedCleanup<T>(
  operation: Promise<T>,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label}未能在 5 秒内完成。`)),
      5_000,
    );
  });
  return Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
}
