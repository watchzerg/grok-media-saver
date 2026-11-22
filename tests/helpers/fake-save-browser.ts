import { mock } from "bun:test";
import { appendFileSync } from "node:fs";
import {
  parsePostDetailResponse,
  parseSavedPageResponse,
} from "../../src/grok/adapter";

mock.module("../../src/browser/session.ts", () => ({
  connectBrowserSession: async (_url: string, requestStarted: () => void) => {
    const recordBrowser = (kind: string) => {
      if (process.env.GMS_TEST_BROWSER_EVENTS)
        appendFileSync(process.env.GMS_TEST_BROWSER_EVENTS, `${kind}\n`);
    };
    recordBrowser("connect");
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
          status: 200,
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
        if (process.env.GMS_TEST_DETAIL_IDS)
          appendFileSync(process.env.GMS_TEST_DETAIL_IDS, `${postId}\n`);
        if (process.env.GMS_TEST_REQUEST_TIMES)
          appendFileSync(process.env.GMS_TEST_REQUEST_TIMES, `${Date.now()}\n`);
        if (process.env.GMS_TEST_ABORT_DETAIL_ID === postId) {
          process.kill(process.pid, "SIGINT");
          await Bun.sleep(20);
        }
        const blocked = process.env.GMS_TEST_BLOCKED_ID === postId;
        const video = process.env.GMS_TEST_VIDEO_ID === postId;
        return parsePostDetailResponse(postId, {
          status: blocked
            ? 429
            : process.env.GMS_TEST_UNAVAILABLE === "1" ||
                process.env.GMS_TEST_UNAVAILABLE_ID === postId
              ? 404
              : 200,
          contentType: "application/json",
          finalPath: "/rest/app-chat/conversations/fixture",
          retryAfter: blocked ? "60" : undefined,
          body: {
            assetId: postId,
            key: video
              ? "https://videos.grok.com/source.mp4"
              : "https://assets.grok.com/source.png",
            mimeType: video ? "video/mp4" : "image/png",
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
              const video = String(
                (_selection as { key?: string }).key ?? "",
              ).includes(".mp4");
              const image = Buffer.from(
                video
                  ? "000000186674797069736f6d0000000069736f6d"
                  : "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
                "hex",
              );
              await onResponse({
                status: 200,
                contentType: video ? "video/mp4" : "image/png",
                contentLength: String(image.length),
                contentEncoding: null,
              });
              await onChunk(image);
            },
          }
        : {}),
      checkPost: async (
        postId: string,
        _signal: AbortSignal,
        beforeRequest: () => Promise<void>,
      ) => {
        mediaPageReady = true;
        await beforeRequest();
        recordRequest("check", postId);
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
          status: 200,
          contentType: "application/json",
          body: {},
          finalUrl: `https://grok.com/rest/assets/${postId}`,
          method: "DELETE",
          redirected: false,
          retryAfter: "60",
        };
      },
      isConnected: () => connected,
      closePage: async () => {
        mediaPageReady = false;
        recordBrowser("close-page");
        currentPostId = "";
      },
      close: async () => {
        recordBrowser("close");
        connected = false;
      },
      cleanupNotices: [],
    };
  },
}));
