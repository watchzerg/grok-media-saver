import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import { parsePostDetailResponse } from "../../src/grok/adapter";
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

test("S1 原始 MP4 的 Data URL 长度元数据允许保存并复用真实字节版本", async () => {
  const byteCount = 1209632;
  const detailSize = 1612866;
  const config = await setup();
  // 样本长度来自现场，内容仅为合成 fixture。
  const media = Buffer.alloc(byteCount);
  mp4.copy(media);
  let downloads = 0;
  const stages: string[] = [];
  const connect = async () => ({
    getPostDetail: async () =>
      parsePostDetailResponse(postId, {
        status: 200,
        contentType: "application/json",
        finalPath: `/rest/assets/${postId}`,
        body: {
          assetId: postId,
          key: "https://assets.grok.com/video.mp4",
          mimeType: "video/mp4",
          sizeBytes: detailSize,
        },
      }),
    downloadMedia: async (
      _selection: unknown,
      response: (headers: {
        status: number;
        contentType: string;
        contentLength: string;
        contentEncoding: null;
      }) => Promise<void>,
      chunk: (bytes: Uint8Array) => Promise<void>,
    ) => {
      downloads++;
      await response({
        status: 200,
        contentType: "video/mp4",
        contentLength: String(media.length),
        contentEncoding: null,
      });
      await chunk(media);
    },
    close: async () => {},
  });
  const save = () =>
    saveSelectedPost(
      config,
      postId,
      new AbortController().signal,
      (stage) => stages.push(stage),
      connect,
    );
  const first = await save();
  expect(first.status, first.message).toBe("ok");
  const [version] = await testSql<
    { byte_count: string; relative_path: string; expected_bytes: string }[]
  >`
    SELECT v.byte_count::text, v.relative_path, w.expected_bytes::text
    FROM post_work w JOIN media_versions v ON v.id = w.saved_media_version_id WHERE w.post_id = ${postId}`;
  expect(version.byte_count).toBe(String(byteCount));
  expect(version.expected_bytes).toBe(String(detailSize));
  expect(
    await readFile(join(config.archiveRoot, version.relative_path)),
  ).toEqual(media);
  const second = await save();
  expect(second.status, second.message).toBe("ok");
  expect(second.message).toContain("复用");
  expect(downloads).toBe(1);
  expect(stages.some((stage) => stage.includes("Data URL"))).toBe(true);
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

test("S1 refuses a bad file signature after two bounded transfers", async () => {
  const headers = {
    status: 200,
    contentType: "image/png",
    contentLength: String(png.length),
    contentEncoding: null,
  };
  const payload = Buffer.alloc(png.length);
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
});

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
