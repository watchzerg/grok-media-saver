import type { PostMediaSelection, PostResponse } from "../grok/adapter";
import {
  type CheckResponse,
  type DeleteResponse,
  RetryableRequestError,
  UnconfirmedStopError,
} from "../grok/adapter";
import { KnownSaveFailure, type Work } from "../store/save-work";
import {
  BlockedMediaError,
  type FileCapabilities,
  MediaCapabilityUnavailableError,
  type MediaSource,
  RetryableMediaError,
} from "./file-capabilities";

export type ArchiveRequestBudget = {
  deleteStarted: boolean;
  recoveryStarted: boolean;
  currentStarted: boolean;
};

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
    | {
        relativePath: string;
        byteCount: string;
        sha256: string;
        mimeType: string;
      }
    | undefined
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
  settlePresentIntent?(versionId: string): Promise<void>;
  confirmRemoval?(versionId: string): Promise<void>;
  settleRecoveredArchive?(versionId: string): Promise<void>;
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
  checkPost,
  requestBudget = {
    deleteStarted: false,
    recoveryStarted: false,
    currentStarted: false,
  },
}: {
  requestBudget?: ArchiveRequestBudget;
  postId: string;
  goal?: "save" | "archive";
  checkPost?: (
    postId: string,
    signal: AbortSignal,
    beforeRequest: () => Promise<void>,
  ) => Promise<CheckResponse>;
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
    remoteObservation?: "not-requested" | "unknown" | "removed" | "present";
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
      try {
        const continueSaving = await recoverDeletion(
          work,
          requestBudget.deleteStarted,
        );
        if (!continueSaving) return result;
      } catch (error) {
        result.fatalExecution = true;
        result.message = `${result.message} 归档恢复未完成；已停止：${error instanceof Error ? error.message : String(error)}`;
      }
      if (result.fatalExecution) return result;
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

  async function recoverDeletion(
    boundWork: Work,
    currentDelete = false,
  ): Promise<boolean | undefined> {
    const versionId = boundWork.deletionMediaVersionId;
    result.remoteObservation =
      boundWork.removalState === "removed" ? "removed" : "unknown";
    result.message = "移除结果未知，删除意图待核对；本次不重发 DELETE。";
    if (!versionId || !store.confirmRemoval || !store.settleRecoveredArchive)
      throw new Error("删除绑定记录无法确认，归档未完成。");
    if (boundWork.removalState === "pending") {
      if (!checkPost) throw new Error("浏览器会话不支持精确 Post 核对 GET。");
      const phase = currentDelete ? "currentStarted" : "recoveryStarted";
      if (requestBudget[phase]) return;
      requestBudget[phase] = true;
      let observed: CheckResponse = { kind: "unknown" };
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        await waitBeforeRetry(signal);
        await store.assertLock();
        if (signal.aborted) {
          result.status = "cancelled";
          return;
        }
        const current = await store.readWork(postId);
        if (
          current?.removalState !== "pending" ||
          current.deletionMediaVersionId !== versionId
        )
          throw new Error("核对前删除意图或绑定发生变化。");
        onStage?.("核对精确 Post");
        if (signal.aborted) {
          result.status = "cancelled";
          return;
        }
        const controller = new AbortController();
        let rejectDeadline!: (error: Error) => void;
        const deadline = new Promise<never>((_, reject) => {
          rejectDeadline = reject;
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const beforeRequest = async () => {
          await store.assertLock();
          if (signal.aborted) throw new Error("核对已停止；未发起 GET。");
          const bound = await store.readWork(postId);
          if (
            bound?.removalState !== "pending" ||
            bound.deletionMediaVersionId !== versionId
          )
            throw new Error("发送前核对绑定发生变化，未发起 GET。");
          timer = setTimeout(() => {
            controller.abort();
            rejectDeadline(
              new UnconfirmedStopError(
                "核对 GET 超过 30 秒总期限；请求停止无法确认。",
              ),
            );
          }, 30_000);
        };
        const abort = () => controller.abort();
        signal.addEventListener("abort", abort, { once: true });
        try {
          observed = await Promise.race([
            checkPost(postId, controller.signal, beforeRequest),
            deadline,
          ]);
          if (signal.aborted) {
            result.status = "cancelled";
            return;
          }
          if (observed.kind === "removed" || observed.kind === "present")
            result.remoteObservation = observed.kind;
          await store.assertLock();
        } catch (error) {
          if (error instanceof RetryableRequestError && !signal.aborted) {
            await store.assertLock();
            if (attempt < 2) continue;
            result.message =
              "核对 GET 的条件重试额度已用尽；移除结果未知，待核对。";
            return;
          }
          if (result.remoteObservation === "removed")
            result.archiveRecorded = null;
          result.status = signal.aborted ? "cancelled" : "failed";
          const observationMessage =
            result.remoteObservation === "removed"
              ? "远端已确认移除，归档未结清；持久记账未确认"
              : result.remoteObservation === "present"
                ? "核对确认远端 Post 仍存在，归档未完成；保留原意图，本次不重发 DELETE"
                : "移除结果未知，待核对";
          result.message = `${observationMessage}；已停止：${error instanceof Error ? error.message : String(error)}`;
          // 断连、取消收尾不确定或丢锁后停止推进；不改写 Post 工作事实。
          result.fatalExecution = true;
          if (error instanceof UnconfirmedStopError)
            result.cleanupErrors.push(error.message);
          return;
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
        }
        if (observed.kind === "temporary" && attempt < 2) continue;
        break;
      }
      if (observed.kind === "present") {
        result.message =
          "核对确认远端 Post 仍存在，归档未完成；接续旧意图结清。";
        try {
          await store.assertLock();
          onStage?.("提交旧删除意图结清");
          if (signal.aborted) {
            result.status = "cancelled";
            return;
          }
          if (!store.settlePresentIntent)
            throw new Error("旧删除意图结清能力不可用。");
          await store.settlePresentIntent(versionId);
        } catch (error) {
          result.archiveRecorded = null;
          result.fatalExecution = true;
          result.message = `核对确认远端 Post 仍存在，旧删除意图结清提交结果未知，归档未完成；已停止：${error instanceof Error ? error.message : String(error)}`;
          return;
        }
        onStage?.("旧删除意图结清已提交");
        if (currentDelete) {
          result.message =
            "核对确认远端 Post 仍存在，旧删除意图已结清，归档未完成；本 Run 不再 DELETE。";
          return;
        }
        return true;
      }
      if (observed.kind !== "removed") {
        result.status = observed.kind === "blocked" ? "blocked" : "failed";
        if (observed.kind === "blocked") {
          result.message = `核对 GET 被阻挡（HTTP ${observed.status}）${observed.retryAfter ? `；服务端建议等待 ${observed.retryAfter}` : ""}；移除结果未知，待核对。`;
        }
        return;
      }
      result.remoteObservation = "removed";
      onStage?.("远端已确认移除");
      try {
        await store.assertLock();
        if (signal.aborted) {
          result.status = "cancelled";
          return;
        }
        await store.confirmRemoval(versionId);
      } catch (error) {
        uncertainWrite(error, "移除确认");
        return;
      }
      onStage?.("移除确认已提交");
    }
    if (currentDelete) {
      try {
        await store.assertLock();
        if (signal.aborted) {
          result.status = "cancelled";
          return;
        }
        await store.settleRecoveredArchive(versionId);
      } catch (error) {
        uncertainWrite(error, "归档结清");
        return;
      }
      result.archiveRecorded = true;
      result.status = "ok";
      result.message =
        "本次核对已确认远端移除，保存文件已有效核验，归档已结清。";
      return;
    }
    result.message = "远端已确认移除，归档尚未结清；接续绑定版本核验。";
    if (signal.aborted) {
      result.status = "cancelled";
      return;
    }
    await store.assertLock();
    const version = await store.readSavedVersion(postId, versionId);
    if (!version) throw new Error("删除绑定版本不存在，归档未结清。");
    onStage?.("核验删除绑定文件");
    let check = await files.checkArchiveFile(
      version.relativePath,
      Number(version.byteCount),
      version.sha256,
    );
    if (signal.aborted) {
      result.status = "cancelled";
      return;
    }
    if (check.status === "missing" || boundWork.status === "finalizing") {
      if (!(await restoreBoundFile(boundWork, version))) return;
      check = { status: "ok" };
    }
    if (check.status !== "ok") {
      if (check.status === "failed") result.fatalExecution = true;
      result.message = `远端已确认移除，绑定文件${check.status === "failed" ? `访问失败：${check.reason}` : "内容冲突或不符"}；归档未结清。`;
      return;
    }
    try {
      await store.assertLock();
      if (signal.aborted) {
        result.status = "cancelled";
        return;
      }
      onStage?.("提交恢复归档结清");
      if (signal.aborted) {
        result.status = "cancelled";
        return;
      }
      await store.settleRecoveredArchive(versionId);
    } catch (error) {
      uncertainWrite(error, "恢复归档结清");
      return;
    }
    result.archiveRecorded = true;
    result.status = "ok";
    result.message = "远端已确认移除，绑定文件核验通过，归档已结清。";
    onStage?.("恢复归档结清已提交");
  }

  async function restoreBoundFile(
    boundWork: Work,
    version: {
      relativePath: string;
      byteCount: string;
      sha256: string;
      mimeType: string;
    },
  ): Promise<boolean> {
    const matches = (intent: {
      relativePath: string | null;
      publishBytes: string | null;
      sha256: string | null;
      mimeType: string | null;
    }) =>
      intent.relativePath === version.relativePath &&
      intent.publishBytes === version.byteCount &&
      intent.sha256 === version.sha256 &&
      intent.mimeType === version.mimeType;
    let pending = boundWork;
    try {
      if (pending.status === "finalizing") {
        if (!matches(pending))
          throw new Error("发布意图与删除绑定版本不符，现场已保留。");
        onStage?.("核对绑定发布意图");
        const publication = await files.publishIntent(
          postId,
          pending,
          signal,
          onStage,
        );
        if (publication === "published")
          return await finishBoundPublication(pending);
        await store.assertLock();
        if (signal.aborted) throw new Error("补救已停止。");
        try {
          await store.clearMissingIntent(postId, pending, runId);
        } catch (error) {
          uncertainWrite(error, "缺失发布意图核对");
          return false;
        }
      }
      if (
        !boundWork.selectedKey ||
        !boundWork.quality ||
        !boundWork.sourceMimeType ||
        !downloadMedia
      )
        throw new MediaCapabilityUnavailableError(
          "绑定媒体原来源或下载能力不可用。",
        );
      const selection: PostMediaSelection = {
        assetId: postId,
        key: boundWork.selectedKey,
        quality: boundWork.quality as PostMediaSelection["quality"],
        mimeType: boundWork.sourceMimeType,
        expectedBytes: Number(version.byteCount),
      };
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        await waitBeforeRetry(signal);
        await store.assertLock();
        if (signal.aborted) throw new Error("补救已停止。");
        onStage?.("下载删除绑定媒体");
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
          if (
            error instanceof RetryableMediaError &&
            attempt < 2 &&
            !signal.aborted
          )
            continue;
          throw error;
        }
        if (!matches(intent)) {
          await files.discardDownloadedTemp(postId, intent);
          throw new KnownSaveFailure(
            "补救内容与绑定大小、类型或 SHA-256 不符。",
          );
        }
        try {
          await store.assertLock();
          if (signal.aborted) throw new Error("补救已停止。");
        } catch (error) {
          await files.discardDownloadedTemp(postId, intent);
          throw error;
        }
        onStage?.("提交绑定发布意图");
        try {
          await store.recordPublishIntent(postId, runId, selection, intent);
        } catch (error) {
          uncertainWrite(error, "绑定发布意图");
          return false;
        }
        pending = (await store.readWork(postId)) as Work;
        if (pending?.status !== "finalizing" || !matches(pending))
          throw new Error("绑定发布意图提交后无法确认。");
        if (
          (await files.publishIntent(postId, pending, signal, onStage)) !==
          "published"
        )
          throw new Error("绑定发布意图临时文件缺失。");
        return await finishBoundPublication(pending);
      }
    } catch (error) {
      result.status = signal.aborted
        ? "cancelled"
        : error instanceof BlockedMediaError
          ? "blocked"
          : "failed";
      result.message = `远端已确认移除，绑定文件补救未完成；归档未结清：${error instanceof Error ? error.message : String(error)}`;
      if (
        !signal.aborted &&
        !(error instanceof RetryableMediaError) &&
        !(error instanceof BlockedMediaError) &&
        !(error instanceof MediaCapabilityUnavailableError) &&
        !(error instanceof KnownSaveFailure) &&
        !(error instanceof Error && /^媒体请求失败/.test(error.message))
      )
        result.fatalExecution = true;
      if (error instanceof UnconfirmedStopError) {
        result.fatalExecution = true;
        result.cleanupErrors.push(error.message);
      }
    }
    return false;
  }

  async function finishBoundPublication(pending: Work): Promise<boolean> {
    try {
      await store.assertLock();
      onStage?.("提交绑定保存结果");
      await store.settleIntent(postId, pending, runId);
    } catch (error) {
      uncertainWrite(error, "绑定保存结果");
      return false;
    }
    onStage?.("绑定保存结果已提交");
    const cleanup = await files.cleanupPublishedTemp(postId, pending);
    if (cleanup) {
      result.cleanupErrors.push(cleanup);
      result.fatalExecution = true;
      result.message = `远端已确认移除，归档未结清；${cleanup}`;
      return false;
    }
    return true;
  }

  function uncertainWrite(error: unknown, operation: string): void {
    result.archiveRecorded = null;
    result.fatalExecution = true;
    result.message = `远端已确认移除，${operation}提交结果未知，归档结清未确认；已停止：${error instanceof Error ? error.message : String(error)}`;
  }

  async function removeSavedPost(): Promise<void> {
    result.status = "failed";
    result.message = "Post 已保存，归档未完成；尚未发起移除。";
    if (requestBudget.deleteStarted) {
      result.message = "Post 已保存，归档未完成；本 Run 的 DELETE 额度已使用。";
      return;
    }
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
    requestBudget.deleteStarted = true;
    result.remoteObservation = "unknown";
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectStop!: (error: Error) => void;
    const stopped = new Promise<never>((_, reject) => {
      rejectStop = reject;
    });
    // 发起后首次停止只禁止后续请求；当前 DELETE 继续使用原期限收集响应。
    timer = setTimeout(() => {
      controller.abort();
      // 期限到期只发出取消要求，不能据此确认浏览器请求或远端副作用已停止。
      result.cleanupErrors.push(
        "DELETE 请求停止无法确认；已停止工作推进并继续独立资源清理，页面取消不证明远端撤销。",
      );
      rejectStop(new Error("DELETE 超过 30 秒总期限；移除结果未知，待核对。"));
    }, 30_000);
    let parsed: DeleteResponse = { kind: "unknown" };
    try {
      parsed = await Promise.race([
        deletePost(postId, controller.signal),
        stopped,
      ]);
    } catch (error) {
      result.status = signal.aborted ? "cancelled" : "failed";
      result.message = `Post 已保存，移除结果未知，待核对；归档未完成：${error instanceof Error ? error.message : String(error)}`;
      if (!(error instanceof RetryableRequestError) || signal.aborted) {
        result.fatalExecution = true;
        return;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (parsed.kind !== "removed") {
      result.status = parsed.kind === "blocked" ? "blocked" : "failed";
      result.message =
        parsed.kind === "blocked"
          ? `DELETE 被阻挡（HTTP ${parsed.status}）${parsed.retryAfter ? `；服务端建议等待 ${parsed.retryAfter}` : ""}；移除结果未知，待核对；Post 已保存，归档未完成。`
          : "DELETE 未取得认可响应；移除结果未知，待核对；Post 已保存，归档未完成。";
      if (parsed.kind === "unknown" && !signal.aborted) {
        try {
          await recoverDeletion(bound, true);
        } catch (error) {
          result.fatalExecution = true;
          result.message = `${result.message} 核对未完成；已停止：${error instanceof Error ? error.message : String(error)}`;
        }
      }
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
