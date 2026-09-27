import {
  BlockedMediaError,
  discardDownloadedTemp,
  downloadToTemp,
  MediaCapabilityUnavailableError,
  type MediaSource,
  RetryableMediaError,
} from "../files/download";
import { cleanupPublishedTemp, publishIntent } from "../files/publish-intent";
import { checkArchiveFile } from "../files/verify";
import type { PostMediaSelection, PostResponse } from "../grok/adapter";
import { RetryableRequestError } from "../grok/adapter";
import { KnownSaveFailure, type Work } from "../store/save-work";

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
    },
  ): Promise<void>;
  failDownload(postId: string, runId: string, reason: string): Promise<void>;
  assertLock(): Promise<void>;
};

export async function archivePost({
  postId,
  archiveRoot,
  signal,
  onStage,
  store,
  getDetail,
  waitBeforeRetry,
  downloadMedia,
  hasMediaCapability,
  mediaTimeouts,
  runId,
}: {
  postId: string;
  archiveRoot: string;
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
  } = {
    status: "failed",
    message: "Post 保存未完成。",
    cleanupErrors: [],
  };
  let work = await store.readWork(postId);
  if (!work) {
    await store.startWork(postId, runId);
    work = await store.readWork(postId);
  }
  if (work?.status === "finalizing") {
    onStage?.("核对发布意图");
    if (signal.aborted) throw new Error("保存已停止；发布意图已保留。");
    const publication = await publishIntent(
      archiveRoot,
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
      const cleanup = await cleanupPublishedTemp(archiveRoot, postId, work);
      if (cleanup) result.cleanupErrors.push(cleanup);
    }
    work = await store.readWork(postId);
  }
  if (signal.aborted) {
    result.status = "cancelled";
    result.message = "保存已停止；已开始的发布已完成一致性收尾。";
  } else {
    await store.assertLock();
    onStage?.("读取当前详情");
    let detail: PostResponse;
    for (let attempt = 1; ; attempt += 1) {
      if (signal.aborted) throw new Error("保存已停止。");
      try {
        detail = await getDetail(signal);
      } catch (error) {
        if (signal.aborted) throw new Error("保存已停止。");
        if (!(error instanceof RetryableRequestError) || attempt >= 2)
          throw error;
        await waitBeforeRetry(signal);
        await store.assertLock();
        continue;
      }
      if (signal.aborted) throw new Error("保存已停止。");
      if (detail.kind !== "temporary" || attempt >= 2) break;
      await waitBeforeRetry(signal);
      await store.assertLock();
    }
    if (detail.kind !== "post") {
      if (detail.kind === "blocked") {
        const reason =
          detail.reason === "authentication" ? "登录或 challenge" : "请求限流";
        const status = detail.status ? `HTTP ${detail.status}` : "";
        const wait = detail.retryAfter
          ? `；服务端建议等待 ${detail.retryAfter}`
          : "";
        result.status = "blocked";
        result.message = `Post 请求被阻挡（${[reason, status].filter(Boolean).join("，")}）${wait}。`;
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
      work.mimeType === detail.selection.mimeType &&
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
          ? await checkArchiveFile(
              archiveRoot,
              version.relativePath,
              Number(version.byteCount),
              version.sha256,
            )
          : { status: "mismatch" as const };
      onStage?.("已核验保存文件");
      if (signal.aborted) throw new Error("保存已停止。");
      if (check.status === "ok") {
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
  return result;

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
      let intent: Awaited<ReturnType<typeof downloadToTemp>>;
      try {
        intent = await downloadToTemp(
          archiveRoot,
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
          await waitBeforeRetry(signal);
          await store.assertLock();
          const next = await getDetail(signal);
          if (next.kind === "blocked") {
            result.status = "blocked";
            result.message = "Post 详情重读被阻挡。";
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
        await discardDownloadedTemp(archiveRoot, postId, intent);
        throw error;
      }
      onStage?.("提交发布意图");
      try {
        await store.recordPublishIntent(postId, runId, selection, intent);
      } catch (error) {
        if (error instanceof KnownSaveFailure)
          await discardDownloadedTemp(archiveRoot, postId, intent);
        throw error;
      }
      const work = await store.readWork(postId);
      if (work?.status !== "finalizing")
        throw new Error("发布意图提交后无法确认工作状态。");
      const publication = await publishIntent(
        archiveRoot,
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
      const cleanup = await cleanupPublishedTemp(archiveRoot, postId, work);
      if (cleanup) result.cleanupErrors.push(cleanup);
      result.status = "ok";
      result.message = "Post 保存完成。";
      return;
    }
  }
}
