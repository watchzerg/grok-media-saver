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
    let attempts = 0;
    let mediaAttempts = 0;
    const recordRequest = (kind: string, postId: string) => {
      requestStarted();
      if (process.env.GMS_TEST_REQUEST_EVENTS)
        appendFileSync(
          process.env.GMS_TEST_REQUEST_EVENTS,
          `${JSON.stringify({ kind, postId, at: Date.now() })}\n`,
        );
    };
    let currentPostId = "";
    return {
      getFirstPage: async () => {
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
      close: async () => {
        if (process.env.GMS_TEST_CLOSE_FAILURE === "1")
          throw new Error("simulated browser close failure");
      },
      cleanupNotices: [],
    };
  },
}));
