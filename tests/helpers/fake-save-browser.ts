import { mock } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parsePostDetailResponse,
  parseSavedPageResponse,
  RetryableRequestError,
} from "../../src/grok/adapter";

mock.module("../../src/browser/session.ts", () => ({
  connectBrowserSession: async (_url: string, requestStarted: () => void) => {
    const recordBrowser = (kind: string) => {
      if (process.env.GMS_TEST_BROWSER_EVENTS)
        appendFileSync(process.env.GMS_TEST_BROWSER_EVENTS, `${kind}\n`);
    };
    recordBrowser("connect");
    let attempts = 0;
    let mediaAttempts = 0;
    let connected = true;
    const recordRequest = (kind: string, postId: string) => {
      requestStarted();
      if (process.env.GMS_TEST_REQUEST_EVENTS)
        appendFileSync(
          process.env.GMS_TEST_REQUEST_EVENTS,
          `${JSON.stringify({ kind, postId, at: Date.now() })}\n`,
        );
    };
    let currentPostId = "";
    let mediaPageReady = false;
    return {
      prepareMediaPage: async (signal: AbortSignal) => {
        if (signal.aborted) throw new Error("媒体下载已停止。");
        mediaPageReady = true;
      },
      getFirstPage: async () => {
        mediaPageReady = true;
        recordRequest("page", "");
        const ids = (process.env.GMS_TEST_PAGE_IDS ?? "")
          .split(",")
          .filter(Boolean);
        return parseSavedPageResponse({
          status:
            process.env.GMS_TEST_PAGE_BLOCKED === "1"
              ? 429
              : Number(process.env.GMS_TEST_PAGE_STATUS ?? 200),
          contentType: "application/json",
          finalPath: "/rest/app-chat/saved",
          body: {
            assets: ids.map((assetId) => ({
              assetId,
              mimeType:
                process.env.GMS_TEST_VIDEO_ID === assetId
                  ? "video/mp4"
                  : "image/png",
            })),
            nextPageToken: "next-page-must-not-be-read",
          },
        });
      },
      getPostDetail: async (postId: string) => {
        mediaPageReady = true;
        currentPostId = postId;
        recordRequest("detail", postId);
        attempts += 1;
        if (process.env.GMS_TEST_DETAIL_IDS)
          appendFileSync(process.env.GMS_TEST_DETAIL_IDS, `${postId}\n`);
        if (process.env.GMS_TEST_REQUEST_TIMES)
          appendFileSync(process.env.GMS_TEST_REQUEST_TIMES, `${Date.now()}\n`);
        if (
          process.env.GMS_TEST_ABORT_DETAIL === "1" ||
          process.env.GMS_TEST_ABORT_DETAIL_ID === postId
        ) {
          process.kill(process.pid, "SIGINT");
          await Bun.sleep(20);
        }
        if (
          process.env.GMS_TEST_NETWORK_FAILURE_ID === postId ||
          (process.env.GMS_TEST_MEDIA_RETRY_DETAIL_FAILURE_ID === postId &&
            attempts > 1)
        )
          throw new RetryableRequestError("simulated detail network failure");
        const blocked =
          process.env.GMS_TEST_BLOCKED === "1" ||
          process.env.GMS_TEST_BLOCKED_ID === postId ||
          (process.env.GMS_TEST_MEDIA_RETRY_BLOCKED_ID === postId &&
            attempts > 1);
        return parsePostDetailResponse(postId, {
          status: blocked
            ? 429
            : process.env.GMS_TEST_UNAVAILABLE === "1" ||
                process.env.GMS_TEST_UNAVAILABLE_ID === postId
              ? 404
              : process.env.GMS_TEST_RETRY_DETAIL === "1" && attempts === 1
                ? 503
                : 200,
          contentType: "application/json",
          finalPath: "/rest/app-chat/conversations/fixture",
          retryAfter: blocked
            ? (process.env.GMS_TEST_RETRY_AFTER ?? "60")
            : undefined,
          body: {
            assetId: postId,
            key:
              process.env.GMS_TEST_VIDEO === "1" ||
              process.env.GMS_TEST_VIDEO_ID === postId
                ? "https://videos.grok.com/source.mp4"
                : "https://assets.grok.com/source.png",
            mimeType:
              process.env.GMS_TEST_VIDEO === "1" ||
              process.env.GMS_TEST_VIDEO_ID === postId
                ? "video/mp4"
                : "image/png",
          },
        });
      },
      ...(process.env.GMS_TEST_MEDIA === "1"
        ? {
            downloadMedia: async (
              _selection: unknown,
              onResponse: (headers: unknown) => Promise<void>,
              onChunk: (chunk: Uint8Array) => Promise<void>,
            ) => {
              if (!mediaPageReady)
                throw new Error("媒体请求需要已确认的 Post 页面。");
              recordRequest("media", currentPostId);
              mediaAttempts += 1;
              if (
                (process.env.GMS_TEST_RETRY_MEDIA_ID === currentPostId &&
                  mediaAttempts === 1) ||
                process.env.GMS_TEST_MEDIA_RETRY_DETAIL_FAILURE_ID ===
                  currentPostId ||
                process.env.GMS_TEST_MEDIA_RETRY_BLOCKED_ID === currentPostId
              ) {
                await onResponse({
                  status: 503,
                  contentType: "image/png",
                  contentLength: "1",
                  contentEncoding: null,
                });
                return;
              }
              const video = String(
                (_selection as { key?: string }).key ?? "",
              ).includes(".mp4");
              const image = Buffer.from(
                video
                  ? "000000186674797069736f6d0000000069736f6d"
                  : process.env.GMS_TEST_PNG_DECLARED_JPEG === "1"
                    ? "ffd8ffe000104a464946000101000001ffd9"
                    : "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
                "hex",
              );
              if (process.env.GMS_TEST_CONFLICT_ID === currentPostId) {
                const digest = new Bun.CryptoHasher("sha256")
                  .update(image)
                  .digest("hex");
                writeFileSync(
                  join(
                    process.env.GROK_ARCHIVE_DIR as string,
                    currentPostId,
                    `${digest}.${video ? "mp4" : "png"}`,
                  ),
                  "external conflict",
                );
              }
              await onResponse({
                status: 200,
                contentType: video ? "video/mp4" : "image/png",
                contentLength: String(image.length),
                contentEncoding: null,
              });
              if (process.env.GMS_TEST_ABORT_MEDIA === "1") {
                process.kill(process.pid, "SIGINT");
                await Bun.sleep(20);
              }
              await onChunk(image);
            },
          }
        : {}),
      checkPost: async (
        postId: string,
        signal: AbortSignal,
        beforeRequest: () => Promise<void>,
      ) => {
        mediaPageReady = true;
        await beforeRequest();
        recordRequest("check", postId);
        if (process.env.GMS_TEST_CHECK_DELAY_MS) {
          await new Promise<void>((resolve, reject) => {
            const abort = () => {
              clearTimeout(timer);
              reject(new Error("核对请求已停止"));
            };
            const timer = setTimeout(() => {
              signal.removeEventListener("abort", abort);
              resolve();
            }, Number(process.env.GMS_TEST_CHECK_DELAY_MS));
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
          });
        }
        return {
          status: Number(process.env.GMS_TEST_CHECK_STATUS ?? 503),
          contentType: "application/json",
          body: JSON.parse(process.env.GMS_TEST_CHECK_BODY ?? "{}"),
          finalUrl: `https://grok.com/rest/assets/${postId}`,
          method: "GET",
          redirected: false,
        };
      },
      deletePost: async (postId: string) => {
        recordRequest("delete", postId);
        if (process.env.GMS_TEST_DELETE_DELAY_MS)
          await Bun.sleep(Number(process.env.GMS_TEST_DELETE_DELAY_MS));
        return {
          status: Number(process.env.GMS_TEST_DELETE_STATUS ?? 200),
          contentType:
            process.env.GMS_TEST_DELETE_CONTENT_TYPE ?? "application/json",
          body: JSON.parse(process.env.GMS_TEST_DELETE_BODY ?? "{}"),
          finalUrl:
            process.env.GMS_TEST_DELETE_URL ??
            `https://grok.com/rest/assets/${postId}`,
          method: process.env.GMS_TEST_DELETE_METHOD ?? "DELETE",
          redirected: process.env.GMS_TEST_DELETE_REDIRECTED === "1",
          retryAfter: "60",
        };
      },
      isConnected: () => connected,
      closePage: async () => {
        mediaPageReady = false;
        recordBrowser("close-page");
        attempts = 0;
        mediaAttempts = 0;
        currentPostId = "";
        if (process.env.GMS_TEST_CLOSE_FAILURE === "1")
          throw new Error("simulated browser close failure");
      },
      close: async () => {
        recordBrowser("close");
        connected = false;
        if (
          process.env.GMS_TEST_CLOSE_FAILURE === "1" ||
          process.env.GMS_TEST_FINAL_CLOSE_FAILURE === "1"
        )
          throw new Error("simulated browser close failure");
      },
      cleanupNotices: [],
    };
  },
}));
