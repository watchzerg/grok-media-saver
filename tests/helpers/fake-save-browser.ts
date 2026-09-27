import { mock } from "bun:test";
import { appendFileSync } from "node:fs";
import { parsePostDetailResponse } from "../../src/grok/adapter";

mock.module("../../src/browser/session.ts", () => ({
  connectBrowserSession: async (_url: string, requestStarted: () => void) => {
    let attempts = 0;
    return {
      getPostDetail: async (postId: string) => {
        requestStarted();
        attempts += 1;
        if (process.env.GMS_TEST_REQUEST_TIMES)
          appendFileSync(process.env.GMS_TEST_REQUEST_TIMES, `${Date.now()}\n`);
        if (process.env.GMS_TEST_ABORT_DETAIL === "1") {
          process.kill(process.pid, "SIGINT");
          await Bun.sleep(20);
        }
        return parsePostDetailResponse(postId, {
          status:
            process.env.GMS_TEST_BLOCKED === "1"
              ? 429
              : process.env.GMS_TEST_RETRY_DETAIL === "1" && attempts === 1
                ? 503
                : 200,
          contentType: "application/json",
          finalPath: "/rest/app-chat/conversations/fixture",
          retryAfter: process.env.GMS_TEST_BLOCKED === "1" ? "60" : undefined,
          body: {
            assetId: postId,
            key:
              process.env.GMS_TEST_VIDEO === "1"
                ? "https://videos.grok.com/source.mp4"
                : "https://assets.grok.com/source.png",
            mimeType:
              process.env.GMS_TEST_VIDEO === "1" ? "video/mp4" : "image/png",
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
              const image = Buffer.from(
                process.env.GMS_TEST_VIDEO === "1"
                  ? "000000186674797069736f6d0000000069736f6d"
                  : "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
                "hex",
              );
              await onResponse({
                status: 200,
                contentType:
                  process.env.GMS_TEST_VIDEO === "1"
                    ? "video/mp4"
                    : "image/png",
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
      close: async () => {},
      cleanupNotices: [],
    };
  },
}));
