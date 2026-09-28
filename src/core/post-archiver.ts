import type { PostMediaSelection, PostResponse } from "../grok/adapter";
import { type DeleteResponse, RetryableRequestError } from "../grok/adapter";
import { KnownSaveFailure, type Work } from "../store/save-work";
import {
  BlockedMediaError,
  type FileCapabilities,
  MediaCapabilityUnavailableError,
  type MediaSource,
  RetryableMediaError,
} from "./file-capabilities";

type Store = {
  readWork(postId: string): Promise<Work | undefined>;
  startWork(postId: string, runId: string): Promise<void>;
  clearMissingIntent(postId: string, work: Work, runId: string): Promise<void>;
  settleIntent(postId: string, work: Work, runId: string): Promise<void>;
  failUnreadableDetail(postId: string, runId: string): Promise<void>;
  readSavedVersion(
    postId: string,
    versionId: string,
  ): Promise<
    { relativePath: string; byteCount: string; sha256: string } | undefined
  >;
  recordReusedVersion(
    postId: string,
    runId: string,
    versionId: string,
  ): Promise<void>;
  markFileNotReusable(postId: string, runId: string): Promise<void>;
  markNeedsDownload(
    postId: string,
    runId: string,
    selection: PostMediaSelection,
  ): Promise<void>;
  recordPublishIntent(
    postId: string,
    runId: string,
    selection: PostMediaSelection,
    intent: {
      tempName: string;
      relativePath: string;
      publishBytes: string;
      sha256: string;
      mimeType: string;
    },
  ): Promise<void>;
  failDownload(postId: string, runId: string, reason: string): Promise<void>;
  assertLock(): Promise<void>;
  promoteArchiveWork?(): Promise<void>;
  recordDeletionIntent?(versionId: string): Promise<void>;
  settleArchive?(versionId: string): Promise<void>;
};

export async function archivePost({
  postId,
  files,
  signal,
  onStage,
  store,
  getDetail,
  waitBeforeRetry,
  downloadMedia,
  hasMediaCapability,
  mediaTimeouts,
  runId,
  goal = "save",
  deletePost,
}: {
  postId: string;
  goal?: "save" | "archive";
  deletePost?: (postId: string, signal: AbortSignal) => Promise<DeleteResponse>;
  files: FileCapabilities;
  signal: AbortSignal;
  onStage?: (stage: string) => void;
  store: Store;
  getDetail(signal: AbortSignal): Promise<PostResponse>;
  waitBeforeRetry: (signal: AbortSignal) => Promise<void>;
  downloadMedia?: MediaSource;
  hasMediaCapability?: () => boolean;
  mediaTimeouts?: { firstByte: number; noProgress: number; total: number };
  runId: string;
}) {
  let saved = false;
  const result: {
    status: "ok" | "blocked" | "failed" | "cancelled";
    message: string;
    cleanupErrors: string[];
    unprocessed?: boolean;
    alreadySettled?: boolean;
    remoteObservation?: "not-requested" | "unknown" | "removed";
    archiveRecorded?: boolean | null;
    fatalExecution?: boolean;
  } = {
    status: "failed",
    message: "Post 保存未完成。",
    cleanupErrors: [],
  };
  let work = await store.readWork(postId);
  if (work?.archiveSettled) {
    return {
      ...result,
      status: "ok" as const,
      alreadySettled: true,
      ...(goal === "archive"
        ? { archiveRecorded: true, remoteObservation: "not-requested" as const }
        : {}),
      message: "Post 已归档结清，本次直接跳过。",
    };
  }
  if (work?.goal === "archive" && goal === "save") {
    return {
      ...result,
      unprocessed: true,
      message: `Post ${postId} 为未结清 archive 工作，本次未处理；请使用 archive post ${postId} 或 retry 接续归档。`,
    };
  }
  if (goal === "archive") {
    result.remoteObservation = "not-requested";
    result.archiveRecorded = false;
    if (work?.removalState && work.removalState !== "none") {
      result.remoteObservation =
        work.removalState === "removed" ? "removed" : "unknown";
      result.message =
        work.removalState === "removed"
          ? "远端已确认移除，归档尚未结清；请接续绑定版本核验。"
          : "移除结果未知，删除意图待核对；本次不重发 DELETE。";
      return result;
    }
    await store.promoteArchiveWork?.();
    work = await store.readWork(postId);
  }
  if (!work) {
    await store.startWork(postId, runId);
    work = await store.readWork(postId);
  }
  if (work?.status === "finalizing") {
    onStage?.("核对发布意图");
    if (signal.aborted) throw new Error("保存已停止；发布意图已保留。");
    const publication = await files.publishIntent(
      postId,
      work,
      signal,
      onStage,
    );
    if (publication === "missing") {
      await store.clearMissingIntent(postId, work, runId);
    } else {
      await store.assertLock();
      onStage?.("提交保存结果");
      await store.settleIntent(postId, work, runId);
      saved = true;
      onStage?.("保存结果已提交");
      const cleanup = await files.cleanupPublishedTemp(postId, work);
      if (cleanup) {
        result.cleanupErrors.push(cleanup);
        result.status = "failed";
        result.fatalExecution = true;
        result.message =
          goal === "archive"
            ? "Post 已保存，归档未完成；尚未发起移除。文件清理失败，已停止后续处理。"
            : "Post 已保存，但文件清理失败；已停止后续处理。";
        return result;
      }
    }
    work = await store.readWork(postId);
  }
  if (signal.aborted) {
    result.status = "cancelled";
    result.message = "保存已停止；已开始的发布已完成一致性收尾。";
  } else {
    await store.assertLock();
    onStage?.("读取当前详情");
    const detail = await readCurrentDetail();
    if (detail.kind !== "post") {
      if (detail.kind === "blocked") {
        result.status = "blocked";
        result.message = blockedDetailMessage(detail);
      }
      if (detail.kind !== "blocked" && work?.status !== "finalizing") {
        await store.failUnreadableDetail(postId, runId);
      }
      if (detail.kind !== "blocked")
        result.message = saved
          ? "旧发布意图已结清，但当前 Post 详情不可读取；本次保存未完成。"
          : "当前 Post 详情不可读取；本次保存未完成。";
    } else if (
      work?.status === "saved" &&
      work.selectedKey === detail.selection.key &&
      work.quality === detail.selection.quality &&
      (work.mimeType === detail.selection.mimeType ||
        (work.mimeType === "image/jpeg" &&
          detail.selection.mimeType === "image/png")) &&
      (work.expectedBytes === null ||
        detail.selection.expectedBytes === undefined ||
        Number(work.expectedBytes) === detail.selection.expectedBytes) &&
      work.relativePath === null &&
      work.savedMediaVersionId
    ) {
      const version = await store.readSavedVersion(
        postId,
        work.savedMediaVersionId,
      );
      onStage?.("核验已保存文件");
      const check =
        version &&
        (detail.selection.expectedBytes === undefined ||
          Number(version.byteCount) === detail.selection.expectedBytes)
          ? await files.checkArchiveFile(
              version.relativePath,
              Number(version.byteCount),
              version.sha256,
            )
          : { status: "mismatch" as const };
      onStage?.("已核验保存文件");
      if (signal.aborted) throw new Error("保存已停止。");
      if (check.status === "failed") throw new Error(check.reason);
      if (check.status === "ok") {
        await store.recordReusedVersion(
          postId,
          runId,
          work.savedMediaVersionId,
        );
        result.status = "ok";
        result.message = saved
          ? "发布意图已结清，当前来源匹配；Post 保存完成。"
          : "当前来源匹配，已复用保存文件。";
      } else {
        await store.markFileNotReusable(postId, runId);
        result.message = "当前保存文件无法复用，需要重新下载；本次保存未完成。";
        await saveDownloaded(detail.selection);
      }
    } else {
      if (work?.status !== "finalizing") {
        await store.markNeedsDownload(postId, runId, detail.selection);
      }
      result.message = "当前来源或元数据变化，需要下载；本次保存未完成。";
      await saveDownloaded(detail.selection);
    }
  }
  if (goal === "archive" && result.status === "ok") await removeSavedPost();
  return result;

  async function removeSavedPost(): Promise<void> {
    result.status = "failed";
    result.message = "Post 已保存，归档未完成；尚未发起移除。";
    if (!deletePost || !store.recordDeletionIntent || !store.settleArchive)
      throw new Error("浏览器会话不支持精确 Post DELETE。");
    if (signal.aborted) {
      result.status = "cancelled";
      return;
    }
    await store.assertLock();
    const before = await store.readWork(postId);
    if (
      before?.status !== "saved" ||
      !before.savedMediaVersionId ||
      before.relativePath ||
      before.removalState !== "none"
    )
      throw new Error("保存或删除资格无法确认，未发起 DELETE。");
    const versionId = before.savedMediaVersionId;
    onStage?.("提交删除意图");
    try {
      await store.recordDeletionIntent(versionId);
    } catch (error) {
      result.archiveRecorded = null;
      result.fatalExecution = true;
      result.message = `Post 已保存，删除意图提交结果未知，归档未完成；已停止且未发起 DELETE：${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    onStage?.("删除意图已提交");
    await waitBeforeRetry(signal);
    await store.assertLock();
    if (signal.aborted) {
      result.status = "cancelled";
      result.message = "归档已停止；删除意图待核对，未发起 DELETE。";
      return;
    }
    const bound = await store.readWork(postId);
    if (
      bound?.removalState !== "pending" ||
      bound.deletionMediaVersionId !== versionId ||
      bound.savedMediaVersionId !== versionId
    )
      throw new Error("发送前的删除绑定发生变化，未发起 DELETE。");
    onStage?.("发送精确 DELETE");
    if (signal.aborted) {
      result.status = "cancelled";
      return;
    }
    result.remoteObservation = "unknown";
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectStop!: (error: Error) => void;
    const stopped = new Promise<never>((_, reject) => {
      rejectStop = reject;
    });
    const abort = () => {
      controller.abort();
      rejectStop(new Error("归档已停止；移除结果未知，待核对。"));
    };
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      rejectStop(new Error("DELETE 超过 30 秒总期限；移除结果未知，待核对。"));
    }, 30_000);
    let parsed: DeleteResponse;
    try {
      parsed = await Promise.race([
        deletePost(postId, controller.signal),
        stopped,
      ]);
    } catch (error) {
      result.status = signal.aborted ? "cancelled" : "failed";
      result.fatalExecution = true;
      result.message = `Post 已保存，移除结果未知，待核对；归档未完成：${error instanceof Error ? error.message : String(error)}`;
      return;
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
    if (parsed.kind !== "removed") {
      result.status = parsed.kind === "blocked" ? "blocked" : "failed";
      result.message =
        parsed.kind === "blocked"
          ? `DELETE 被阻挡（HTTP ${parsed.status}）${parsed.retryAfter ? `；服务端建议等待 ${parsed.retryAfter}` : ""}；移除结果未知，待核对；Post 已保存，归档未完成。`
          : "DELETE 未取得认可响应；移除结果未知，待核对；Post 已保存，归档未完成。";
      return;
    }
    result.remoteObservation = "removed";
    onStage?.("远端已确认移除");
    try {
      await store.assertLock();
      onStage?.("提交归档结清");
      await store.settleArchive(versionId);
    } catch (error) {
      result.archiveRecorded = null;
      result.fatalExecution = true;
      result.message = `本次已确认远端移除，数据库提交结果未知，归档结清未确认：${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    result.archiveRecorded = true;
    result.status = signal.aborted ? "cancelled" : "ok";
    result.message = signal.aborted
      ? "归档已停止；本次远端已确认移除，归档已结清。"
      : "Post 已保存，本次远端已确认移除，归档已结清。";
    onStage?.("归档结清已提交");
  }

  async function saveDownloaded(initial: PostMediaSelection): Promise<void> {
    if (!downloadMedia || (hasMediaCapability && !hasMediaCapability())) {
      return;
    }
    let selection = initial;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (signal.aborted) throw new Error("保存已停止。");
      await store.assertLock();
      await waitBeforeRetry(signal);
      if (signal.aborted) throw new Error("保存已停止。");
      onStage?.("下载当前媒体");
      let intent: Awaited<ReturnType<FileCapabilities["downloadToTemp"]>>;
      try {
        intent = await files.downloadToTemp(
          postId,
          selection,
          downloadMedia,
          signal,
          onStage,
          mediaTimeouts,
        );
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof MediaCapabilityUnavailableError) {
          return;
        }
        if (error instanceof BlockedMediaError) {
          result.status = "blocked";
          result.message = error.message;
          return;
        }
        if (error instanceof RetryableMediaError && attempt < 2) {
          const next = await readCurrentDetail();
          if (next.kind === "blocked") {
            result.status = "blocked";
            result.message = blockedDetailMessage(next);
            return;
          }
          if (next.kind !== "post") {
            await store.failDownload(postId, runId, "媒体重试前的详情不可读取");
            result.message = "媒体重试前的详情不可读取。";
            return;
          }
          selection = next.selection;
          await store.markNeedsDownload(postId, runId, selection);
          continue;
        }
        if (
          error instanceof RetryableMediaError ||
          (error instanceof Error && /^媒体请求失败/.test(error.message))
        ) {
          await store.failDownload(postId, runId, error.message);
          result.message = error.message;
          return;
        }
        throw error;
      }
      try {
        await store.assertLock();
        if (signal.aborted) throw new Error("保存已停止。");
      } catch (error) {
        await files.discardDownloadedTemp(postId, intent);
        throw error;
      }
      onStage?.("提交发布意图");
      try {
        await store.recordPublishIntent(postId, runId, selection, intent);
      } catch (error) {
        if (error instanceof KnownSaveFailure)
          await files.discardDownloadedTemp(postId, intent);
        throw error;
      }
      const work = await store.readWork(postId);
      if (work?.status !== "finalizing")
        throw new Error("发布意图提交后无法确认工作状态。");
      const publication = await files.publishIntent(
        postId,
        work,
        signal,
        onStage,
      );
      if (publication !== "published")
        throw new Error("新发布意图的临时文件缺失。");
      await store.assertLock();
      onStage?.("提交保存结果");
      await store.settleIntent(postId, work, runId);
      saved = true;
      onStage?.("保存结果已提交");
      const cleanup = await files.cleanupPublishedTemp(postId, work);
      if (cleanup) {
        result.cleanupErrors.push(cleanup);
        result.status = "failed";
        result.fatalExecution = true;
        result.message =
          goal === "archive"
            ? "Post 已保存，归档未完成；尚未发起移除。文件清理失败，已停止后续处理。"
            : "Post 已保存，但文件清理失败；已停止后续处理。";
        return;
      }
      result.status = "ok";
      result.message = "Post 保存完成。";
      return;
    }
  }

  async function readCurrentDetail(): Promise<PostResponse> {
    for (let attempt = 1; ; attempt += 1) {
      if (signal.aborted) throw new Error("保存已停止。");
      await waitBeforeRetry(signal);
      await store.assertLock();
      if (signal.aborted) throw new Error("保存已停止。");
      let detail: PostResponse;
      try {
        detail = await getDetail(signal);
      } catch (error) {
        if (signal.aborted) throw new Error("保存已停止。");
        if (error instanceof RetryableRequestError && attempt >= 2) {
          await store.assertLock();
          await store.failUnreadableDetail(postId, runId);
          throw error;
        }
        if (!(error instanceof RetryableRequestError)) throw error;
        continue;
      }
      if (signal.aborted) throw new Error("保存已停止。");
      if (detail.kind !== "temporary" || attempt >= 2) return detail;
    }
  }
}

function blockedDetailMessage(
  detail: Extract<PostResponse, { kind: "blocked" }>,
) {
  const reason =
    detail.reason === "authentication" ? "登录或 challenge" : "请求限流";
  const status = detail.status ? `HTTP ${detail.status}` : "";
  const wait = detail.retryAfter ? `；服务端建议等待 ${detail.retryAfter}` : "";
  return `Post 请求被阻挡（${[reason, status].filter(Boolean).join("，")}）${wait}。`;
}
