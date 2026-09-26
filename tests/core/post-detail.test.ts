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

test("inspect post does not treat auxiliary original-image media as the image root", async () => {
  expect(
    await inspectBody({
      assetId: postId,
      mimeType: "image/jpeg",
      auxKeys: { "original-image": "https://assets.grok.com/other.jpg" },
    }),
  ).toMatchObject({ status: "failed" });
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

test("inspect post uses the next quality only when the higher field is absent", async () => {
  expect(
    await inspectBody({
      assetId: postId,
      mimeType: "video/mp4",
      key: "https://videos.grok.com/base.mp4",
      hdKey: "https://videos.grok.com/720.mp4",
    }),
  ).toMatchObject({ status: "ok", selection: { quality: "720p" } });
  expect(
    await inspectBody({
      assetId: postId,
      mimeType: "video/mp4",
      key: "https://videos.grok.com/base.mp4",
    }),
  ).toMatchObject({ status: "ok", selection: { quality: "original" } });
});

test("inspect post resolves relative media keys against the approved media origin", async () => {
  expect(
    await inspectBody({
      assetId: postId,
      mimeType: "image/jpeg",
      key: "image/2026/09/example.jpg",
    }),
  ).toMatchObject({ status: "ok", selection: { quality: "image" } });
  expect(
    await inspectBody({
      assetId: postId,
      mimeType: "video/mp4",
      key: "video/base.mp4",
      hdKey: "video/720.mp4",
    }),
  ).toMatchObject({ status: "ok", selection: { quality: "720p" } });
});

test("inspect post rejects relative media keys that resolve outside supported HTTPS hosts", async () => {
  expect(
    await inspectBody({
      assetId: postId,
      mimeType: "image/jpeg",
      key: "//untrusted.example/image.jpg",
    }),
  ).toMatchObject({ status: "failed" });
});

test("inspect post calls only the requested detail, reports the selection, and closes", async () => {
  let detailCalls = 0;
  let closeCalls = 0;
  const result = await inspectPost(`  ${postId.toUpperCase()} `, {
    connect: async () => ({
      getPostDetail: async (requestedId) => {
        detailCalls += 1;
        return parsePostDetailResponse(requestedId, {
          status: 200,
          contentType: "application/json",
          body: {
            assetId: postId,
            mimeType: "video/mp4",
            key: "https://videos.grok.com/base.mp4",
          },
          finalPath: `/rest/assets/${postId}`,
        });
      },
      close: async () => {
        closeCalls += 1;
      },
    }),
  });
  expect(result).toMatchObject({
    status: "ok",
    selection: { assetId: postId, mimeType: "video/mp4", quality: "original" },
  });
  expect(detailCalls).toBe(1);
  expect(closeCalls).toBe(1);
});

test("inspect post distinguishes a blocked login from an ordinary not-found post", async () => {
  const inspect = (status: number, finalPath: string) =>
    inspectPost(postId, {
      connect: async () => ({
        getPostDetail: async () =>
          parsePostDetailResponse(postId, {
            status,
            contentType: "text/html",
            body: null,
            finalPath,
          }),
        close: async () => {},
      }),
    });
  expect(await inspect(404, `/rest/assets/${postId}`)).toMatchObject({
    status: "failed",
  });
  expect(await inspect(403, `/rest/assets/${postId}`)).toMatchObject({
    status: "failed",
  });
  expect(await inspect(403, "/login")).toMatchObject({ status: "blocked" });
});

test("inspect post retries one temporary detail response after scheduler approval", async () => {
  let calls = 0;
  let waits = 0;
  const result = await inspectPost(postId, {
    connect: async () => ({
      getPostDetail: async () => {
        calls += 1;
        return calls === 1
          ? { kind: "temporary", status: 503 }
          : {
              kind: "post",
              selection: {
                assetId: postId,
                mimeType: "image/jpeg",
                quality: "image",
              },
            };
      },
      close: async () => {},
    }),
    waitBeforeRetry: async () => {
      waits += 1;
    },
  });
  expect(result.status).toBe("ok");
  expect(calls).toBe(2);
  expect(waits).toBe(1);
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
