import { mock } from "bun:test";
import { parsePostDetailResponse } from "../../src/grok/adapter";

mock.module("../../src/browser/session.ts", () => ({
  connectBrowserSession: async () => ({
    getPostDetail: async (postId: string) =>
      parsePostDetailResponse(postId, {
        status: process.env.GMS_TEST_BLOCKED === "1" ? 429 : 200,
        contentType: "application/json",
        finalPath: "/rest/app-chat/conversations/fixture",
        retryAfter: process.env.GMS_TEST_BLOCKED === "1" ? "60" : undefined,
        body: {
          assetId: postId,
          key: "https://assets.grok.com/source.png",
          mimeType: "image/png",
        },
      }),
    close: async () => {},
    cleanupNotices: [],
  }),
}));
