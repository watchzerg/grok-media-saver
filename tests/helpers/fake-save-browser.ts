import { mock } from "bun:test";

mock.module("../../src/browser/session.ts", () => ({
  connectBrowserSession: async () => ({
    getPostDetail: async (postId: string) => ({
      kind: "post",
      selection: {
        assetId: postId,
        key: "https://imagine-public.x.ai/source.png",
        quality: "image",
        mimeType: "image/png",
      },
    }),
    close: async () => {},
    cleanupNotices: [],
  }),
}));
