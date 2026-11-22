import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveSelectedPost,
  initializeProjectDatabase,
  saveSelectedPost,
} from "../../src/application-runtime";
import { readDatabaseConfig, readSaveConfig } from "../../src/config";
import {
  parsePostDetailResponse,
  type RawDeleteResponse,
} from "../../src/grok/adapter";
import { databaseEnv, testSql, useIsolatedPostgres } from "../helpers/postgres";

useIsolatedPostgres();
const postId = "123e4567-e89b-42d3-a456-426614174000";
let archiveRoot: string | undefined;
afterEach(async () => {
  if (archiveRoot) await rm(archiveRoot, { recursive: true, force: true });
  archiveRoot = undefined;
});
async function seed() {
  await testSql`DROP TABLE IF EXISTS media_versions, post_work, runs CASCADE`;
  expect(
    (await initializeProjectDatabase(readDatabaseConfig(databaseEnv))).status,
  ).toBe("ok");
  archiveRoot = await mkdtemp(join(tmpdir(), "gms-archive-post-"));
  return archiveRoot;
}
async function cli(
  extra: Record<string, string> = {},
  id = postId,
  preloads: string[] = [],
) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--preload",
      "./tests/helpers/fake-save-browser.ts",
      ...preloads.flatMap((path) => ["--preload", path]),
      "src/cli.ts",
      "archive",
      "post",
      id,
    ],
    {
      env: {
        ...databaseEnv,
        GROK_ARCHIVE_DIR: archiveRoot,
        PLAYWRIGHT_MCP_EXTENSION_TOKEN: "fixture-token",
        GROK_API_INTERVAL_MIN_SECONDS: "0",
        GROK_API_INTERVAL_MAX_SECONDS: "0",
        GMS_TEST_MEDIA: "1",
        ...extra,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("P2-02 S2 新下载绑定精确版本并归档结清", async () => {
  const root = await seed();
  const events = join(root, "requests.jsonl");
  const result = await cli({ GMS_TEST_REQUEST_EVENTS: events });
  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(result.stdout).toContain("归档已结清");
  const [work] =
    await testSql`SELECT goal, status, removal_state, deletion_media_version_id::text, saved_media_version_id::text, archive_settled FROM post_work WHERE post_id = ${postId}`;
  expect(work).toMatchObject({
    goal: "archive",
    status: "saved",
    removal_state: "removed",
    archive_settled: true,
  });
  expect(work?.deletion_media_version_id).toBe(work?.saved_media_version_id);
  const requests = (await readFile(events, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(requests.map((request) => request.kind)).toEqual([
    "detail",
    "media",
    "delete",
  ]);
  expect(requests.at(-1)?.postId).toBe(postId);
});

test("P2-04 S2 发送前停止保留意图，下次先GET核对并结清", async () => {
  const root = await seed();
  const marker = join(root, "marker");
  const events = join(root, "requests");
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--preload",
      "./tests/helpers/fake-save-browser.ts",
      "--preload",
      "./tests/helpers/pause-save-stage.ts",
      "src/cli.ts",
      "archive",
      "post",
      postId,
    ],
    {
      env: {
        ...databaseEnv,
        GROK_ARCHIVE_DIR: root,
        PLAYWRIGHT_MCP_EXTENSION_TOKEN: "fixture",
        GROK_API_INTERVAL_MIN_SECONDS: "0",
        GROK_API_INTERVAL_MAX_SECONDS: "0",
        GMS_TEST_MEDIA: "1",
        GMS_TEST_REQUEST_EVENTS: events,
        GMS_TEST_STOP_STAGE: "删除意图已提交",
        GMS_TEST_STAGE_MARKER: marker,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    const deadline = Date.now() + 5000;
    while (!(await Bun.file(marker).exists()) && Date.now() < deadline)
      await Bun.sleep(10);
    expect(await Bun.file(marker).exists()).toBe(true);
    process.kill(child.pid, "SIGINT");
    process.kill(child.pid, "SIGCONT");
    const [stderr, code] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, stderr).toBe(130);
    expect(await readFile(events, "utf8")).not.toContain('"delete"');
    const [work] =
      await testSql`SELECT removal_state, archive_settled FROM post_work WHERE post_id = ${postId}`;
    expect(work).toEqual({ removal_state: "pending", archive_settled: false });
    const nextEvents = join(root, "recovery-requests");
    const next = await cli({
      ...removedCheckEnv,
      GMS_TEST_REQUEST_EVENTS: nextEvents,
    });
    expect(next.exitCode, JSON.stringify(next)).toBe(0);
    expect(
      (await readFile(nextEvents, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).kind),
    ).toEqual(["check"]);
    const [recovered] =
      await testSql`SELECT removal_state, archive_settled FROM post_work WHERE post_id=${postId}`;
    expect(recovered).toEqual({
      removal_state: "removed",
      archive_settled: true,
    });
  } finally {
    if (child.exitCode === null) {
      process.kill(child.pid, "SIGCONT");
      process.kill(child.pid, "SIGKILL");
      await child.exited;
    }
  }
}, 20_000);

test("P2-02 S2 发送前丢锁禁止 DELETE 且不改写工作事实", async () => {
  const root = await seed();
  const marker = join(root, "marker");
  const events = join(root, "requests");
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--preload",
      "./tests/helpers/fake-save-browser.ts",
      "--preload",
      "./tests/helpers/pause-save-stage.ts",
      "src/cli.ts",
      "archive",
      "post",
      postId,
    ],
    {
      env: {
        ...databaseEnv,
        GROK_ARCHIVE_DIR: root,
        PLAYWRIGHT_MCP_EXTENSION_TOKEN: "fixture",
        GROK_API_INTERVAL_MIN_SECONDS: "0",
        GROK_API_INTERVAL_MAX_SECONDS: "0",
        GMS_TEST_MEDIA: "1",
        GMS_TEST_REQUEST_EVENTS: events,
        GMS_TEST_STOP_STAGE: "删除意图已提交",
        GMS_TEST_STAGE_MARKER: marker,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    const deadline = Date.now() + 5000;
    while (!(await Bun.file(marker).exists()) && Date.now() < deadline)
      await Bun.sleep(10);
    expect(await Bun.file(marker).exists()).toBe(true);
    const [before] =
      await testSql`SELECT * FROM post_work WHERE post_id = ${postId}`;
    await testSql`SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND granted AND classid = 1297043787::oid AND objid = 1::oid`;
    process.kill(child.pid, "SIGCONT");
    const [stderr, code] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, stderr).toBe(1);
    expect(await readFile(events, "utf8")).not.toContain('"delete"');
    const [after] =
      await testSql`SELECT * FROM post_work WHERE post_id = ${postId}`;
    expect(after).toEqual(before);
  } finally {
    if (child.exitCode === null) {
      process.kill(child.pid, "SIGCONT");
      process.kill(child.pid, "SIGKILL");
      await child.exited;
    }
  }
}, 20_000);

const media = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
  "hex",
);
function options(
  overrides: {
    raw?: Partial<RawDeleteResponse>;
    wrongIdentity?: boolean;
    closeFailure?: boolean;
    deleteFailure?: boolean;
  } = {},
) {
  const requests: string[] = [];
  let mediaPageReady = false;
  return {
    requests,
    connect: async () => ({
      prepareMediaPage: async (signal: AbortSignal) => {
        if (signal.aborted) throw new Error("媒体下载已停止。");
        mediaPageReady = true;
      },
      getPostDetail: async (id: string) => {
        mediaPageReady = true;
        requests.push(`detail:${id}`);
        return parsePostDetailResponse(id, {
          status: 200,
          contentType: "application/json",
          finalPath: `/rest/assets/${id}`,
          body: {
            assetId: overrides.wrongIdentity
              ? "123e4567-e89b-42d3-a456-426614174001"
              : id,
            key: "https://assets.grok.com/source.png",
            mimeType: "image/png",
          },
        });
      },
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
        if (!mediaPageReady)
          throw new Error("媒体请求需要已确认的 Post 页面。");
        requests.push("media");
        await onResponse({
          status: 200,
          contentType: "image/png",
          contentLength: String(media.length),
          contentEncoding: null,
        });
        await onChunk(media);
      },
      deletePost: async (id: string) => {
        requests.push(`delete:${id}`);
        if (overrides.deleteFailure)
          throw new Error("连接断开，无法确认请求停止");
        return {
          status: 200,
          contentType: "application/json",
          body: {},
          finalUrl: `https://grok.com/rest/assets/${id}`,
          method: "DELETE",
          redirected: false,
          ...overrides.raw,
        };
      },
      close: async () => {
        if (overrides.closeFailure) throw new Error("模拟浏览器关闭失败");
      },
    }),
  };
}
function config() {
  return readSaveConfig({
    ...databaseEnv,
    GROK_ARCHIVE_DIR: archiveRoot,
    PLAYWRIGHT_MCP_EXTENSION_TOKEN: "fixture-token",
    GROK_API_INTERVAL_MIN_SECONDS: "0",
    GROK_API_INTERVAL_MAX_SECONDS: "0",
  });
}
async function work() {
  const [row] =
    await testSql`SELECT * FROM post_work WHERE post_id = ${postId}`;
  return row;
}

test("P2-02 S1 原始 DELETE 普通404响应保留未知且重复调用不重发", async () => {
  await seed();
  const fake = options({
    raw: { status: 404, body: { code: 5, message: "Asset not found" } },
  });
  const result = await archiveSelectedPost(
    config(),
    postId,
    new AbortController().signal,
    undefined,
    fake.connect,
  );
  expect(result.status).not.toBe("ok");
  expect(result).toMatchObject({
    remoteObservation: "unknown",
    archiveRecorded: false,
    saveRecorded: true,
  });
  expect(result.message).toContain("待核对");
  const before = await work();
  expect(before).toMatchObject({
    removal_state: "pending",
    archive_settled: false,
  });
  expect(before?.deletion_media_version_id).toBeTruthy();
  expect(before?.selected_key).toBe("https://assets.grok.com/source.png");
  const againOptions = options();
  const again = await archiveSelectedPost(
    config(),
    postId,
    new AbortController().signal,
    undefined,
    againOptions.connect,
  );
  expect(again.status).toBe("failed");
  expect(againOptions.requests).toEqual([]);
  expect(await work()).toEqual(before);
});

test("P2-02 S2 结清事务实际已提交但丢回执，禁止当前进程追写", async () => {
  const root = await seed();
  const events = join(root, "requests");
  const result = await cli(
    {
      GMS_TEST_REQUEST_EVENTS: events,
      GMS_TEST_LOSE_ARCHIVE_RECEIPT: "settle",
    },
    postId,
    ["./tests/helpers/lose-archive-receipt.ts"],
  );
  expect(result.exitCode, JSON.stringify(result)).toBe(1);
  expect(result.stderr).toContain("提交结果未知");
  expect(result.stderr).toContain("本次已确认远端移除");
  const row = await work();
  expect(row).toMatchObject({
    goal: "archive",
    status: "saved",
    removal_state: "removed",
    archive_settled: true,
    last_error: null,
  });
  expect(row?.deletion_media_version_id).toBe(row?.saved_media_version_id);
  const [run] = await testSql`SELECT finished_at, outcome FROM runs`;
  expect(run).toEqual({ finished_at: null, outcome: null });
  expect(await readFile(events, "utf8")).toContain('"delete"');
  const before = await work();
  const next = await cli({ GMS_TEST_REQUEST_EVENTS: events });
  expect(next.exitCode).toBe(0);
  expect(await work()).toEqual(before);
  expect(
    (await readFile(events, "utf8"))
      .trim()
      .split("\n")
      .filter((line) => line.includes('"delete"')),
  ).toHaveLength(1);
});

test("P2-02 S1 正式文件冲突不得覆盖或 DELETE", async () => {
  await seed();
  const fake = options();
  expect(
    (
      await saveSelectedPost(
        config(),
        postId,
        new AbortController().signal,
        undefined,
        fake.connect,
      )
    ).status,
  ).toBe("ok");
  const [version] = await testSql`SELECT relative_path FROM media_versions`;
  const path = join(archiveRoot as string, String(version?.relative_path));
  await writeFile(path, "外部冲突内容");
  const archiveOptions = options();
  const result = await archiveSelectedPost(
    config(),
    postId,
    new AbortController().signal,
    undefined,
    archiveOptions.connect,
  );
  expect(result.status).toBe("failed");
  expect(result.message).toContain("冲突");
  expect(archiveOptions.requests).not.toContain(`delete:${postId}`);
  expect(await readFile(path, "utf8")).toBe("外部冲突内容");
  expect(await work()).toMatchObject({
    goal: "archive",
    status: "finalizing",
    removal_state: "none",
    archive_settled: false,
  });
});

async function signalDelete(twice: boolean) {
  const root = await seed();
  const events = join(root, "requests");
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--preload",
      "./tests/helpers/fake-save-browser.ts",
      "src/cli.ts",
      "archive",
      "post",
      postId,
    ],
    {
      env: {
        ...databaseEnv,
        GROK_ARCHIVE_DIR: root,
        PLAYWRIGHT_MCP_EXTENSION_TOKEN: "fixture",
        GROK_API_INTERVAL_MIN_SECONDS: "0",
        GROK_API_INTERVAL_MAX_SECONDS: "0",
        GMS_TEST_MEDIA: "1",
        GMS_TEST_REQUEST_EVENTS: events,
        GMS_TEST_DELETE_DELAY_MS: twice ? "10000" : "600",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (
        (await Bun.file(events).exists()) &&
        (await readFile(events, "utf8")).includes('"delete"')
      )
        break;
      await Bun.sleep(10);
    }
    expect(await readFile(events, "utf8")).toContain('"delete"');
    process.kill(child.pid, "SIGINT");
    await Bun.sleep(80);
    expect(child.exitCode).toBe(null);
    if (twice) process.kill(child.pid, "SIGINT");
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, stderr).toBe(130);
    const requests = (await readFile(events, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(requests.map((item) => item.kind)).toEqual([
      "detail",
      "media",
      "delete",
    ]);
    expect(await work()).toMatchObject({
      removal_state: twice ? "pending" : "removed",
      archive_settled: !twice,
    });
    if (twice) expect(stderr).toContain("已强制停止");
    else expect(stdout + stderr).toContain("归档已结清");
    // 遗留意图统一核对；已结清事实直接跳过。
    const next = await cli({
      GMS_TEST_REQUEST_EVENTS: join(root, "next-requests"),
    });
    expect(next.stdout + next.stderr).toContain(twice ? "待核对" : "归档结清");
    if (twice) {
      expect(
        (await readFile(join(root, "next-requests"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line).kind),
      ).toEqual(["check", "check"]);
    } else
      expect(await Bun.file(join(root, "next-requests")).exists()).toBe(false);
  } finally {
    if (child.exitCode === null) {
      process.kill(child.pid, "SIGKILL");
      await child.exited;
    }
  }
}
test(
  "P2-03 S2 在途真实首次 SIGINT 保留响应和结清事实并退出130",
  () => signalDelete(false),
  15000,
);

const removedCheckEnv = {
  GMS_TEST_CHECK_STATUS: "404",
  GMS_TEST_CHECK_BODY: '{"code":5,"message":"Asset not found"}',
};
