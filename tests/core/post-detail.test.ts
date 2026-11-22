import { expect, test } from "bun:test";
import { inspectPost } from "../../src/application";
import { parsePostDetailResponse } from "../../src/grok/adapter";

const postId = "123e4567-e89b-42d3-a456-426614174000";

function inspectBody(body: unknown) {
  return inspectPost(postId, {
    connect: async () => ({
      getPostDetail: async (requestedId) =>
        parsePostDetailResponse(requestedId, {
          status: 200,
          contentType: "application/json",
          body,
          finalPath: `/rest/assets/${requestedId}`,
        }),
      close: async () => {},
    }),
  });
}

test("inspect post requires a matching identity and selects the image root key", async () => {
  expect(
    await inspectBody({
      assetId: postId,
      mimeType: "image/jpeg",
      key: "https://assets.grok.com/image.jpg",
      auxKeys: { "original-image": "https://assets.grok.com/other.jpg" },
    }),
  ).toMatchObject({
    status: "ok",
    selection: { assetId: postId, mimeType: "image/jpeg", quality: "image" },
  });
});

test("inspect post rejects a mismatched identity and unknown wrappers", async () => {
  expect(
    await inspectBody({
      assetId: "ffffffff-0000-0000-0000-000000000001",
      mimeType: "image/jpeg",
      key: "https://assets.grok.com/a.jpg",
    }),
  ).toMatchObject({ status: "failed" });
  expect(
    await inspectBody({
      assetDetail: {
        assetId: postId,
        mimeType: "image/jpeg",
        key: "https://assets.grok.com/a.jpg",
      },
    }),
  ).toMatchObject({ status: "failed" });
});

test("inspect post selects the highest present quality and fails malformed higher candidates", async () => {
  expect(
    await inspectBody({
      assetId: postId,
      mimeType: "video/mp4",
      key: "https://videos.grok.com/base.mp4",
      hdKey: "https://videos.grok.com/720.mp4",
      hd1080Key: "https://videos.grok.com/1080.mp4",
    }),
  ).toMatchObject({
    status: "ok",
    selection: { assetId: postId, mimeType: "video/mp4", quality: "1080p" },
  });
  expect(
    await inspectBody({
      assetId: postId,
      mimeType: "video/mp4",
      key: "https://videos.grok.com/base.mp4",
      hd1080Key: null,
    }),
  ).toMatchObject({ status: "failed" });
});

test("inspect post rejects an invalid ID before connecting", async () => {
  let connectCalls = 0;
  const result = await inspectPost("https://grok.com/imagine/post/123", {
    connect: async () => {
      connectCalls += 1;
      throw new Error("must not connect");
    },
  });
  expect(result.status).toBe("failed");
  expect(connectCalls).toBe(0);
});
