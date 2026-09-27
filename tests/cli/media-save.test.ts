import { afterEach, expect, spyOn, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
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
import {
  parsePostDetailResponse,
  UnconfirmedStopError,
} from "../../src/grok/adapter";
import { databaseEnv, testSql, useIsolatedPostgres } from "../helpers/postgres";

useIsolatedPostgres();
const postId = "123e4567-e89b-42d3-a456-426614174000";
const png = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
  "hex",
);
const mislabeledJpeg = Buffer.from(
  "ffd8ffe000104a464946000101000001ffd9",
  "hex",
);
const mp4 = Buffer.from("000000186674797069736f6d0000000069736f6d", "hex");
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

test("S1 saves a PNG-declared JPEG as JPEG and reuses that version", async () => {
  const config = await setup();
  let downloads = 0;
  const connect = async () => ({
    getPostDetail: async () => ({
      kind: "post" as const,
      selection: {
        assetId: postId,
        key: "https://assets.grok.com/image.jpg",
        mimeType: "image/png",
        quality: "image" as const,
        expectedBytes: mislabeledJpeg.length,
      },
    }),
    downloadMedia: async (
      _selection: unknown,
      onResponse: (headers: {
        status: number;
        contentType: string;
        contentLength: string;
        contentEncoding: null;
      }) => Promise<void>,
      onChunk: (chunk: Uint8Array) => Promise<void>,
    ) => {
      downloads += 1;
      await onResponse({
        status: 200,
        contentType: "image/png",
        contentLength: String(mislabeledJpeg.length),
        contentEncoding: null,
      });
      await onChunk(mislabeledJpeg);
    },
    close: async () => {},
  });
  const first = await saveSelectedPost(
    config,
    postId,
    new AbortController().signal,
    undefined,
    connect,
  );
  expect(first.status, first.message).toBe("ok");
  const [saved] = await testSql<
    { workMimeType: string; versionMimeType: string; relativePath: string }[]
  >`
    SELECT w.mime_type AS "workMimeType", v.mime_type AS "versionMimeType",
      v.relative_path AS "relativePath"
    FROM post_work w JOIN media_versions v ON v.id = w.saved_media_version_id
    WHERE w.post_id = ${postId}
  `;
  expect(saved.workMimeType).toBe("image/jpeg");
  expect(saved.versionMimeType).toBe("image/jpeg");
  expect(saved.relativePath).toEndWith(".jpg");
  expect(await readFile(join(config.archiveRoot, saved.relativePath))).toEqual(
    mislabeledJpeg,
  );
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
  const second = await saveSelectedPost(
    config,
    postId,
    new AbortController().signal,
    undefined,
    connect,
  );
  expect(second.status, second.message).toBe("ok");
  expect(second.message).toContain("复用");
  expect(downloads).toBe(1);
});

test("S1 explicit save rereads a saved Post and reuses a verified version", async () => {
  const config = await setup();
  let details = 0;
  let downloads = 0;
  let expectedBytes = png.length;
  const connect = async () => ({
    getPostDetail: async () => {
      details += 1;
      return {
        kind: "post" as const,
        selection: {
          assetId: postId,
          key: "https://assets.grok.com/image.png",
          mimeType: "image/png",
          quality: "image" as const,
          expectedBytes,
        },
      };
    },
    downloadMedia: async (
      _selection: unknown,
      onResponse: (response: {
        status: number;
        contentType: string;
        contentLength: string;
        contentEncoding: string;
      }) => Promise<void>,
      onChunk: (chunk: Uint8Array) => Promise<void>,
    ) => {
      downloads += 1;
      await onResponse({
        status: 200,
        contentType: "image/png",
        contentLength: String(png.length),
        contentEncoding: "identity",
      });
      await onChunk(png);
    },
    close: async () => {},
  });
  const first = await saveSelectedPost(
    config,
    postId,
    new AbortController().signal,
    undefined,
    connect,
  );
  const [firstWork] = await testSql<{ last_run_id: string }[]>`
    SELECT last_run_id::text FROM post_work WHERE post_id = ${postId}
  `;
  const second = await saveSelectedPost(
    config,
    postId,
    new AbortController().signal,
    undefined,
    connect,
  );
  expect(first.status).toBe("ok");
  expect(second.status).toBe("ok");
  expect(second.message).toContain("复用");
  expect(details).toBe(2);
  expect(downloads).toBe(1);
  const [counts] = await testSql<{ runs: number; versions: number }[]>`
    SELECT (SELECT count(*)::integer FROM runs) AS runs,
      (SELECT count(*)::integer FROM media_versions) AS versions
  `;
  expect(counts).toEqual({ runs: 2, versions: 1 });
  const [latest] = await testSql<{ last_run_id: string }[]>`
    SELECT last_run_id::text FROM post_work WHERE post_id = ${postId}
  `;
  expect(latest?.last_run_id).toBeTruthy();
  expect(latest?.last_run_id).not.toBe(firstWork?.last_run_id);
  expectedBytes += 1;
  const conflicting = await saveSelectedPost(
    config,
    postId,
    new AbortController().signal,
    undefined,
    connect,
  );
  expect(conflicting.status).toBe("failed");
  expect(details).toBeGreaterThan(2);
  expect(downloads).toBeGreaterThan(1);
  const [preserved] = await testSql<
    { versions: number; saved_version: string }[]
  >`
    SELECT (SELECT count(*)::integer FROM media_versions) AS versions,
      saved_media_version_id::text AS saved_version
    FROM post_work WHERE post_id = ${postId}
  `;
  expect(preserved?.versions).toBe(1);
  expect(preserved?.saved_version).toBeTruthy();
});

test("S1 changed source reuses equal content and keeps a distinct older version", async () => {
  const config = await setup();
  const changed = Buffer.concat([png, Buffer.from([1])]);
  let key = "https://assets.grok.com/first.png";
  let bytes = png;
  let downloads = 0;
  let failDownload = false;
  const connect = async () => ({
    getPostDetail: async () => ({
      kind: "post" as const,
      selection: {
        assetId: postId,
        key,
        mimeType: "image/png",
        quality: "image" as const,
        expectedBytes: bytes.length,
      },
    }),
    downloadMedia: async (
      _selection: unknown,
      onResponse: (response: {
        status: number;
        contentType: string;
        contentLength: string;
        contentEncoding: string;
      }) => Promise<void>,
      onChunk: (chunk: Uint8Array) => Promise<void>,
    ) => {
      downloads += 1;
      await onResponse({
        status: failDownload ? 404 : 200,
        contentType: "image/png",
        contentLength: String(bytes.length),
        contentEncoding: "identity",
      });
      await onChunk(bytes);
    },
    close: async () => {},
  });
  const save = () =>
    saveSelectedPost(
      config,
      postId,
      new AbortController().signal,
      undefined,
      connect,
    );
  expect((await save()).status).toBe("ok");
  const [first] = await testSql<
    { id: string; relative_path: string }[]
  >`SELECT id::text, relative_path FROM media_versions WHERE post_id = ${postId}`;
  if (!first) throw new Error("初次版本缺失");

  key = "https://assets.grok.com/same-content.png";
  expect((await save()).status).toBe("ok");
  const [same] = await testSql<
    { selected_key: string; saved_media_version_id: string; versions: number }[]
  >`SELECT selected_key, saved_media_version_id::text,
    (SELECT count(*)::integer FROM media_versions WHERE post_id = ${postId}) AS versions
    FROM post_work WHERE post_id = ${postId}`;
  expect(same).toEqual({
    selected_key: key,
    saved_media_version_id: first.id,
    versions: 1,
  });
  expect(downloads).toBe(2);

  key = "https://assets.grok.com/new-content.png";
  bytes = changed;
  expect((await save()).status).toBe("ok");
  const [current] = await testSql<
    { selected_key: string; saved_media_version_id: string; versions: number }[]
  >`SELECT selected_key, saved_media_version_id::text,
    (SELECT count(*)::integer FROM media_versions WHERE post_id = ${postId}) AS versions
    FROM post_work WHERE post_id = ${postId}`;
  expect(current?.selected_key).toBe(key);
  expect(current?.saved_media_version_id).not.toBe(first.id);
  expect(current?.versions).toBe(2);
  expect(downloads).toBe(3);
  expect(await readFile(join(config.archiveRoot, first.relative_path))).toEqual(
    png,
  );
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

  key = "https://assets.grok.com/unavailable.png";
  failDownload = true;
  expect((await save()).status).toBe("failed");
  const [failed] = await testSql<
    { status: string; saved_media_version_id: string; versions: number }[]
  >`SELECT status, saved_media_version_id::text,
    (SELECT count(*)::integer FROM media_versions WHERE post_id = ${postId}) AS versions
    FROM post_work WHERE post_id = ${postId}`;
  expect(failed).toEqual({
    status: "failed",
    saved_media_version_id: current?.saved_media_version_id,
    versions: 2,
  });
  expect(await readFile(join(config.archiveRoot, first.relative_path))).toEqual(
    png,
  );
});

test("S1 higher quality rereads and redownloads even when bytes match", async () => {
  const config = await setup();
  let quality: "original" | "720p" = "original";
  let downloads = 0;
  const connect = async () => ({
    getPostDetail: async () => ({
      kind: "post" as const,
      selection: {
        assetId: postId,
        key:
          quality === "original"
            ? "https://videos.grok.com/original.mp4"
            : "https://videos.grok.com/hd.mp4",
        mimeType: "video/mp4",
        quality,
        expectedBytes: mp4.length,
      },
    }),
    downloadMedia: async (
      _selection: unknown,
      onResponse: (response: {
        status: number;
        contentType: string;
        contentLength: string;
        contentEncoding: string;
      }) => Promise<void>,
      onChunk: (chunk: Uint8Array) => Promise<void>,
    ) => {
      downloads += 1;
      await onResponse({
        status: 200,
        contentType: "video/mp4",
        contentLength: String(mp4.length),
        contentEncoding: "identity",
      });
      await onChunk(mp4);
    },
    close: async () => {},
  });
  const save = () =>
    saveSelectedPost(
      config,
      postId,
      new AbortController().signal,
      undefined,
      connect,
    );
  expect((await save()).status).toBe("ok");
  quality = "720p";
  expect((await save()).status).toBe("ok");
  const [work] = await testSql<
    { quality: string; versions: number }[]
  >`SELECT quality,
    (SELECT count(*)::integer FROM media_versions WHERE post_id = ${postId}) AS versions
    FROM post_work WHERE post_id = ${postId}`;
  expect(work).toEqual({ quality: "720p", versions: 1 });
  expect(downloads).toBe(2);
});

test.each(["missing", "corrupt"] as const)(
  "S1 saved file %s follows download and preserves the existing version",
  async (condition) => {
    const config = await setup();
    let downloads = 0;
    const connect = async () => ({
      getPostDetail: async () => ({
        kind: "post" as const,
        selection: {
          assetId: postId,
          key: "https://assets.grok.com/image.png",
          mimeType: "image/png",
          quality: "image" as const,
          expectedBytes: png.length,
        },
      }),
      downloadMedia: async (
        _selection: unknown,
        onResponse: (response: {
          status: number;
          contentType: string;
          contentLength: string;
          contentEncoding: string;
        }) => Promise<void>,
        onChunk: (chunk: Uint8Array) => Promise<void>,
      ) => {
        downloads += 1;
        await onResponse({
          status: 200,
          contentType: "image/png",
          contentLength: String(png.length),
          contentEncoding: "identity",
        });
        await onChunk(png);
      },
      close: async () => {},
    });
    expect(
      (
        await saveSelectedPost(
          config,
          postId,
          new AbortController().signal,
          undefined,
          connect,
        )
      ).status,
    ).toBe("ok");
    const [version] = await testSql<
      { relative_path: string }[]
    >`SELECT relative_path FROM media_versions WHERE post_id = ${postId}`;
    if (!version) throw new Error("版本记录缺失");
    const target = join(config.archiveRoot, version.relative_path);
    if (condition === "missing") await rm(target);
    else await writeFile(target, Buffer.alloc(png.length, 0));
    const second = await saveSelectedPost(
      config,
      postId,
      new AbortController().signal,
      undefined,
      connect,
    );
    expect(downloads).toBe(2);
    expect(second.status).toBe(condition === "missing" ? "ok" : "failed");
    expect(await readFile(target)).toEqual(
      condition === "missing" ? png : Buffer.alloc(png.length, 0),
    );
    const [counts] = await testSql<
      { versions: number }[]
    >`SELECT count(*)::integer AS versions FROM media_versions`;
    expect(counts?.versions).toBe(1);
  },
);

test("S1 saved file access failure stops before download and preserves work", async () => {
  const config = await setup();
  let downloads = 0;
  const connect = async () => ({
    getPostDetail: async () => ({
      kind: "post" as const,
      selection: {
        assetId: postId,
        key: "https://assets.grok.com/image.png",
        mimeType: "image/png",
        quality: "image" as const,
        expectedBytes: png.length,
      },
    }),
    downloadMedia: async (
      _selection: unknown,
      onResponse: (response: {
        status: number;
        contentType: string;
        contentLength: string;
        contentEncoding: string;
      }) => Promise<void>,
      onChunk: (chunk: Uint8Array) => Promise<void>,
    ) => {
      downloads += 1;
      await onResponse({
        status: 200,
        contentType: "image/png",
        contentLength: String(png.length),
        contentEncoding: "identity",
      });
      await onChunk(png);
    },
    close: async () => {},
  });
  expect(
    (
      await saveSelectedPost(
        config,
        postId,
        new AbortController().signal,
        undefined,
        connect,
      )
    ).status,
  ).toBe("ok");
  const [before] = await testSql<
    {
      status: string;
      last_run_id: string;
      saved_media_version_id: string;
      relative_path: string;
    }[]
  >`
    SELECT w.status, w.last_run_id::text, w.saved_media_version_id::text, v.relative_path
    FROM post_work w JOIN media_versions v ON v.id = w.saved_media_version_id
    WHERE w.post_id = ${postId}
  `;
  if (!before) throw new Error("缺少首次保存事实");
  const target = join(config.archiveRoot, before.relative_path);
  await chmod(target, 0);
  try {
    const second = await saveSelectedPost(
      config,
      postId,
      new AbortController().signal,
      undefined,
      connect,
    );
    expect(second.status).toBe("failed");
    expect(second.message).toContain("归档文件");
    expect(downloads).toBe(1);
    const [after] = await testSql<
      { status: string; last_run_id: string; saved_media_version_id: string }[]
    >`
      SELECT status, last_run_id::text, saved_media_version_id::text
      FROM post_work WHERE post_id = ${postId}
    `;
    expect(after).toEqual({
      status: before.status,
      last_run_id: before.last_run_id,
      saved_media_version_id: before.saved_media_version_id,
    });
  } finally {
    await chmod(target, 0o600);
  }
});

test("S1 explicit save checks only the current archive root", async () => {
  const config = await setup();
  let downloads = 0;
  const connect = async () => ({
    getPostDetail: async () => ({
      kind: "post" as const,
      selection: {
        assetId: postId,
        key: "https://assets.grok.com/image.png",
        mimeType: "image/png",
        quality: "image" as const,
        expectedBytes: png.length,
      },
    }),
    downloadMedia: async (
      _selection: unknown,
      onResponse: (response: {
        status: number;
        contentType: string;
        contentLength: string;
        contentEncoding: string;
      }) => Promise<void>,
      onChunk: (chunk: Uint8Array) => Promise<void>,
    ) => {
      downloads += 1;
      await onResponse({
        status: 200,
        contentType: "image/png",
        contentLength: String(png.length),
        contentEncoding: "identity",
      });
      await onChunk(png);
    },
    close: async () => {},
  });
  expect(
    (
      await saveSelectedPost(
        config,
        postId,
        new AbortController().signal,
        undefined,
        connect,
      )
    ).status,
  ).toBe("ok");
  const [version] = await testSql<
    { relative_path: string }[]
  >`SELECT relative_path FROM media_versions WHERE post_id = ${postId}`;
  if (!version) throw new Error("版本记录缺失");
  const otherRoot = await mkdtemp(join(tmpdir(), "gms-other-root-"));
  try {
    const movedConfig = { ...config, archiveRoot: otherRoot };
    const result = await saveSelectedPost(
      movedConfig,
      postId,
      new AbortController().signal,
      undefined,
      connect,
    );
    expect(result.status, result.message).toBe("ok");
    expect(downloads).toBe(2);
    expect(
      await readFile(join(config.archiveRoot, version.relative_path)),
    ).toEqual(png);
    expect(await readFile(join(otherRoot, version.relative_path))).toEqual(png);
    const [counts] = await testSql<
      { versions: number }[]
    >`SELECT count(*)::integer AS versions FROM media_versions`;
    expect(counts?.versions).toBe(1);
  } finally {
    await rm(otherRoot, { recursive: true, force: true });
  }
});

test("S1 以所选 1080p MP4 响应长度保存并核验版本", async () => {
  const config = await setup();
  const requested: string[] = [];
  const detail = parsePostDetailResponse(postId, {
    status: 200,
    contentType: "application/json",
    finalPath: `/rest/assets/${postId}`,
    body: {
      assetId: postId,
      mimeType: "video/mp4",
      key: "https://videos.grok.com/base.mp4",
      sizeBytes: 9999,
      hdKey: "https://videos.grok.com/720.mp4",
      hd1080Key: "https://videos.grok.com/1080.mp4",
    },
  });
  const result = await saveSelectedPost(
    config,
    postId,
    new AbortController().signal,
    undefined,
    async () => ({
      getPostDetail: async () => detail,
      downloadMedia: async (selection, onResponse, onChunk) => {
        requested.push(selection.key ?? "");
        await onResponse({
          status: 200,
          contentType: "video/mp4",
          contentLength: String(mp4.length),
          contentEncoding: null,
        });
        await onChunk(mp4);
      },
      close: async () => {},
    }),
  );
  expect(result.status, result.message).toBe("ok");
  expect(requested).toEqual(["https://videos.grok.com/1080.mp4"]);
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
    { status: string; quality: string; expected_bytes: string | null }[]
  >`SELECT status, quality, expected_bytes::text FROM post_work WHERE post_id = ${postId}`;
  const [version] = await testSql<
    { byte_count: string; mime_type: string; relative_path: string }[]
  >`SELECT byte_count::text, mime_type, relative_path FROM media_versions WHERE post_id = ${postId}`;
  expect(work).toEqual({
    status: "saved",
    quality: "1080p",
    expected_bytes: null,
  });
  expect(version).toMatchObject({
    byte_count: String(mp4.length),
    mime_type: "video/mp4",
  });
  expect(version?.relative_path.endsWith(".mp4")).toBe(true);
});

test("S1 高清传输失败及重读详情后仍只尝试最高候选", async () => {
  const config = await setup();
  let details = 0;
  const requested: string[] = [];
  const result = await saveSelectedPost(
    config,
    postId,
    new AbortController().signal,
    undefined,
    async () => ({
      getPostDetail: async () => {
        details += 1;
        return parsePostDetailResponse(postId, {
          status: 200,
          contentType: "application/json",
          finalPath: `/rest/assets/${postId}`,
          body: {
            assetId: postId,
            mimeType: "video/mp4",
            key: "https://videos.grok.com/base.mp4",
            hdKey: "https://videos.grok.com/720.mp4",
            hd1080Key: `https://videos.grok.com/1080-${details}.mp4`,
          },
        });
      },
      downloadMedia: async (selection, onResponse, onChunk) => {
        requested.push(selection.key ?? "");
        await onResponse({
          status: 200,
          contentType: "video/mp4",
          contentLength: String(mp4.length),
          contentEncoding: null,
        });
        await onChunk(mp4.subarray(0, 12));
      },
      close: async () => {},
    }),
  );
  expect(result.status).toBe("failed");
  expect(details).toBe(2);
  expect(requested).toEqual([
    "https://videos.grok.com/1080-1.mp4",
    "https://videos.grok.com/1080-2.mp4",
  ]);
  const [work] = await testSql<
    { status: string; quality: string; publish_sha256: string | null }[]
  >`SELECT status, quality, publish_sha256 FROM post_work WHERE post_id = ${postId}`;
  expect(work).toEqual({
    status: "failed",
    quality: "1080p",
    publish_sha256: null,
  });
});

test.each([
  ["访问失败", 403, "video/mp4", String(mp4.length), 1],
  ["响应类型错误", 200, "text/html", String(mp4.length), 2],
  ["缺少可信长度", 200, "video/mp4", null, 2],
] as const)(
  "S1 最高视频候选%s时不降级或发布",
  async (_case, status, contentType, contentLength, expectedTransfers) => {
    const config = await setup();
    const requested: string[] = [];
    const result = await saveSelectedPost(
      config,
      postId,
      new AbortController().signal,
      undefined,
      async () => ({
        getPostDetail: async () =>
          parsePostDetailResponse(postId, {
            status: 200,
            contentType: "application/json",
            finalPath: `/rest/assets/${postId}`,
            body: {
              assetId: postId,
              mimeType: "video/mp4",
              key: "https://videos.grok.com/base.mp4",
              hdKey: "https://videos.grok.com/720.mp4",
              hd1080Key: "https://videos.grok.com/1080.mp4",
            },
          }),
        downloadMedia: async (selection, onResponse, onChunk) => {
          requested.push(selection.key ?? "");
          await onResponse({
            status,
            contentType,
            contentLength,
            contentEncoding: null,
          });
          await onChunk(mp4);
        },
        close: async () => {},
      }),
    );
    expect(result.status).toBe("failed");
    expect(requested).toEqual(
      Array(expectedTransfers).fill("https://videos.grok.com/1080.mp4"),
    );
    const [work] = await testSql<
      { status: string; publish_sha256: string | null }[]
    >`SELECT status, publish_sha256 FROM post_work WHERE post_id = ${postId}`;
    expect(work).toEqual({ status: "failed", publish_sha256: null });
  },
);

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
    "JPEG response for a PNG selection",
    {
      status: 200,
      contentType: "image/jpeg",
      contentLength: String(mislabeledJpeg.length),
      contentEncoding: null,
    },
    mislabeledJpeg,
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
  ["complete image", "0", "0", 0, "saved"],
  ["complete video", "0", "1", 0, "saved"],
  ["SIGINT image", "1", "0", 130, "pending"],
] as const)(
  "S2 real CLI %s media transfer reports exit and durable fact",
  async (_label, abort, video, expectedExit, expectedStatus) => {
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
          GMS_TEST_VIDEO: video,
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
    if (video === "1" && expectedExit === 0) {
      expect(stdout).toContain("video/mp4");
      expect(stdout).toContain("Post 保存完成");
      expect(stdout).not.toContain("fixture-token");
      expect(stderr).not.toContain("fixture-token");
    }
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

test("S2 real CLI saves again, reuses the version, then reports detail failure without losing it", async () => {
  const config = await setup();
  const requestTimes = join(config.archiveRoot, "request-times");
  const run = async (unavailable = false) => {
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
          GMS_TEST_UNAVAILABLE: unavailable ? "1" : "0",
          GMS_TEST_REQUEST_TIMES: requestTimes,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(`${stdout}${stderr}`).not.toContain("fixture-token");
    return { stdout, stderr, code };
  };
  const first = await run();
  expect(first.code, first.stderr).toBe(0);
  const [version] = await testSql<
    { relative_path: string }[]
  >`SELECT relative_path FROM media_versions WHERE post_id = ${postId}`;
  if (!version) throw new Error("版本记录缺失");
  const original = await readFile(
    join(config.archiveRoot, version.relative_path),
  );
  const second = await run();
  expect(second.code, second.stderr).toBe(0);
  expect(second.stdout).toContain("已复用保存文件");
  const failed = await run(true);
  expect(failed.code).toBe(1);
  expect(failed.stderr).toContain("详情不可读取");
  expect(
    await readFile(join(config.archiveRoot, version.relative_path)),
  ).toEqual(original);
  expect(
    (await readFile(requestTimes, "utf8")).trim().split("\n"),
  ).toHaveLength(3);
  const [counts] = await testSql<{ runs: number; versions: number }[]>`
    SELECT (SELECT count(*)::integer FROM runs) AS runs,
      (SELECT count(*)::integer FROM media_versions) AS versions
  `;
  expect(counts).toEqual({ runs: 3, versions: 1 });
  const [work] = await testSql<
    { status: string; saved_media_version_id: string }[]
  >`
    SELECT status, saved_media_version_id::text FROM post_work WHERE post_id = ${postId}
  `;
  expect(work?.status).toBe("failed");
  expect(work?.saved_media_version_id).toBeTruthy();
});
