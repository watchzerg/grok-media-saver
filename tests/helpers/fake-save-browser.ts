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
            key: "https://assets.grok.com/source.png",
            mimeType: "image/png",
          },
        });
      },
      close: async () => {},
      cleanupNotices: [],
    };
  },
}));
