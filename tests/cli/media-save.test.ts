import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeProjectDatabase,
  saveSelectedPost,
  verifySavedPost,
} from "../../src/application-runtime";
import {
  readDatabaseConfig,
  readSaveConfig,
  readVerifyConfig,
} from "../../src/config";
import { UnconfirmedStopError } from "../../src/grok/adapter";
import { databaseEnv, testSql, useIsolatedPostgres } from "../helpers/postgres";

useIsolatedPostgres();
const postId = "123e4567-e89b-42d3-a456-426614174000";
const png = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
  "hex",
);
let archiveRoot: string | undefined;

afterEach(async () => {
  if (archiveRoot) await rm(archiveRoot, { recursive: true, force: true });
  archiveRoot = undefined;
});

async function setup() {
  await testSql`DROP TABLE IF EXISTS media_versions, post_work, runs CASCADE`;
  expect(
    (await initializeProjectDatabase(readDatabaseConfig(databaseEnv))).status,
  ).toBe("ok");
  archiveRoot = await mkdtemp(join(tmpdir(), "gms-media-save-"));
  return readSaveConfig({
    ...databaseEnv,
    GROK_ARCHIVE_DIR: archiveRoot,
    PLAYWRIGHT_MCP_EXTENSION_TOKEN: "fixture-token",
    GROK_API_INTERVAL_MIN_SECONDS: "0",
    GROK_API_INTERVAL_MAX_SECONDS: "0",
  });
}

test("S1 saves a complete selected image through the download capability", async () => {
  const config = await setup();
  const result = await saveSelectedPost(
    config,
    postId,
    new AbortController().signal,
    undefined,
    async () => ({
      getPostDetail: async () => ({
        kind: "post",
        selection: {
          assetId: postId,
          key: "https://assets.grok.com/image.png",
          mimeType: "image/png",
          quality: "image",
          expectedBytes: png.length,
        },
      }),
      downloadMedia: async (_selection, onResponse, onChunk) => {
        await onResponse({
          status: 200,
          contentType: "image/png",
          contentLength: String(png.length),
          contentEncoding: "identity",
        });
        await onChunk(png);
      },
      close: async () => {},
    }),
  );
  expect(result.status, result.message).toBe("ok");
  expect(
    (
      await verifySavedPost(
        readVerifyConfig({
          ...databaseEnv,
          GROK_ARCHIVE_DIR: config.archiveRoot,
        }),
        postId,
      )
    ).status,
  ).toBe("ok");
  const [work] = await testSql<
    { status: string }[]
  >`SELECT status FROM post_work WHERE post_id = ${postId}`;
  expect(work?.status).toBe("saved");
});

test("S1 reports an unowned connect.html notice without turning a committed save into cleanup failure", async () => {
  const config = await setup();
  const result = await saveSelectedPost(
    config,
    postId,
    new AbortController().signal,
    undefined,
    async () => ({
      getPostDetail: async () => ({
        kind: "post",
        selection: {
          assetId: postId,
          key: "https://assets.grok.com/image.png",
          mimeType: "image/png",
          quality: "image",
        },
      }),
      downloadMedia: async (_selection, onResponse, onChunk) => {
        await onResponse({
          status: 200,
          contentType: "image/png",
          contentLength: String(png.length),
          contentEncoding: null,
        });
        await onChunk(png);
      },
      close: async () => {},
      cleanupNotices: ["Extension connect.html 归属无法确认，已保留。"],
    }),
  );
  expect(result.status).toBe("ok");
  expect(result.saveRecorded).toBe(true);
  expect(result.cleanupErrors).toEqual([]);
  expect(result.message).toContain("connect.html");
});

test("S1 reports a real browser close failure while retaining the committed save", async () => {
  const config = await setup();
  const result = await saveSelectedPost(
    config,
    postId,
    new AbortController().signal,
    undefined,
    async () => ({
      getPostDetail: async () => ({
        kind: "post",
        selection: {
          assetId: postId,
          key: "https://assets.grok.com/image.png",
          mimeType: "image/png",
          quality: "image",
        },
      }),
      downloadMedia: async (_selection, onResponse, onChunk) => {
        await onResponse({
          status: 200,
          contentType: "image/png",
          contentLength: String(png.length),
          contentEncoding: null,
        });
        await onChunk(png);
      },
      close: async () => {
        throw new Error("fixture close failed");
      },
    }),
  );
  expect(result.status).toBe("failed");
  expect(result.saveRecorded).toBe(true);
  expect(result.cleanupErrors[0]).toContain("fixture close failed");
  expect(
    (
      await verifySavedPost(
        readVerifyConfig({
          ...databaseEnv,
          GROK_ARCHIVE_DIR: config.archiveRoot,
        }),
        postId,
      )
    ).status,
  ).toBe("ok");
});

test("S1 retries a truncated response after rereading detail, then commits only the complete image", async () => {
  const config = await setup();
  let details = 0;
  let transfers = 0;
  const result = await saveSelectedPost(
    config,
    postId,
    new AbortController().signal,
    undefined,
    async () => ({
      getPostDetail: async () => {
        details += 1;
        return {
          kind: "post",
          selection: {
            assetId: postId,
            key: `https://assets.grok.com/image-${details}.png`,
            mimeType: "image/png",
            quality: "image",
          },
        } as const;
      },
      downloadMedia: async (_selection, onResponse, onChunk) => {
        transfers += 1;
        await onResponse({
          status: 200,
          contentType: "image/png",
          contentLength: String(png.length),
          contentEncoding: null,
        });
        await onChunk(transfers === 1 ? png.subarray(0, 12) : png);
      },
      close: async () => {},
    }),
  );
  expect(result.status, result.message).toBe("ok");
  expect({ details, transfers }).toEqual({ details: 2, transfers: 2 });
  const [work] = await testSql<
    { status: string; selected_key: string }[]
  >`SELECT status, selected_key FROM post_work WHERE post_id = ${postId}`;
  expect(work?.status).toBe("saved");
  expect(work?.selected_key).toContain("image-2");
});

test("S1 times out a stalled first file write and cleans the owned fragment", async () => {
  const config = await setup();
  config.mediaNoProgressTimeoutSeconds = 0.02;
  const probe = await open(join(config.archiveRoot, "write-probe"), "w");
  const write = spyOn(Object.getPrototypeOf(probe), "write").mockImplementation(
    () => new Promise(() => {}),
  );
  await probe.close();
  let transfers = 0;
  try {
    const result = await saveSelectedPost(
      config,
      postId,
      new AbortController().signal,
      undefined,
      async () => ({
        getPostDetail: async () => ({
          kind: "post",
          selection: {
            assetId: postId,
            key: "https://assets.grok.com/image.png",
            mimeType: "image/png",
            quality: "image",
          },
        }),
        downloadMedia: async (_selection, onResponse, onChunk) => {
          transfers += 1;
          await onResponse({
            status: 200,
            contentType: "image/png",
            contentLength: String(png.length),
            contentEncoding: null,
          });
          await onChunk(png);
        },
        close: async () => {},
      }),
    );
    expect(result.status).toBe("failed");
    expect(result.message).toContain("没有进展");
    expect(transfers).toBe(2);
    expect(
      await (await import("node:fs/promises")).readdir(
        join(config.archiveRoot, postId),
      ),
    ).toEqual([]);
  } finally {
    write.mockRestore();
  }
});

test("S1 stops retrying and reports an unconfirmed file close", async () => {
  const config = await setup();
  const probe = await open(join(config.archiveRoot, "close-probe"), "w");
  const realClose = probe.close;
  await probe.close();
  let transfers = 0;
  const failingClose = spyOn(
    Object.getPrototypeOf(probe),
    "close",
  ).mockImplementation(async function (this: typeof probe) {
    await realClose.call(this);
    throw new Error("fixture close failed");
  });
  try {
    const result = await saveSelectedPost(
      config,
      postId,
      new AbortController().signal,
      undefined,
      async () => ({
        getPostDetail: async () => ({
          kind: "post",
          selection: {
            assetId: postId,
            key: "https://assets.grok.com/image.png",
            mimeType: "image/png",
            quality: "image",
          },
        }),
        downloadMedia: async (_selection, onResponse) => {
          transfers += 1;
          await onResponse({
            status: 503,
            contentType: "text/plain",
            contentLength: null,
            contentEncoding: null,
          });
        },
        close: async () => {},
      }),
    );
    expect(result.status).toBe("failed");
    expect(result.message).toContain("关闭失败");
    expect(transfers).toBe(1);
  } finally {
    failingClose.mockRestore();
  }
});

test.each([
  [
    "missing length",
    {
      status: 200,
      contentType: "image/png",
      contentLength: null,
      contentEncoding: null,
    },
    png,
  ],
  [
    "wrong type",
    {
      status: 200,
      contentType: "text/html",
      contentLength: String(png.length),
      contentEncoding: null,
    },
    png,
  ],
  [
    "bad signature",
    {
      status: 200,
      contentType: "image/png",
      contentLength: String(png.length),
      contentEncoding: null,
    },
    Buffer.alloc(png.length),
  ],
] as const)(
  "S1 refuses %s after two bounded transfers",
  async (_label, headers, payload) => {
    const config = await setup();
    let transfers = 0;
    const result = await saveSelectedPost(
      config,
      postId,
      new AbortController().signal,
      undefined,
      async () => ({
        getPostDetail: async () => ({
          kind: "post",
          selection: {
            assetId: postId,
            key: "https://assets.grok.com/image.png",
            mimeType: "image/png",
            quality: "image",
          },
        }),
        downloadMedia: async (_selection, onResponse, onChunk) => {
          transfers += 1;
          await onResponse(headers);
          await onChunk(payload);
        },
        close: async () => {},
      }),
    );
    expect(result.status).toBe("failed");
    expect(transfers).toBe(2);
    const [work] = await testSql<
      { status: string; publish_sha256: string | null }[]
    >`SELECT status, publish_sha256 FROM post_work WHERE post_id = ${postId}`;
    expect(work).toEqual({ status: "failed", publish_sha256: null });
    expect(
      (await import("node:fs/promises"))
        .readdir(join(config.archiveRoot, postId))
        .then((names) => names.length),
    ).resolves.toBe(0);
  },
);

test("S1 stops after a blocked media response without retry or publication", async () => {
  const config = await setup();
  let transfers = 0;
  const result = await saveSelectedPost(
    config,
    postId,
    new AbortController().signal,
    undefined,
    async () => ({
      getPostDetail: async () => ({
        kind: "post",
        selection: {
          assetId: postId,
          key: "https://assets.grok.com/image.png",
          mimeType: "image/png",
          quality: "image",
        },
      }),
      downloadMedia: async (_selection, onResponse) => {
        transfers += 1;
        await onResponse({
          status: 429,
          contentType: "text/html",
          contentLength: null,
          contentEncoding: null,
        });
      },
      close: async () => {},
    }),
  );
  expect(result.status).toBe("blocked");
  expect(transfers).toBe(1);
  const [work] = await testSql<
    { status: string; publish_sha256: string | null }[]
  >`SELECT status, publish_sha256 FROM post_work WHERE post_id = ${postId}`;
  expect(work).toEqual({ status: "pending", publish_sha256: null });
});

test.each(["first-byte", "no-progress"] as const)(
  "S1 %s timeout stops the transfer before a bounded retry",
  async (phase) => {
    const config = await setup();
    config.mediaFirstByteTimeoutSeconds = 0.01;
    config.mediaNoProgressTimeoutSeconds = 0.01;
    let transfers = 0;
    const result = await saveSelectedPost(
      config,
      postId,
      new AbortController().signal,
      undefined,
      async () => ({
        getPostDetail: async () => ({
          kind: "post",
          selection: {
            assetId: postId,
            key: "https://assets.grok.com/image.png",
            mimeType: "image/png",
            quality: "image",
          },
        }),
        downloadMedia: async (_selection, onResponse, onChunk, signal) => {
          transfers += 1;
          await onResponse({
            status: 200,
            contentType: "image/png",
            contentLength: String(png.length),
            contentEncoding: null,
          });
          if (phase === "no-progress") await onChunk(png.subarray(0, 12));
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        },
        close: async () => {},
      }),
    );
    expect(result.status).toBe("failed");
    expect(transfers).toBe(2);
    const names = await (await import("node:fs/promises")).readdir(
      join(config.archiveRoot, postId),
    );
    expect(names).toEqual([]);
  },
);

test("S1 does not retry when timeout cannot confirm the browser request stopped", async () => {
  const config = await setup();
  config.mediaFirstByteTimeoutSeconds = 0.01;
  let transfers = 0;
  const result = await saveSelectedPost(
    config,
    postId,
    new AbortController().signal,
    undefined,
    async () => ({
      getPostDetail: async () => ({
        kind: "post",
        selection: {
          assetId: postId,
          key: "https://assets.grok.com/image.png",
          mimeType: "image/png",
          quality: "image",
        },
      }),
      downloadMedia: async (_selection, onResponse, _onChunk, signal) => {
        transfers += 1;
        await onResponse({
          status: 200,
          contentType: "image/png",
          contentLength: String(png.length),
          contentEncoding: null,
        });
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        throw new UnconfirmedStopError("fixture: page close did not finish");
      },
      close: async () => {},
    }),
  );
  expect(result.status).toBe("failed");
  expect(transfers).toBe(1);
  expect(result.message).toContain("page close did not finish");
});

test("S1 removes its verified temp when stopped before committing the publish intent", async () => {
  const config = await setup();
  const controller = new AbortController();
  const result = await saveSelectedPost(
    config,
    postId,
    controller.signal,
    (stage) => {
      if (stage.startsWith("媒体临时文件重读核验通过")) controller.abort();
    },
    async () => ({
      getPostDetail: async () => ({
        kind: "post",
        selection: {
          assetId: postId,
          key: "https://assets.grok.com/image.png",
          mimeType: "image/png",
          quality: "image",
        },
      }),
      downloadMedia: async (_selection, onResponse, onChunk) => {
        await onResponse({
          status: 200,
          contentType: "image/png",
          contentLength: String(png.length),
          contentEncoding: null,
        });
        await onChunk(png);
      },
      close: async () => {},
    }),
  );
  expect(result.status).toBe("cancelled");
  const [work] = await testSql<
    { status: string; publish_sha256: string | null }[]
  >`SELECT status, publish_sha256 FROM post_work WHERE post_id = ${postId}`;
  expect(work).toEqual({ status: "pending", publish_sha256: null });
  expect(
    await (await import("node:fs/promises")).readdir(
      join(config.archiveRoot, postId),
    ),
  ).toEqual([]);
});

test.each([
  ["complete", "0", 0, "saved"],
  ["SIGINT", "1", 130, "pending"],
] as const)(
  "S2 real CLI %s media transfer reports exit and durable fact",
  async (_label, abort, expectedExit, expectedStatus) => {
    const config = await setup();
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--preload",
        "./tests/helpers/fake-save-browser.ts",
        "src/cli.ts",
        "save",
        "post",
        postId,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...databaseEnv,
          GROK_ARCHIVE_DIR: config.archiveRoot,
          PLAYWRIGHT_MCP_EXTENSION_TOKEN: "fixture-token",
          GROK_API_INTERVAL_MIN_SECONDS: "0",
          GROK_API_INTERVAL_MAX_SECONDS: "0",
          GMS_TEST_MEDIA: "1",
          GMS_TEST_ABORT_MEDIA: abort,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit, `${stdout}\n${stderr}`).toBe(expectedExit);
    const [work] = await testSql<
      { status: string }[]
    >`SELECT status FROM post_work WHERE post_id = ${postId}`;
    expect(work?.status).toBe(expectedStatus);
    if (expectedExit === 0)
      expect(
        (
          await verifySavedPost(
            readVerifyConfig({
              ...databaseEnv,
              GROK_ARCHIVE_DIR: config.archiveRoot,
            }),
            postId,
          )
        ).status,
      ).toBe("ok");
    else expect(stderr).toContain("停止");
  },
);
