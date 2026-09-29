import { afterEach, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveSelectedPost,
  initializeProjectDatabase,
  saveSelectedPost,
} from "../../src/application-runtime";
import { savePost } from "../../src/application-save-post";
import { readDatabaseConfig, readSaveConfig } from "../../src/config";
import {
  parsePostDetailResponse,
  type RawCheckResponse,
  type RawDeleteResponse,
  RetryableRequestError,
  UnconfirmedStopError,
} from "../../src/grok/adapter";
import { createRequestScheduler } from "../../src/grok/request-scheduler";
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

test("P2-02 P2-11 S1 显式提升 save 并核验复用同一版本，终态跳过不访问资源", async () => {
  await seed();
  const firstOptions = options();
  expect(
    (
      await saveSelectedPost(
        config(),
        postId,
        new AbortController().signal,
        undefined,
        firstOptions.connect,
      )
    ).status,
  ).toBe("ok");
  expect(firstOptions.requests).toEqual([`detail:${postId}`, "media"]);
  const before = await work();
  const archiveOptions = options();
  const result = await archiveSelectedPost(
    config(),
    postId,
    new AbortController().signal,
    undefined,
    archiveOptions.connect,
  );
  expect(result.status, JSON.stringify(result)).toBe("ok");
  expect(result).toMatchObject({
    saveRecorded: true,
    archiveRecorded: true,
    remoteObservation: "removed",
    newRemovalConfirmed: true,
    summary: {
      saved: 0,
      archived: 1,
      skipped: 0,
      unconfirmed: 0,
      unprocessed: 0,
    },
    summaryRecorded: true,
  });
  expect(archiveOptions.requests).toEqual([
    `detail:${postId}`,
    `delete:${postId}`,
  ]);
  const after = await work();
  expect(after?.deletion_media_version_id).toBe(before?.saved_media_version_id);
  expect(after?.saved_media_version_id).toBe(before?.saved_media_version_id);
  await rm(archiveRoot as string, { recursive: true });
  const again = await archiveSelectedPost(
    config(),
    postId,
    new AbortController().signal,
    undefined,
    async () => {
      throw new Error("终态不得启动浏览器");
    },
  );
  expect(again.status).toBe("ok");
  expect(again.summary).toEqual({
    saved: 0,
    archived: 0,
    skipped: 1,
    unconfirmed: 0,
    unprocessed: 0,
  });
  expect(again.summaryRecorded).toBe(true);
  expect(again.message).toContain("直接跳过");
  expect(again.newRemovalConfirmed).toBe(false);
  expect(await work()).toEqual(after);
});

test.each([
  { name: "非空对象", raw: { body: { success: true } } },
  { name: "数组", raw: { body: [] } },
  { name: "空正文", raw: { body: null } },
  { name: "HTML", raw: { contentType: "text/html" } },
  { name: "204", raw: { status: 204 } },
  {
    name: "普通404",
    raw: { status: 404, body: { code: 5, message: "Asset not found" } },
  },
  {
    name: "错误目标",
    raw: {
      finalUrl:
        "https://grok.com/rest/assets/123e4567-e89b-42d3-a456-426614174001",
    },
  },
  {
    name: "不同源",
    raw: { finalUrl: `https://example.com/rest/assets/${postId}` },
  },
  { name: "重定向", raw: { redirected: true } },
  { name: "错误方法", raw: { method: "GET" } },
  { name: "429", raw: { status: 429, retryAfter: "60" } },
  { name: "401", raw: { status: 401 } },
  { name: "challenge", raw: { finalUrl: "https://grok.com/challenge" } },
])(
  "P2-02 S1 原始 DELETE $name 响应保留未知且重复调用不重发",
  async ({ raw }) => {
    await seed();
    const fake = options({ raw });
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
  },
);

test("P2-02 S1 错误详情身份不触发下载或删除", async () => {
  await seed();
  const fake = options({ wrongIdentity: true });
  const result = await archiveSelectedPost(
    config(),
    postId,
    new AbortController().signal,
    undefined,
    fake.connect,
  );
  expect(result.status).toBe("failed");
  expect(fake.requests).toEqual([`detail:${postId}`]);
  expect((await work())?.removal_state).toBe("none");
});

test("P2-02 S1 清理失败保留已经结清的归档事实", async () => {
  await seed();
  const fake = options({ closeFailure: true });
  const result = await archiveSelectedPost(
    config(),
    postId,
    new AbortController().signal,
    undefined,
    fake.connect,
  );
  expect(result).toMatchObject({
    status: "failed",
    remoteObservation: "removed",
    archiveRecorded: true,
  });
  expect(result.cleanupErrors).toHaveLength(1);
  expect(result.message).toContain("归档已结清");
  expect((await work())?.archive_settled).toBe(true);
});

test("P2-02 S1 断连或请求停止不确定保留意图并立即结束", async () => {
  await seed();
  const fake = options({ deleteFailure: true });
  const result = await archiveSelectedPost(
    config(),
    postId,
    new AbortController().signal,
    undefined,
    fake.connect,
  );
  expect(result).toMatchObject({
    status: "failed",
    remoteObservation: "unknown",
    fatalExecution: true,
  });
  expect((await work())?.removal_state).toBe("pending");
  const [run] = await testSql`SELECT finished_at FROM runs`;
  expect(run?.finished_at).toBeNull();
});

test.each(["intent", "settle"])(
  "P2-02 S2 %s 事务实际已提交但丢回执，禁止当前进程追写",
  async (stage) => {
    const root = await seed();
    const events = join(root, "requests");
    const result = await cli(
      { GMS_TEST_REQUEST_EVENTS: events, GMS_TEST_LOSE_ARCHIVE_RECEIPT: stage },
      postId,
      ["./tests/helpers/lose-archive-receipt.ts"],
    );
    expect(result.exitCode, JSON.stringify(result)).toBe(1);
    expect(result.stderr).toContain("提交结果未知");
    if (stage === "settle")
      expect(result.stderr).toContain("本次已确认远端移除");
    const row = await work();
    expect(row).toMatchObject({
      goal: "archive",
      status: "saved",
      removal_state: stage === "intent" ? "pending" : "removed",
      archive_settled: stage === "settle",
      last_error: null,
    });
    expect(row?.deletion_media_version_id).toBe(row?.saved_media_version_id);
    const [run] = await testSql`SELECT finished_at, outcome FROM runs`;
    expect(run).toEqual({ finished_at: null, outcome: null });
    expect((await readFile(events, "utf8")).includes('"delete"')).toBe(
      stage === "settle",
    );
    const before = await work();
    const next = await cli({ GMS_TEST_REQUEST_EVENTS: events });
    expect(next.exitCode).toBe(stage === "settle" ? 0 : 1);
    expect(await work()).toEqual(before);
    expect(
      (await readFile(events, "utf8"))
        .trim()
        .split("\n")
        .filter((line) => line.includes('"delete"')),
    ).toHaveLength(stage === "settle" ? 1 : 0);
  },
);

test.each(["intent", "settle"])(
  "P2-02 S2 %s 事务实际未提交，保留真实持久状态并停止",
  async (stage) => {
    const root = await seed();
    const events = join(root, "requests");
    await testSql.unsafe(`CREATE OR REPLACE FUNCTION reject_archive_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF ${stage === "intent" ? "NEW.removal_state = 'pending'" : "NEW.archive_settled"} THEN RAISE EXCEPTION '模拟删除事务未提交'; END IF;
    RETURN NEW; END $$`);
    await testSql`CREATE TRIGGER reject_archive_write BEFORE UPDATE ON post_work FOR EACH ROW EXECUTE FUNCTION reject_archive_write()`;
    try {
      const result = await cli({ GMS_TEST_REQUEST_EVENTS: events });
      expect(result.exitCode, JSON.stringify(result)).toBe(1);
      expect(result.stderr).toContain("提交结果未知");
      const row = await work();
      expect(row).toMatchObject({
        status: "saved",
        removal_state: stage === "intent" ? "none" : "pending",
        archive_settled: false,
        last_error: null,
      });
      expect(row?.deletion_media_version_id === null).toBe(stage === "intent");
      const [run] = await testSql`SELECT finished_at, outcome FROM runs`;
      expect(run).toEqual({ finished_at: null, outcome: null });
      expect((await readFile(events, "utf8")).includes('"delete"')).toBe(
        stage === "settle",
      );
    } finally {
      await testSql`DROP TRIGGER reject_archive_write ON post_work`;
      await testSql`DROP FUNCTION reject_archive_write()`;
    }
    const nextEvents = join(root, "restart-requests");
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
    ).toEqual(stage === "intent" ? ["detail", "delete"] : ["check"]);
    expect(await work()).toMatchObject({
      removal_state: "removed",
      archive_settled: true,
    });
  },
);

test("P2-02 S1 终态再次处理分别保留记账与本次未发请求的事实", async () => {
  await seed();
  const fake = options();
  expect(
    (
      await archiveSelectedPost(
        config(),
        postId,
        new AbortController().signal,
        undefined,
        fake.connect,
      )
    ).status,
  ).toBe("ok");
  const result = await archiveSelectedPost(
    config(),
    postId,
    new AbortController().signal,
    undefined,
    async () => {
      throw new Error("终态不得连接");
    },
  );
  expect(result).toMatchObject({
    status: "ok",
    archiveRecorded: true,
    saveRecorded: true,
    remoteObservation: "not-requested",
  });
});

test("P2-02 S1 请求错误文本不泄露凭据", async () => {
  await seed();
  const fake = options();
  const result = await archiveSelectedPost(
    config(),
    postId,
    new AbortController().signal,
    undefined,
    async () => ({
      ...(await fake.connect()),
      deletePost: async () => {
        throw new Error("fixture-token ?token=hidden-secret");
      },
    }),
  );
  expect(result.message).not.toContain("fixture-token");
  expect(result.message).not.toContain("hidden-secret");
  expect(result.remoteObservation).toBe("unknown");
});

test("P2-02 S1 数据库拒绝缺少移除事实的归档结清", async () => {
  await seed();
  await expect(
    testSql`INSERT INTO post_work (post_id, goal, status, archive_settled) VALUES (${postId}, 'archive', 'saved', true)`.then(
      (rows) => rows,
    ),
  ).rejects.toThrow();
  await testSql`INSERT INTO post_work (post_id, goal, status) VALUES (${postId}, 'archive', 'saved')`;
  const versionId = crypto.randomUUID();
  await testSql`INSERT INTO media_versions (id, post_id, sha256, byte_count, mime_type, relative_path, saved_at)
    VALUES (${versionId}::uuid, ${postId}, ${"a".repeat(64)}, 1, 'image/png', 'binding.png', now())`;
  await expect(
    testSql`UPDATE post_work SET removal_state = 'removed', deletion_media_version_id = ${versionId}::uuid,
    archive_settled = true WHERE post_id = ${postId}`.then((rows) => rows),
  ).rejects.toThrow();
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

test("P2-02 S1 未结清发布意图缺失不能凭旧 saved 取得删除资格", async () => {
  await seed();
  const digest = new Bun.CryptoHasher("sha256").update(media).digest("hex");
  await mkdir(join(archiveRoot as string, postId));
  await testSql`INSERT INTO post_work (post_id, goal, status, publish_temp_name, publish_relative_path, publish_expected_bytes, publish_sha256, mime_type)
    VALUES (${postId}, 'archive', 'finalizing', '.missing.part', ${`${postId}/${digest}.png`}, ${media.length}, ${digest}, 'image/png')`;
  const fake = options();
  const connect = async () => {
    const { downloadMedia: _download, ...session } = await fake.connect();
    return session;
  };
  const result = await archiveSelectedPost(
    config(),
    postId,
    new AbortController().signal,
    undefined,
    connect,
  );
  expect(result.status).toBe("failed");
  expect(fake.requests).toEqual([`detail:${postId}`]);
  expect(await work()).toMatchObject({
    goal: "archive",
    status: "pending",
    removal_state: "none",
    archive_settled: false,
    deletion_media_version_id: null,
  });
});

test("P2-02 S1 删除版本 FK 拒绝另一 Post 的版本", async () => {
  await seed();
  const fake = options({ raw: { status: 503 } });
  await archiveSelectedPost(
    config(),
    postId,
    new AbortController().signal,
    undefined,
    fake.connect,
  );
  const anotherId = "123e4567-e89b-42d3-a456-426614174001";
  const anotherVersion = crypto.randomUUID();
  await testSql`INSERT INTO post_work (post_id,status) VALUES (${anotherId},'pending')`;
  await testSql`INSERT INTO media_versions (id,post_id,sha256,byte_count,mime_type,relative_path,saved_at)
    VALUES (${anotherVersion}::uuid,${anotherId},${"f".repeat(64)},1,'image/png','another.png',now())`;
  const before = await work();
  await expect(
    testSql`UPDATE post_work SET deletion_media_version_id = ${anotherVersion}::uuid WHERE post_id = ${postId}`.then(
      (rows) => rows,
    ),
  ).rejects.toThrow();
  expect(await work()).toEqual(before);
});

test("P2-02 S1 DELETE 无响应在30秒总期限结束，保留未知且不追加请求", async () => {
  await seed();
  const fake = options();
  let calls = 0;
  let requestSignal: AbortSignal | undefined;
  const started = Date.now();
  const result = await archiveSelectedPost(
    config(),
    postId,
    new AbortController().signal,
    undefined,
    async () => ({
      ...(await fake.connect()),
      deletePost: async (_id: string, signal: AbortSignal) => {
        calls += 1;
        requestSignal = signal;
        return new Promise<RawDeleteResponse>(() => {});
      },
    }),
  );
  expect(Date.now() - started).toBeGreaterThanOrEqual(29_900);
  expect(Date.now() - started).toBeLessThan(33_000);
  expect(calls).toBe(1);
  expect(requestSignal?.aborted).toBe(true);
  expect(result).toMatchObject({
    status: "failed",
    remoteObservation: "unknown",
    fatalExecution: true,
  });
  expect(result.message).toContain("30 秒总期限");
  expect(await work()).toMatchObject({
    removal_state: "pending",
    archive_settled: false,
  });
}, 36_000);

test("P2-02 S1 浏览器挂起关闭最多5秒，独立DB锁释放继续且结清不撤销", async () => {
  await seed();
  const fake = options();
  const started = Date.now();
  const result = await archiveSelectedPost(
    config(),
    postId,
    new AbortController().signal,
    undefined,
    async () => ({
      ...(await fake.connect()),
      close: () => new Promise<void>(() => {}),
    }),
  );
  expect(Date.now() - started).toBeGreaterThanOrEqual(4900);
  expect(Date.now() - started).toBeLessThan(6500);
  expect(result).toMatchObject({
    status: "failed",
    archiveRecorded: true,
    remoteObservation: "removed",
  });
  expect(result.cleanupErrors.join(" ")).toContain("5 秒");
  const [locks] =
    await testSql`SELECT count(*)::integer AS count FROM pg_locks WHERE locktype='advisory' AND classid=1297043787::oid AND objid=1::oid`;
  expect(locks?.count).toBe(0);
  expect((await work())?.archive_settled).toBe(true);
}, 8000);

test("P2-02 S2 纯UUID参数校验先于配置和资源启动", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "src/cli.ts",
      "archive",
      "post",
      `https://grok.com/imagine/post/${postId}`,
    ],
    { env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe" },
  );
  const [stderr, code] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code).toBe(2);
  expect(stderr).toContain("Post ID 必须");
  expect(stderr).not.toContain("GROK_DB");
});

test("P2-02 S2 DELETE 遵守详情与媒体共享请求许可", async () => {
  const root = await seed();
  const path = join(root, "requests");
  const result = await cli({
    GMS_TEST_REQUEST_EVENTS: path,
    GROK_API_INTERVAL_MIN_SECONDS: "0.08",
    GROK_API_INTERVAL_MAX_SECONDS: "0.08",
  });
  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  const requests = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(requests.map((item) => item.kind)).toEqual([
    "detail",
    "media",
    "delete",
  ]);
  expect(requests[1].at - requests[0].at).toBeGreaterThanOrEqual(70);
  expect(requests[2].at - requests[1].at).toBeGreaterThanOrEqual(70);
});

test("P2-02 S2 archive 使用既有执行器锁，争锁失败不连接浏览器", async () => {
  const root = await seed();
  const events = join(root, "requests");
  const owner = await testSql.reserve();
  try {
    await owner`SELECT pg_advisory_lock(1297043787, 1)`;
    const result = await cli({ GMS_TEST_REQUEST_EVENTS: events });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("已有保存执行");
    expect(await Bun.file(events).exists()).toBe(false);
    const [runs] = await testSql`SELECT count(*)::integer AS count FROM runs`;
    expect(runs?.count).toBe(0);
  } finally {
    await owner`SELECT pg_advisory_unlock(1297043787, 1)`;
    owner.release();
  }
});

test("P2-02 S1 已有逐资源期限的浏览器清理必须全部等待，不能按总5秒截断", async () => {
  await seed();
  const fake = options();
  const closed: string[] = [];
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const result = await archiveSelectedPost(
    config(),
    postId,
    new AbortController().signal,
    undefined,
    async () => ({
      ...(await fake.connect()),
      cleanupBounded: true as const,
      close: async () => {
        try {
          for (const resource of ["工作页", "连接页", "连接"]) {
            await Bun.sleep(1800);
            closed.push(resource);
          }
        } finally {
          finish();
        }
      },
    }),
  );
  const closedAtReturn = [...closed];
  await done;
  expect(closedAtReturn).toEqual(["工作页", "连接页", "连接"]);
  expect(result).toMatchObject({
    status: "ok",
    archiveRecorded: true,
    cleanupErrors: [],
  });
}, 8000);

test.each(["新下载", "恢复发布意图"])(
  "P2-02 S1 %s 保存后临时名权限故障保留保存事实并禁止 DELETE",
  async (origin) => {
    const root = await seed();
    const fixture = options();
    if (origin === "恢复发布意图") {
      const digest = new Bun.CryptoHasher("sha256").update(media).digest("hex");
      await mkdir(join(root, postId));
      await writeFile(join(root, postId, ".recover.part"), media);
      await testSql`INSERT INTO post_work (post_id, goal, status, selected_key, quality, publish_temp_name, publish_relative_path, publish_expected_bytes, publish_sha256, mime_type)
      VALUES (${postId}, 'archive', 'finalizing', 'https://assets.grok.com/source.png', 'image', '.recover.part', ${`${postId}/${digest}.png`}, ${media.length}, ${digest}, 'image/png')`;
    }
    try {
      const result = await archiveSelectedPost(
        config(),
        postId,
        new AbortController().signal,
        (stage) => {
          if (stage === "保存结果已提交") chmodSync(join(root, postId), 0o500);
        },
        fixture.connect,
      );
      expect(result.cleanupErrors.join(" ")).toContain("临时文件清理失败");
      expect(result.message).toContain("Post 已保存，归档未完成；尚未发起移除");
      expect(fixture.requests).toEqual(
        origin === "新下载" ? [`detail:${postId}`, "media"] : [],
      );
      expect(result).toMatchObject({
        status: "failed",
        saveRecorded: true,
        archiveRecorded: false,
        remoteObservation: "not-requested",
      });
      expect(await work()).toMatchObject({
        status: "saved",
        removal_state: "none",
        archive_settled: false,
      });
    } finally {
      chmodSync(join(root, postId), 0o700);
    }
  },
);

test("P2-02 S1 归档结清后的停止保留已确认远端和归档事实", async () => {
  await seed();
  const fixture = options();
  const controller = new AbortController();
  const result = await archiveSelectedPost(
    config(),
    postId,
    controller.signal,
    (stage) => {
      if (stage === "核对收尾执行器锁") controller.abort();
    },
    fixture.connect,
  );
  expect(result).toMatchObject({
    status: "cancelled",
    archiveRecorded: true,
    remoteObservation: "removed",
  });
  expect(result.message).toContain("归档已结清");
  expect(result.message).toContain("远端已确认移除");
  expect(await work()).toMatchObject({
    archive_settled: true,
    removal_state: "removed",
  });
});

test.each(["removed", "unknown"] as const)(
  "P2-02 S1/S2 Run 收尾提交失败单独报告且保留 %s 事实",
  async (observation) => {
    await seed();
    await testSql.unsafe(
      `CREATE FUNCTION reject_run_finish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.finished_at IS NOT NULL THEN RAISE EXCEPTION '受控 Run 收尾失败'; END IF; RETURN NEW; END $$`,
    );
    await testSql`CREATE TRIGGER reject_run_finish BEFORE UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION reject_run_finish()`;
    try {
      const result = await archiveSelectedPost(
        config(),
        postId,
        new AbortController().signal,
        undefined,
        async () => ({
          ...(await options(
            observation === "unknown"
              ? { raw: { body: { unexpected: true } } }
              : {},
          ).connect()),
          checkPost: (await checkOptions({ status: 200, body: {} }).connect())
            .checkPost,
        }),
      );
      expect(result).toMatchObject({
        status: "failed",
        archiveRecorded: observation === "removed",
        remoteObservation: observation,
      });
      expect(result.message).toContain(
        observation === "removed" ? "归档已结清" : "移除结果未知",
      );
      expect(result.message).toContain("Run 收尾提交结果未知");
      expect(await work()).toMatchObject({
        archive_settled: observation === "removed",
        removal_state: observation === "removed" ? "removed" : "pending",
      });
      const output = await cli();
      expect(output.exitCode).toBe(1);
      expect(output.stderr).toContain(
        observation === "removed" ? "归档结清" : "移除结果未知",
      );
      expect(output.stderr).toContain("Run 收尾提交结果未知");
    } finally {
      await testSql`DROP TRIGGER reject_run_finish ON runs`;
      await testSql`DROP FUNCTION reject_run_finish()`;
    }
  },
);

test("P2-03 S1 在途首次停止收集认可响应并结清，退出事实仍可见", async () => {
  await seed();
  const fake = options();
  const controller = new AbortController();
  let requestAborted = false;
  let closed = false;
  const result = await archiveSelectedPost(
    config(),
    postId,
    controller.signal,
    undefined,
    async () => ({
      ...(await fake.connect()),
      deletePost: async (id: string, signal: AbortSignal) => {
        fake.requests.push(`delete:${id}`);
        controller.abort();
        await Bun.sleep(30);
        requestAborted = signal.aborted;
        if (signal.aborted) throw new Error("DELETE 响应被停止丢弃");
        return {
          status: 200,
          contentType: "application/json",
          body: {},
          finalUrl: `https://grok.com/rest/assets/${id}`,
          method: "DELETE",
          redirected: false,
        };
      },
      close: async () => {
        closed = true;
      },
    }),
  );
  expect(result).toMatchObject({
    status: "cancelled",
    remoteObservation: "removed",
    archiveRecorded: true,
    newRemovalConfirmed: true,
  });
  expect(result.message).toContain("归档已结清");
  expect(requestAborted).toBe(false);
  expect(closed).toBe(true);
  expect(fake.requests).toEqual([
    `detail:${postId}`,
    "media",
    `delete:${postId}`,
  ]);
  expect(await work()).toMatchObject({
    removal_state: "removed",
    archive_settled: true,
  });
});

test("P2-03 S1 进行20秒后首停仍在原30秒到期，取消无法确认时停止记账并独立清理", async () => {
  await seed();
  const fake = options();
  const controller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  let deleteStarted = 0;
  let closed = false;
  let firstStop: ReturnType<typeof setTimeout> | undefined;
  const result = await archiveSelectedPost(
    config(),
    postId,
    controller.signal,
    undefined,
    async () => ({
      ...(await fake.connect()),
      deletePost: async (id: string, signal: AbortSignal) => {
        fake.requests.push(`delete:${id}`);
        requestSignal = signal;
        deleteStarted = Date.now();
        firstStop = setTimeout(() => controller.abort(), 20_000);
        return new Promise<RawDeleteResponse>(() => {});
      },
      close: async () => {
        closed = true;
      },
    }),
  );
  clearTimeout(firstStop);
  expect(Date.now() - deleteStarted).toBeGreaterThanOrEqual(29_900);
  expect(Date.now() - deleteStarted).toBeLessThan(33_000);
  expect(requestSignal?.aborted).toBe(true);
  expect(result).toMatchObject({
    status: "cancelled",
    remoteObservation: "unknown",
    fatalExecution: true,
  });
  expect(result.cleanupErrors.join(" ")).toContain("DELETE 请求停止无法确认");
  expect(closed).toBe(true);
  expect(fake.requests).toEqual([
    `detail:${postId}`,
    "media",
    `delete:${postId}`,
  ]);
  expect(await work()).toMatchObject({
    removal_state: "pending",
    archive_settled: false,
  });
  const [run] =
    await testSql`SELECT outcome FROM runs ORDER BY started_at DESC LIMIT 1`;
  expect(run?.outcome).toBe(null);
  expect(
    await testSql`SELECT * FROM pg_locks WHERE locktype = 'advisory' AND granted AND classid = 1297043787::oid AND objid = 1::oid`,
  ).toHaveLength(0);
}, 36_000);

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
test(
  "P2-03 S2 在途真实第二次 SIGINT 立即退出130并保留待核对意图",
  () => signalDelete(true),
  15000,
);

test("P2-03 S1 首停收集认可响应后丢锁只报告远端事实，不继续 Post 记账", async () => {
  await seed();
  const fake = options();
  const controller = new AbortController();
  const result = await archiveSelectedPost(
    config(),
    postId,
    controller.signal,
    undefined,
    async () => ({
      ...(await fake.connect()),
      deletePost: async (id: string) => {
        fake.requests.push(`delete:${id}`);
        controller.abort();
        await testSql`SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND granted AND classid = 1297043787::oid AND objid = 1::oid`;
        return {
          status: 200,
          contentType: "application/json",
          body: {},
          finalUrl: `https://grok.com/rest/assets/${id}`,
          method: "DELETE",
          redirected: false,
        };
      },
    }),
  );
  expect(result).toMatchObject({
    status: "cancelled",
    remoteObservation: "removed",
    archiveRecorded: null,
    fatalExecution: true,
  });
  expect(await work()).toMatchObject({
    removal_state: "pending",
    archive_settled: false,
  });
  expect(fake.requests).toEqual([
    `detail:${postId}`,
    "media",
    `delete:${postId}`,
  ]);
});

test("P2-03 S2 删除意图后的真实许可等待可停止，保留意图且不发送", async () => {
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
        GROK_API_INTERVAL_MIN_SECONDS: "0.5",
        GROK_API_INTERVAL_MAX_SECONDS: "0.5",
        GMS_TEST_MEDIA: "1",
        GMS_TEST_REQUEST_EVENTS: events,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    const deadline = Date.now() + 5000;
    while ((await work())?.removal_state !== "pending" && Date.now() < deadline)
      await Bun.sleep(10);
    expect((await work())?.removal_state).toBe("pending");
    process.kill(child.pid, "SIGINT");
    const [stderr, code] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, stderr).toBe(130);
    expect(await readFile(events, "utf8")).not.toContain('"delete"');
    expect(await work()).toMatchObject({
      removal_state: "pending",
      archive_settled: false,
    });
  } finally {
    if (child.exitCode === null) {
      process.kill(child.pid, "SIGKILL");
      await child.exited;
    }
  }
}, 10000);

async function seedPendingArchive() {
  const root = await seed();
  const first = await cli({ GMS_TEST_DELETE_STATUS: "503" });
  expect(first.exitCode).toBe(1);
  expect((await work())?.removal_state).toBe("pending");
  return root;
}

function checkOptions(raw: Partial<RawCheckResponse> = {}) {
  const fake = options();
  return {
    requests: fake.requests,
    connect: async () => ({
      ...(await fake.connect()),
      checkPost: async (
        id: string,
        _signal?: AbortSignal,
        beforeRequest?: () => Promise<void>,
      ) => {
        await beforeRequest?.();
        fake.requests.push(`check:${id}`);
        return {
          status: 404,
          contentType: "application/json",
          body: { code: 5, message: "Asset not found" },
          finalUrl: `https://grok.com/rest/assets/${id}`,
          method: "GET",
          redirected: false,
          ...raw,
        };
      },
    }),
  };
}

test("P2-04 S1 遗留意图先精确核对，先持久removed再核验绑定文件并结清", async () => {
  await seedPendingArchive();
  const fake = checkOptions();
  let removalAtVerification: string | undefined;
  const result = await archiveSelectedPost(
    config(),
    postId,
    new AbortController().signal,
    (stage) => {
      if (stage === "移除确认已提交") removalAtVerification = "committed";
    },
    fake.connect,
  );
  expect(result).toMatchObject({
    status: "ok",
    remoteObservation: "removed",
    archiveRecorded: true,
    newRemovalConfirmed: true,
  });
  expect(removalAtVerification).toBe("committed");
  expect(fake.requests).toEqual([`check:${postId}`]);
  expect(await work()).toMatchObject({
    removal_state: "removed",
    archive_settled: true,
  });
});

test("P2-04 S1 认可GET之后丢锁保留远端观察，不改写待核对事实", async () => {
  await seedPendingArchive();
  const fake = checkOptions();
  const result = await archiveSelectedPost(
    config(),
    postId,
    new AbortController().signal,
    undefined,
    async () => ({
      ...(await fake.connect()),
      checkPost: async (id: string) => {
        const raw = await (await fake.connect()).checkPost(id);
        await testSql`SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory' AND granted AND classid=1297043787::oid AND objid=1::oid`;
        return raw;
      },
    }),
  );
  expect(result).toMatchObject({
    status: "failed",
    remoteObservation: "removed",
    archiveRecorded: null,
    newRemovalConfirmed: true,
    fatalExecution: true,
  });
  expect(await work()).toMatchObject({
    removal_state: "pending",
    archive_settled: false,
  });
  expect(fake.requests).toEqual([`check:${postId}`]);
  expect(result.message).toContain("远端已确认移除");
  expect(result.message).not.toContain("移除结果未知");
});

test("P3-01 S1 GET返回认可移除后立即停止仍保留新证据", async () => {
  await seedPendingArchive();
  const fake = checkOptions();
  const controller = new AbortController();
  const result = await archiveSelectedPost(
    config(),
    postId,
    controller.signal,
    undefined,
    async () => {
      const browser = await fake.connect();
      return {
        ...browser,
        checkPost: async (id: string) => {
          const response = await browser.checkPost(id);
          controller.abort();
          return response;
        },
      };
    },
  );
  expect(result).toMatchObject({
    status: "cancelled",
    remoteObservation: "removed",
    newRemovalConfirmed: true,
    archiveRecorded: false,
  });
  expect(fake.requests).toEqual([`check:${postId}`]);
  expect(await work()).toMatchObject({
    removal_state: "pending",
    archive_settled: false,
  });
});

test("P2-04 S1 认可仍存在GET之后丢锁保留存在说明和原意图", async () => {
  await seedPendingArchive();
  const before = await work();
  const fake = checkOptions({
    status: 200,
    body: { assetId: postId, isDeleted: false },
  });
  const result = await archiveSelectedPost(
    config(),
    postId,
    new AbortController().signal,
    undefined,
    async () => ({
      ...(await fake.connect()),
      checkPost: async (id: string) => {
        const raw = await (await fake.connect()).checkPost(id);
        await testSql`SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory' AND granted AND classid=1297043787::oid AND objid=1::oid`;
        return raw;
      },
    }),
  );
  expect(result).toMatchObject({
    status: "failed",
    remoteObservation: "present",
    archiveRecorded: false,
    fatalExecution: true,
  });
  expect(result.message).toContain("核对确认远端 Post 仍存在，归档未完成");
  expect(result.message).toContain("已停止");
  expect(result.message).not.toContain("移除结果未知");
  expect(await work()).toEqual(before);
  expect(fake.requests).toEqual([`check:${postId}`]);
});

test("P2-04 S1 结清发送前停止不写入，保留removed未结清", async () => {
  await seedPendingArchive();
  const fake = checkOptions();
  const controller = new AbortController();
  const result = await archiveSelectedPost(
    config(),
    postId,
    controller.signal,
    (stage) => {
      if (stage === "提交恢复归档结清") controller.abort();
    },
    fake.connect,
  );
  expect(result).toMatchObject({
    status: "cancelled",
    remoteObservation: "removed",
    archiveRecorded: false,
  });
  expect(await work()).toMatchObject({
    removal_state: "removed",
    archive_settled: false,
  });
});

test.each([
  { name: "任意404", raw: { body: { code: 6, message: "Asset not found" } } },
  { name: "HTML", raw: { contentType: "text/html", body: "login" } },
  {
    name: "错误目标",
    raw: {
      finalUrl:
        "https://grok.com/rest/assets/123e4567-e89b-42d3-a456-426614174001",
    },
  },
  { name: "重定向", raw: { redirected: true } },
  {
    name: "异常isDeleted",
    raw: { status: 200, body: { assetId: postId, isDeleted: true } },
  },
  { name: "不可靠认证", raw: { authenticationUnreliable: true } },
  { name: "限流", raw: { status: 429, retryAfter: "60" } },
  { name: "认证", raw: { status: 401 } },
  { name: "challenge", raw: { finalUrl: "https://grok.com/challenge" } },
])("P2-04 S1 原始GET $name 保留未知和原绑定且不追加请求", async ({ raw }) => {
  await seedPendingArchive();
  const before = await work();
  const fake = checkOptions(raw);
  const result = await archiveSelectedPost(
    config(),
    postId,
    new AbortController().signal,
    undefined,
    fake.connect,
  );
  expect(result).toMatchObject({
    status: ["限流", "认证", "challenge"].includes(
      raw.status === 429
        ? "限流"
        : raw.status === 401
          ? "认证"
          : raw.finalUrl?.includes("challenge")
            ? "challenge"
            : "",
    )
      ? "blocked"
      : "failed",
    remoteObservation: "unknown",
    archiveRecorded: false,
  });
  expect(await work()).toEqual(before);
  expect(fake.requests).toEqual([`check:${postId}`]);
});

test("P2-05 S1 无媒体存在判据先结清旧意图，再核验复用并仅删除一次", async () => {
  await seedPendingArchive();
  const before = await work();
  const fake = checkOptions({
    status: 200,
    body: { assetId: postId, isDeleted: false },
  });
  let atDetail: unknown;
  const result = await archiveSelectedPost(
    config(),
    postId,
    new AbortController().signal,
    undefined,
    async () => {
      const browser = await fake.connect();
      return {
        ...browser,
        getPostDetail: async (id: string) => {
          atDetail = await work();
          return browser.getPostDetail(id);
        },
      };
    },
  );
  expect(result).toMatchObject({
    status: "ok",
    remoteObservation: "removed",
    archiveRecorded: true,
    newRemovalConfirmed: true,
  });
  expect(atDetail).toMatchObject({
    removal_state: "none",
    deletion_media_version_id: null,
    saved_media_version_id: before?.saved_media_version_id,
    status: "saved",
  });
  expect(fake.requests).toEqual([
    `check:${postId}`,
    `detail:${postId}`,
    `delete:${postId}`,
  ]);
  expect(await work()).toMatchObject({
    archive_settled: true,
    deletion_media_version_id: before?.saved_media_version_id,
  });
});

test("P2-04 S1 GET确认移除后绑定文件冲突保留removed未结清，正确文件恢复后无请求结清", async () => {
  const root = await seedPendingArchive();
  const [version] =
    await testSql`SELECT relative_path FROM media_versions WHERE post_id=${postId}`;
  const path = join(root, String(version?.relative_path));
  await writeFile(path, Buffer.alloc(media.length, 1));
  const fake = checkOptions();
  const result = await archiveSelectedPost(
    config(),
    postId,
    new AbortController().signal,
    undefined,
    fake.connect,
  );
  expect(result).toMatchObject({
    status: "failed",
    remoteObservation: "removed",
    newRemovalConfirmed: true,
    archiveRecorded: false,
  });
  expect(await work()).toMatchObject({
    removal_state: "removed",
    archive_settled: false,
  });
  expect(fake.requests).toEqual([`check:${postId}`]);
  const next = await archiveSelectedPost(
    config(),
    postId,
    new AbortController().signal,
    undefined,
    fake.connect,
  );
  expect(next.status).toBe("failed");
  expect(fake.requests).toEqual([`check:${postId}`]);
  await writeFile(path, media);
  const restored = await archiveSelectedPost(
    config(),
    postId,
    new AbortController().signal,
    undefined,
    fake.connect,
  );
  expect(restored).toMatchObject({ status: "ok", archiveRecorded: true });
  expect(fake.requests).toEqual([`check:${postId}`]);
});

const removedCheckEnv = {
  GMS_TEST_CHECK_STATUS: "404",
  GMS_TEST_CHECK_BODY: '{"code":5,"message":"Asset not found"}',
};

test.each(["confirm", "recovered"])(
  "P2-04 S2 %s实际提交丢回执后停止，下次仅按真实DB恢复",
  async (stage) => {
    const root = await seedPendingArchive();
    const events = join(root, "recovery-requests");
    const result = await cli(
      {
        ...removedCheckEnv,
        GMS_TEST_REQUEST_EVENTS: events,
        GMS_TEST_LOSE_ARCHIVE_RECEIPT: stage,
      },
      postId,
      ["./tests/helpers/lose-archive-receipt.ts"],
    );
    expect(result.exitCode, JSON.stringify(result)).toBe(1);
    expect(result.stderr).toContain("提交结果未知");
    expect(await work()).toMatchObject({
      removal_state: "removed",
      archive_settled: stage === "recovered",
      last_error: null,
    });
    const [run] =
      await testSql`SELECT finished_at, outcome FROM runs ORDER BY started_at DESC LIMIT 1`;
    expect(run).toEqual({ finished_at: null, outcome: null });
    const requests = (await readFile(events, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(requests.map((item) => item.kind)).toEqual(["check"]);
    const resumed = await cli({ GMS_TEST_REQUEST_EVENTS: events });
    expect(resumed.exitCode, JSON.stringify(resumed)).toBe(0);
    expect((await work())?.archive_settled).toBe(true);
    expect((await readFile(events, "utf8")).trim().split("\n")).toHaveLength(1);
  },
);

test.each(["confirm", "recovered"])(
  "P2-04 S2 %s事务未提交立即停止且不继续核验或追写",
  async (stage) => {
    const root = await seedPendingArchive();
    const events = join(root, "recovery-requests");
    await testSql.unsafe(
      `CREATE FUNCTION reject_recovery_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${stage === "confirm" ? "NEW.removal_state = 'removed'" : "NEW.archive_settled"} THEN RAISE EXCEPTION '模拟恢复事务未提交'; END IF; RETURN NEW; END $$`,
    );
    await testSql`CREATE TRIGGER reject_recovery_write BEFORE UPDATE ON post_work FOR EACH ROW EXECUTE FUNCTION reject_recovery_write()`;
    try {
      const result = await cli({
        ...removedCheckEnv,
        GMS_TEST_REQUEST_EVENTS: events,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("提交结果未知");
      expect(result.stdout).not.toContain(
        stage === "confirm" ? "核验删除绑定文件" : "恢复归档结清已提交",
      );
      expect(await work()).toMatchObject({
        removal_state: stage === "confirm" ? "pending" : "removed",
        archive_settled: false,
        last_error: null,
      });
      const [run] =
        await testSql`SELECT finished_at, outcome FROM runs ORDER BY started_at DESC LIMIT 1`;
      expect(run).toEqual({ finished_at: null, outcome: null });
      expect(
        (await readFile(events, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line).kind),
      ).toEqual(["check"]);
    } finally {
      await testSql`DROP TRIGGER reject_recovery_write ON post_work`;
      await testSql`DROP FUNCTION reject_recovery_write()`;
    }
    const nextEvents = join(root, "restart-requests");
    const next = await cli({
      ...removedCheckEnv,
      GMS_TEST_REQUEST_EVENTS: nextEvents,
    });
    expect(next.exitCode, JSON.stringify(next)).toBe(0);
    expect(await work()).toMatchObject({
      removal_state: "removed",
      archive_settled: true,
    });
    if (stage === "confirm") {
      expect(
        (await readFile(nextEvents, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line).kind),
      ).toEqual(["check"]);
    } else {
      expect(await Bun.file(nextEvents).exists()).toBe(false);
    }
  },
);

test("P2-04 S1 首次GET发送前停止，无新请求或Post写入", async () => {
  await seedPendingArchive();
  const before = await work();
  const fake = checkOptions();
  const controller = new AbortController();
  const result = await archiveSelectedPost(
    config(),
    postId,
    controller.signal,
    (stage) => {
      if (stage === "核对精确 Post") controller.abort();
    },
    fake.connect,
  );
  expect(result.status).toBe("cancelled");
  expect(fake.requests).toEqual([]);
  expect(await work()).toEqual(before);
});

test("P2-04 S1 浏览器准备后丢锁，发送前再检查阻止GET", async () => {
  await seedPendingArchive();
  const before = await work();
  const fake = checkOptions();
  const result = await archiveSelectedPost(
    config(),
    postId,
    new AbortController().signal,
    undefined,
    async () => {
      await testSql`SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory' AND granted AND classid=1297043787::oid AND objid=1::oid`;
      return fake.connect();
    },
  );
  expect(result).toMatchObject({ status: "failed", fatalExecution: true });
  expect(fake.requests).toEqual([]);
  expect(await work()).toEqual(before);
});

test("P2-04 S1 GET从发起到完整响应固定30秒，无回执停止推进并清理", async () => {
  await seedPendingArchive();
  const fake = checkOptions();
  let requestSignal: AbortSignal | undefined;
  let started = 0;
  let closed = false;
  const result = await archiveSelectedPost(
    config(),
    postId,
    new AbortController().signal,
    undefined,
    async () => ({
      ...(await fake.connect()),
      checkPost: async (
        _id: string,
        signal: AbortSignal,
        beforeRequest: () => Promise<void>,
      ) => {
        await beforeRequest();
        started = Date.now();
        requestSignal = signal;
        return new Promise<RawCheckResponse>(() => {});
      },
      close: async () => {
        closed = true;
      },
    }),
  );
  expect(Date.now() - started).toBeGreaterThanOrEqual(29_900);
  expect(Date.now() - started).toBeLessThan(33_000);
  expect(requestSignal?.aborted).toBe(true);
  expect(closed).toBe(true);
  expect(result).toMatchObject({
    status: "failed",
    remoteObservation: "unknown",
    fatalExecution: true,
  });
  expect(result.cleanupErrors.join(" ")).toContain("请求停止无法确认");
  expect(await work()).toMatchObject({
    removal_state: "pending",
    archive_settled: false,
  });
}, 36_000);

test("P2-04 S2 实际GET在途SIGINT取消请求，原意图保持未知", async () => {
  const root = await seedPendingArchive();
  const events = join(root, "check-events");
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
        ...removedCheckEnv,
        GMS_TEST_REQUEST_EVENTS: events,
        GMS_TEST_CHECK_DELAY_MS: "10000",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    const deadline = Date.now() + 5000;
    while (!(await Bun.file(events).exists()) && Date.now() < deadline)
      await Bun.sleep(10);
    expect(await readFile(events, "utf8")).toContain('"check"');
    process.kill(child.pid, "SIGINT");
    const [stderr, code] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, stderr).toBe(130);
    expect(await work()).toMatchObject({
      removal_state: "pending",
      archive_settled: false,
    });
    expect((await readFile(events, "utf8")).trim().split("\n")).toHaveLength(1);
  } finally {
    if (child.exitCode === null) {
      process.kill(child.pid, "SIGKILL");
      await child.exited;
    }
  }
}, 10000);

const presentCheckEnv = {
  GMS_TEST_CHECK_STATUS: "200",
  GMS_TEST_CHECK_BODY: JSON.stringify({ assetId: postId, isDeleted: false }),
};

test("P2-05 S2 旧意图结清已提交丢回执，停止且下次按真实DB继续", async () => {
  const root = await seedPendingArchive();
  const before = await work();
  const events = join(root, "present-requests");
  const result = await cli(
    {
      ...presentCheckEnv,
      GMS_TEST_REQUEST_EVENTS: events,
      GMS_TEST_LOSE_ARCHIVE_RECEIPT: "present",
    },
    postId,
    ["./tests/helpers/lose-archive-receipt.ts"],
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("仍存在");
  expect(result.stderr).toContain("提交结果未知");
  expect(result.stderr).not.toContain("远端已确认移除");
  expect(await work()).toMatchObject({
    removal_state: "none",
    deletion_media_version_id: null,
    saved_media_version_id: before?.saved_media_version_id,
    last_error: null,
  });
  const [run] =
    await testSql`SELECT finished_at, outcome FROM runs ORDER BY started_at DESC LIMIT 1`;
  expect(run).toEqual({ finished_at: null, outcome: null });
  expect(
    (await readFile(events, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).kind),
  ).toEqual(["check"]);
  expect((await cli({ GMS_TEST_REQUEST_EVENTS: events })).exitCode).toBe(0);
  expect(
    (await readFile(events, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).kind),
  ).toEqual(["check", "detail", "delete"]);
});

test("P2-05 S2 旧意图结清未提交，保留绑定且无详情或DELETE追写", async () => {
  const root = await seedPendingArchive();
  const before = await work();
  const events = join(root, "present-requests");
  await testSql.unsafe(
    "CREATE FUNCTION reject_present_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.removal_state = 'pending' AND NEW.removal_state = 'none' THEN RAISE EXCEPTION '模拟旧意图事务未提交'; END IF; RETURN NEW; END $$",
  );
  await testSql`CREATE TRIGGER reject_present_write BEFORE UPDATE ON post_work FOR EACH ROW EXECUTE FUNCTION reject_present_write()`;
  try {
    const result = await cli({
      ...presentCheckEnv,
      GMS_TEST_REQUEST_EVENTS: events,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("仍存在");
    expect(result.stderr).toContain("提交结果未知");
    expect(await work()).toEqual(before);
    expect(
      (await readFile(events, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).kind),
    ).toEqual(["check"]);
    const [run] =
      await testSql`SELECT finished_at, outcome FROM runs ORDER BY started_at DESC LIMIT 1`;
    expect(run).toEqual({ finished_at: null, outcome: null });
  } finally {
    await testSql`DROP TRIGGER reject_present_write ON post_work`;
    await testSql`DROP FUNCTION reject_present_write()`;
  }
  const nextEvents = join(root, "restart-requests");
  const next = await cli({
    ...presentCheckEnv,
    GMS_TEST_REQUEST_EVENTS: nextEvents,
  });
  expect(next.exitCode, JSON.stringify(next)).toBe(0);
  expect(
    (await readFile(nextEvents, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).kind),
  ).toEqual(["check", "detail", "delete"]);
  expect(await work()).toMatchObject({
    removal_state: "removed",
    archive_settled: true,
  });
});

test.each(["changed", "missing", "conflict", "detail-failed", "finalizing"])(
  "P2-05 S1 旧意图结清后%s沿用保存规则并重新取得资格",
  async (kind) => {
    const root = await seedPendingArchive();
    const before = await work();
    const [version] =
      await testSql`SELECT relative_path, sha256, byte_count FROM media_versions WHERE post_id=${postId}`;
    const path = join(root, String(version?.relative_path));
    if (kind === "missing") await rm(path);
    if (kind === "conflict")
      await writeFile(path, Buffer.alloc(media.length, 1));
    if (kind === "finalizing")
      await testSql`UPDATE post_work SET status='finalizing',
      publish_temp_name='.missing.part', publish_relative_path=${version?.relative_path},
      publish_expected_bytes=${version?.byte_count}::bigint, publish_sha256=${version?.sha256} WHERE post_id=${postId}`;
    const fake = checkOptions({
      status: 200,
      body: { assetId: postId, isDeleted: false },
    });
    const result = await archiveSelectedPost(
      config(),
      postId,
      new AbortController().signal,
      undefined,
      async () => {
        const browser = await fake.connect();
        return {
          ...browser,
          getPostDetail: async (id: string) => {
            if (kind === "changed") {
              fake.requests.push(`detail:${id}`);
              return parsePostDetailResponse(id, {
                status: 200,
                contentType: "application/json",
                finalPath: `/rest/assets/${id}`,
                body: {
                  assetId: id,
                  key: "https://assets.grok.com/new.png",
                  mimeType: "image/png",
                },
              });
            }
            if (kind === "detail-failed") {
              fake.requests.push(`detail:${id}`);
              return parsePostDetailResponse(id, {
                status: 404,
                contentType: "application/json",
                finalPath: `/rest/assets/${id}`,
                body: {},
              });
            }
            return browser.getPostDetail(id);
          },
        };
      },
    );
    expect(result.status).toBe(
      ["conflict", "detail-failed"].includes(kind) ? "failed" : "ok",
    );
    expect(fake.requests[0]).toBe(`check:${postId}`);
    expect(fake.requests.filter((r) => r.startsWith("delete:"))).toHaveLength(
      ["conflict", "detail-failed"].includes(kind) ? 0 : 1,
    );
    if (["conflict", "detail-failed"].includes(kind))
      expect(await work()).toMatchObject({
        removal_state: "none",
        deletion_media_version_id: null,
        archive_settled: false,
      });
    else
      expect((await work())?.deletion_media_version_id).toBe(
        before?.saved_media_version_id,
      );
    if (["changed", "missing"].includes(kind))
      expect(fake.requests).toContain("media");
    if (kind === "conflict")
      expect(await readFile(path)).toEqual(Buffer.alloc(media.length, 1));
  },
);

test("P2-05 S1 来源变化产生新内容，只绑定重新保存版本并保留旧文件", async () => {
  const root = await seedPendingArchive();
  const before = await work();
  const [old] =
    await testSql`SELECT relative_path FROM media_versions WHERE post_id=${postId}`;
  const fake = checkOptions({
    status: 200,
    body: { assetId: postId, isDeleted: false },
  });
  const content = Buffer.concat([media, Buffer.from("new-version")]);
  const result = await archiveSelectedPost(
    config(),
    postId,
    new AbortController().signal,
    undefined,
    async () => ({
      ...(await fake.connect()),
      getPostDetail: async (id: string) => {
        fake.requests.push(`detail:${id}`);
        return parsePostDetailResponse(id, {
          status: 200,
          contentType: "application/json",
          finalPath: `/rest/assets/${id}`,
          body: {
            assetId: id,
            key: "https://assets.grok.com/new.png",
            mimeType: "image/png",
          },
        });
      },
      downloadMedia: async (_selection, onResponse, onChunk) => {
        fake.requests.push("media");
        await onResponse({
          status: 200,
          contentType: "image/png",
          contentLength: String(content.length),
          contentEncoding: null,
        });
        await onChunk(content);
      },
    }),
  );
  expect(result.status).toBe("ok");
  const after = await work();
  expect(after?.deletion_media_version_id).toBe(after?.saved_media_version_id);
  expect(after?.saved_media_version_id).not.toBe(
    before?.saved_media_version_id,
  );
  expect(
    await testSql`SELECT id FROM media_versions WHERE post_id=${postId}`,
  ).toHaveLength(2);
  expect(await readFile(join(root, String(old?.relative_path)))).toEqual(media);
  expect(fake.requests).toEqual([
    `check:${postId}`,
    `detail:${postId}`,
    "media",
    `delete:${postId}`,
  ]);
});

test("P2-06 S1 本次DELETE未知后精确GET确认移除并结清", async () => {
  await seed();
  const fake = checkOptions();
  const result = await archiveSelectedPost(
    config(),
    postId,
    new AbortController().signal,
    undefined,
    async () => {
      const browser = await fake.connect();
      return {
        ...browser,
        deletePost: async (id: string) => ({
          ...(await browser.deletePost(id)),
          status: 503,
        }),
      };
    },
  );
  expect(result).toMatchObject({
    status: "ok",
    remoteObservation: "removed",
    archiveRecorded: true,
  });
  expect(fake.requests).toEqual([
    `detail:${postId}`,
    "media",
    `delete:${postId}`,
    `check:${postId}`,
  ]);
  expect(await work()).toMatchObject({
    removal_state: "removed",
    archive_settled: true,
  });
});

test("P2-06 S1 两阶段各一次条件重试且共享非零许可，仍存在后无二次DELETE", async () => {
  await seedPendingArchive();
  const fake = checkOptions();
  let checks = 0;
  const starts: number[] = [];
  const scheduler = createRequestScheduler({
    minSeconds: 0.01,
    maxSeconds: 0.01,
  });
  const markStarted = () => {
    starts.push(Date.now());
    scheduler.requestStarted();
  };
  const result = await savePost(config(), postId, {
    goal: "archive",
    waitBeforeRetry: scheduler.beforeRequest,
    connect: async () => {
      const browser = await fake.connect();
      return {
        ...browser,
        getPostDetail: async (id: string) => {
          markStarted();
          return browser.getPostDetail(id);
        },
        deletePost: async (id: string) => {
          markStarted();
          return { ...(await browser.deletePost(id)), status: 503 };
        },
        checkPost: async (
          id: string,
          signal?: AbortSignal,
          beforeRequest?: () => Promise<void>,
        ) => {
          markStarted();
          const raw = await browser.checkPost(id, signal, beforeRequest);
          checks += 1;
          return checks === 1 || checks === 3
            ? { ...raw, status: 503, body: {} }
            : { ...raw, status: 200, body: { assetId: id, isDeleted: false } };
        },
      };
    },
  });
  expect(result).toMatchObject({
    status: "failed",
    remoteObservation: "present",
    archiveRecorded: false,
  });
  expect(fake.requests).toEqual([
    `check:${postId}`,
    `check:${postId}`,
    `detail:${postId}`,
    `delete:${postId}`,
    `check:${postId}`,
    `check:${postId}`,
  ]);
  expect(
    starts.slice(1).every((time, index) => time - (starts[index] ?? time) >= 5),
  ).toBe(true);
  expect(await work()).toMatchObject({
    removal_state: "none",
    deletion_media_version_id: null,
    archive_settled: false,
  });
});

test.each([408, 500, 503, 599])(
  "P2-06 S1 核对HTTP %s只条件重试一次并保留未知",
  async (status) => {
    await seedPendingArchive();
    const before = await work();
    const fake = checkOptions({ status, body: {} });
    const result = await archiveSelectedPost(
      config(),
      postId,
      new AbortController().signal,
      undefined,
      fake.connect,
    );
    expect(result).toMatchObject({
      status: "failed",
      remoteObservation: "unknown",
      archiveRecorded: false,
    });
    expect(fake.requests).toEqual([`check:${postId}`, `check:${postId}`]);
    expect(await work()).toEqual(before);
  },
);

test.each([
  { name: "未知结构", raw: { status: 200, body: {} }, expected: "failed" },
  { name: "普通403", raw: { status: 403, body: {} }, expected: "failed" },
  { name: "非认可404", raw: { status: 404, body: {} }, expected: "failed" },
  { name: "认证", raw: { status: 401, body: {} }, expected: "blocked" },
  { name: "限流", raw: { status: 429, body: {} }, expected: "blocked" },
  {
    name: "重定向5xx",
    raw: { status: 503, body: {}, redirected: true },
    expected: "failed",
  },
])("P2-06 S1 本次未知核对$name不重试", async ({ raw, expected }) => {
  await seed();
  const fake = checkOptions(raw);
  const result = await archiveSelectedPost(
    config(),
    postId,
    new AbortController().signal,
    undefined,
    async () => {
      const browser = await fake.connect();
      return {
        ...browser,
        deletePost: async (id: string) => ({
          ...(await browser.deletePost(id)),
          status: 503,
        }),
      };
    },
  );
  expect(result).toMatchObject({
    status: expected,
    remoteObservation: "unknown",
  });
  expect(
    fake.requests.filter((request) => request.startsWith("check:")),
  ).toHaveLength(1);
  expect(
    fake.requests.filter((request) => request.startsWith("delete:")),
  ).toHaveLength(1);
  expect(await work()).toMatchObject({
    removal_state: "pending",
    archive_settled: false,
  });
});

test.each(["network", "unconfirmed", "generic", "stop"])(
  "P2-06 S1 核对%s只有确认请求结束的网络错误可重试",
  async (kind) => {
    await seedPendingArchive();
    const controller = new AbortController();
    const fake = checkOptions();
    let attempts = 0;
    const result = await archiveSelectedPost(
      config(),
      postId,
      controller.signal,
      undefined,
      async () => {
        const browser = await fake.connect();
        return {
          ...browser,
          checkPost: async (
            id: string,
            signal?: AbortSignal,
            beforeRequest?: () => Promise<void>,
          ) => {
            const raw = await browser.checkPost(id, signal, beforeRequest);
            attempts += 1;
            if (attempts > 1) return raw;
            if (kind === "stop") controller.abort();
            if (kind === "network" || kind === "stop")
              throw new RetryableRequestError("请求已结束的网络错误");
            if (kind === "unconfirmed")
              throw new UnconfirmedStopError("无法确认请求结束");
            throw new Error("基础能力故障");
          },
        };
      },
    );
    expect(attempts).toBe(kind === "network" ? 2 : 1);
    expect(result.status).toBe(
      kind === "network" ? "ok" : kind === "stop" ? "cancelled" : "failed",
    );
    expect(fake.requests.every((request) => request.startsWith("check:"))).toBe(
      true,
    );
    expect(await work()).toMatchObject({
      removal_state: kind === "network" ? "removed" : "pending",
      archive_settled: kind === "network",
    });
  },
);

test("P2-06 S2 真实CLI本次未知GET确认移除与仍存在的退出和持久事实", async () => {
  await seed();
  const removed = await cli({
    GMS_TEST_DELETE_STATUS: "503",
    GMS_TEST_CHECK_STATUS: "404",
    GMS_TEST_CHECK_BODY: JSON.stringify({
      code: 5,
      message: "Asset not found",
    }),
  });
  expect(removed.exitCode, removed.stderr).toBe(0);
  expect(await work()).toMatchObject({
    removal_state: "removed",
    archive_settled: true,
  });
  await seed();
  const present = await cli({
    GMS_TEST_DELETE_STATUS: "503",
    GMS_TEST_CHECK_STATUS: "200",
    GMS_TEST_CHECK_BODY: JSON.stringify({ assetId: postId, isDeleted: false }),
  });
  expect(present.exitCode, present.stderr).toBe(1);
  expect(present.stderr).toContain("本 Run 不再 DELETE");
  expect(await work()).toMatchObject({
    removal_state: "none",
    deletion_media_version_id: null,
    archive_settled: false,
  });
});

async function seedRemovedMissing() {
  const root = await seedPendingArchive();
  await testSql`UPDATE post_work SET removal_state='removed' WHERE post_id=${postId}`;
  const [version] =
    await testSql`SELECT relative_path, sha256 FROM media_versions WHERE post_id=${postId}`;
  const path = join(root, String(version?.relative_path));
  await rm(path);
  return { root, path, version, before: await work() };
}

test("P2-07 S1 已移除缺失文件仅从绑定来源补回原版本", async () => {
  const { path, before } = await seedRemovedMissing();
  const fake = options();
  const result = await archiveSelectedPost(
    config(),
    postId,
    new AbortController().signal,
    undefined,
    fake.connect,
  );
  expect(result).toMatchObject({
    status: "ok",
    archiveRecorded: true,
    remoteObservation: "removed",
    newRemovalConfirmed: false,
  });
  expect(fake.requests).toEqual(["media"]);
  expect(await readFile(path)).toEqual(media);
  expect(await work()).toMatchObject({
    removal_state: "removed",
    archive_settled: true,
    deletion_media_version_id: before?.deletion_media_version_id,
  });
});

test.each(["S1", "S2"])(
  "P2-07 %s PNG声明JPEG原来源补救保留实际类型与绑定版本",
  async (seam) => {
    const root = await seed();
    const jpeg = Buffer.from("ffd8ffe000104a464946000101000001ffd9", "hex");
    const first = await cli({
      GMS_TEST_DELETE_STATUS: "503",
      GMS_TEST_PNG_DECLARED_JPEG: "1",
    });
    expect(first.exitCode).toBe(1);
    const before = await work();
    const [version] =
      await testSql`SELECT * FROM media_versions WHERE post_id=${postId}`;
    expect(version?.mime_type).toBe("image/jpeg");
    const path = join(root, String(version?.relative_path));
    await rm(path);
    await testSql`UPDATE post_work SET removal_state='removed' WHERE post_id=${postId}`;
    const events = join(root, "jpeg-bound-requests");
    if (seam === "S2") {
      const result = await cli({
        GMS_TEST_PNG_DECLARED_JPEG: "1",
        GMS_TEST_REQUEST_EVENTS: events,
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(
        (await readFile(events, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line).kind),
      ).toEqual(["media"]);
    } else {
      const fake = options();
      const result = await archiveSelectedPost(
        config(),
        postId,
        new AbortController().signal,
        undefined,
        async () => ({
          ...(await fake.connect()),
          downloadMedia: async (_selection, response, chunk) => {
            fake.requests.push("media");
            await response({
              status: 200,
              contentType: "image/png",
              contentLength: String(jpeg.length),
              contentEncoding: null,
            });
            await chunk(jpeg);
          },
        }),
      );
      expect(result.status, result.message).toBe("ok");
      expect(fake.requests).toEqual(["media"]);
    }
    expect(await readFile(path)).toEqual(jpeg);
    expect(await work()).toMatchObject({
      mime_type: "image/jpeg",
      source_mime_type: "image/png",
      deletion_media_version_id: before?.deletion_media_version_id,
      removal_state: "removed",
      archive_settled: true,
    });
    const versions =
      await testSql`SELECT * FROM media_versions WHERE post_id=${postId}`;
    expect(versions).toHaveLength(1);
    expect(versions[0]).toEqual(version);
  },
);

test.each(["临时文件", "正式文件"])(
  "P2-07 S1 优先恢复%s发布意图而不请求媒体",
  async (kind) => {
    const { root, path, version, before } = await seedRemovedMissing();
    const tempName = ".bound.part";
    await writeFile(
      kind === "临时文件" ? join(root, postId, tempName) : path,
      media,
    );
    await testSql`UPDATE post_work SET status='finalizing', publish_temp_name=${tempName}, publish_relative_path=${String(version?.relative_path)}, publish_expected_bytes=${media.length}, publish_sha256=${String(version?.sha256)} WHERE post_id=${postId}`;
    const fake = options();
    const result = await archiveSelectedPost(
      config(),
      postId,
      new AbortController().signal,
      undefined,
      fake.connect,
    );
    expect(result).toMatchObject({ status: "ok", archiveRecorded: true });
    expect(fake.requests).toEqual([]);
    expect(await readFile(path)).toEqual(media);
    expect(await work()).toMatchObject({
      deletion_media_version_id: before?.deletion_media_version_id,
      removal_state: "removed",
      archive_settled: true,
      publish_sha256: null,
    });
  },
);

test.each(["摘要不符", "来源失效", "类型不符", "冲突", "停止", "阻挡"])(
  "P2-07 S1 %s保留原绑定与已移除，人工放回后可结清",
  async (kind) => {
    const { path, before } = await seedRemovedMissing();
    const fake = options();
    const controller = new AbortController();
    let received: unknown;
    let attempts = 0;
    const result = await archiveSelectedPost(
      config(),
      postId,
      controller.signal,
      undefined,
      async () => {
        const browser = await fake.connect();
        return {
          ...browser,
          downloadMedia: async (selection, response, chunk, signal) => {
            received = selection;
            attempts += 1;
            fake.requests.push("bound-media");
            if (kind === "冲突")
              await writeFile(path, Buffer.alloc(media.length, 2));
            if (kind === "停止") controller.abort();
            await response({
              status: kind === "来源失效" ? 404 : kind === "阻挡" ? 429 : 200,
              contentType: kind === "类型不符" ? "image/jpeg" : "image/png",
              contentLength: String(media.length),
              contentEncoding: null,
            });
            if (!signal.aborted)
              await chunk(
                kind === "摘要不符"
                  ? Buffer.concat([media.subarray(0, -1), Buffer.from([1])])
                  : media,
              );
          },
        };
      },
    );
    expect(result.status).toBe(
      kind === "停止" ? "cancelled" : kind === "阻挡" ? "blocked" : "failed",
    );
    expect(result.remoteObservation).toBe("removed");
    expect(received).toMatchObject({
      assetId: postId,
      key: "https://assets.grok.com/source.png",
      mimeType: "image/png",
      expectedBytes: media.length,
    });
    expect(attempts).toBeLessThanOrEqual(2);
    expect(fake.requests.every((request) => request === "bound-media")).toBe(
      true,
    );
    expect(await work()).toMatchObject({
      deletion_media_version_id: before?.deletion_media_version_id,
      removal_state: "removed",
      archive_settled: false,
    });
    if (kind === "冲突")
      expect(await readFile(path)).toEqual(Buffer.alloc(media.length, 2));
    await writeFile(path, media);
    const next = options();
    const restored = await archiveSelectedPost(
      config(),
      postId,
      new AbortController().signal,
      undefined,
      next.connect,
    );
    expect(restored).toMatchObject({ status: "ok", archiveRecorded: true });
    expect(next.requests).toEqual([]);
  },
);

test("P2-07 S2 原来源补救仅发媒体请求并以原版本结清", async () => {
  const { root, path, before } = await seedRemovedMissing();
  const events = join(root, "bound-requests");
  const result = await cli({ GMS_TEST_REQUEST_EVENTS: events });
  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(await readFile(path)).toEqual(media);
  expect(
    (await readFile(events, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).kind),
  ).toEqual(["media"]);
  expect(await work()).toMatchObject({
    deletion_media_version_id: before?.deletion_media_version_id,
    removal_state: "removed",
    archive_settled: true,
  });
});

test.each(["发布意图", "保存结果", "结清"])(
  "P2-07 S2 %s提交丢回执停止且按真实DB继续",
  async (stage) => {
    const { root, before } = await seedRemovedMissing();
    const events = join(root, "bound-requests");
    const result = await cli(
      { GMS_TEST_REQUEST_EVENTS: events, GMS_TEST_LOSE_BOUND_RECEIPT: stage },
      postId,
      ["./tests/helpers/lose-bound-receipt.ts"],
    );
    expect(result.exitCode, JSON.stringify(result)).toBe(1);
    expect(result.stderr).toContain("提交结果未知");
    expect(await work()).toMatchObject({
      deletion_media_version_id: before?.deletion_media_version_id,
      removal_state: "removed",
      archive_settled: stage === "结清",
    });
    const next = await cli({ GMS_TEST_REQUEST_EVENTS: events });
    expect(next.exitCode, JSON.stringify(next)).toBe(0);
    expect(
      (await readFile(events, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).kind),
    ).toEqual(["media"]);
  },
);

test("P2-07 S1 绑定媒体503仅有限重试原来源，不重读详情", async () => {
  await seedRemovedMissing();
  const fake = options();
  let attempts = 0;
  const selections: unknown[] = [];
  const result = await archiveSelectedPost(
    config(),
    postId,
    new AbortController().signal,
    undefined,
    async () => {
      const browser = await fake.connect();
      return {
        ...browser,
        downloadMedia: async (selection, response, chunk) => {
          selections.push(selection);
          if (++attempts === 1)
            return response({
              status: 503,
              contentType: "image/png",
              contentLength: String(media.length),
              contentEncoding: null,
            });
          return browser.downloadMedia(selection, response, chunk);
        },
      };
    },
  );
  expect(result).toMatchObject({ status: "ok", archiveRecorded: true });
  expect(attempts).toBe(2);
  expect(selections[0]).toEqual(selections[1]);
  expect(fake.requests).toEqual(["media"]);
});

test("P2-07 S1 更换当前目录不搜索仍有正确文件的旧目录", async () => {
  const oldRoot = await seedPendingArchive();
  await testSql`UPDATE post_work SET removal_state='removed' WHERE post_id=${postId}`;
  const [version] =
    await testSql`SELECT relative_path FROM media_versions WHERE post_id=${postId}`;
  archiveRoot = await mkdtemp(join(tmpdir(), "gms-bound-new-root-"));
  try {
    const fake = options();
    const result = await archiveSelectedPost(
      config(),
      postId,
      new AbortController().signal,
      undefined,
      fake.connect,
    );
    expect(result).toMatchObject({ status: "ok", archiveRecorded: true });
    expect(fake.requests).toEqual(["media"]);
    expect(
      await readFile(join(archiveRoot, String(version?.relative_path))),
    ).toEqual(media);
    expect(
      await readFile(join(oldRoot, String(version?.relative_path))),
    ).toEqual(media);
  } finally {
    await rm(oldRoot, { recursive: true, force: true });
  }
});

test.each(["发布意图", "保存结果", "结清"])(
  "P2-07 S2 %s事务未提交停止并保留移除和绑定",
  async (stage) => {
    const { root, before } = await seedRemovedMissing();
    const condition =
      stage === "发布意图"
        ? "NEW.status = 'finalizing'"
        : stage === "保存结果"
          ? "OLD.status = 'finalizing' AND NEW.status = 'saved'"
          : "NEW.archive_settled";
    await testSql.unsafe(
      `CREATE FUNCTION reject_bound_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION '模拟绑定事务未提交'; END IF; RETURN NEW; END $$`,
    );
    await testSql`CREATE TRIGGER reject_bound_write BEFORE UPDATE ON post_work FOR EACH ROW EXECUTE FUNCTION reject_bound_write()`;
    const events = join(root, "bound-requests");
    try {
      const result = await cli({ GMS_TEST_REQUEST_EVENTS: events });
      expect(result.exitCode, JSON.stringify(result)).toBe(1);
      expect(result.stderr).toContain("提交结果未知");
      expect(await work()).toMatchObject({
        deletion_media_version_id: before?.deletion_media_version_id,
        removal_state: "removed",
        archive_settled: false,
        status: stage === "保存结果" ? "finalizing" : "saved",
      });
      expect(
        (await readFile(events, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line).kind),
      ).toEqual(["media"]);
    } finally {
      await testSql`DROP TRIGGER reject_bound_write ON post_work`;
      await testSql`DROP FUNCTION reject_bound_write()`;
    }
    expect((await cli()).exitCode).toBe(0);
  },
);

test.each(["丢锁", "断连"])(
  "P2-07 S1 补救浏览器准备时%s立即终止推进并保留绑定",
  async (kind) => {
    const { before } = await seedRemovedMissing();
    const fake = options();
    const result = await archiveSelectedPost(
      config(),
      postId,
      new AbortController().signal,
      undefined,
      async () => {
        if (kind === "断连") throw new Error("浏览器连接断开，基础能力不可用");
        await testSql`SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory' AND granted AND classid=1297043787::oid AND objid=1::oid`;
        return fake.connect();
      },
    );
    expect(result).toMatchObject({
      status: "failed",
      fatalExecution: true,
      remoteObservation: "removed",
    });
    expect(fake.requests).toEqual([]);
    expect(await work()).toMatchObject({
      removal_state: "removed",
      archive_settled: false,
      deletion_media_version_id: before?.deletion_media_version_id,
    });
  },
);

test.each(["停止", "丢锁", "准备失败"])(
  "P2-07 S1 本地媒体页准备时%s不发媒体请求且保留绑定",
  async (kind) => {
    const { before, path } = await seedRemovedMissing();
    const fake = options();
    const controller = new AbortController();
    let closed = false;
    const result = await archiveSelectedPost(
      config(),
      postId,
      controller.signal,
      undefined,
      async () => {
        const browser = await fake.connect();
        return {
          ...browser,
          prepareMediaPage: async () => {
            if (kind === "停止") controller.abort();
            else if (kind === "丢锁")
              await testSql`SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory' AND granted AND classid=1297043787::oid AND objid=1::oid`;
            else throw new Error("媒体工作页准备失败");
          },
          close: async () => {
            closed = true;
            await browser.close();
          },
        };
      },
    );
    expect(result.status).toBe(kind === "停止" ? "cancelled" : "failed");
    expect(fake.requests).toEqual([]);
    expect(closed).toBe(true);
    expect(await Bun.file(path).exists()).toBe(false);
    expect(await work()).toMatchObject({
      removal_state: "removed",
      archive_settled: false,
      deletion_media_version_id: before?.deletion_media_version_id,
    });
  },
);

test.each([
  {
    stage: "保存结果已提交",
    pending: false,
    removal: "none",
    settled: false,
    first: ["detail", "media"],
    next: ["detail", "delete"],
  },
  {
    stage: "删除意图已提交",
    pending: false,
    removal: "pending",
    settled: false,
    first: ["detail", "media"],
    next: ["check"],
  },
  {
    stage: "远端已确认移除",
    pending: false,
    removal: "pending",
    settled: false,
    first: ["detail", "media", "delete"],
    next: ["check"],
  },
  {
    stage: "移除确认已提交",
    pending: true,
    removal: "removed",
    settled: false,
    first: ["check"],
    next: [],
  },
  {
    stage: "恢复归档结清已提交",
    pending: true,
    removal: "removed",
    settled: true,
    first: ["check"],
    next: [],
  },
  {
    stage: "归档结清已提交",
    pending: false,
    removal: "removed",
    settled: true,
    first: ["detail", "media", "delete"],
    next: [],
  },
])(
  "P2-12 S2 $stage 真实SIGKILL后依据持久事实接续",
  async (window) => {
    const root = window.pending ? await seedPendingArchive() : await seed();
    const marker = join(root, "crash-marker");
    const events = join(root, "crash-requests");
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
          ...removedCheckEnv,
          GROK_ARCHIVE_DIR: root,
          PLAYWRIGHT_MCP_EXTENSION_TOKEN: "fixture-token",
          GROK_API_INTERVAL_MIN_SECONDS: "0",
          GROK_API_INTERVAL_MAX_SECONDS: "0",
          GMS_TEST_MEDIA: "1",
          GMS_TEST_REQUEST_EVENTS: events,
          GMS_TEST_STOP_STAGE: window.stage,
          GMS_TEST_STAGE_MARKER: marker,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const output = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    try {
      const deadline = Date.now() + 5000;
      while (!(await Bun.file(marker).exists()) && Date.now() < deadline)
        await Bun.sleep(10);
      expect(await Bun.file(marker).exists()).toBe(true);
      const before = await work();
      expect(before).toMatchObject({
        status: "saved",
        removal_state: window.removal,
        archive_settled: window.settled,
      });
      expect(
        (await readFile(events, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line).kind),
      ).toEqual([...window.first]);
      process.kill(child.pid, "SIGKILL");
      await child.exited;
      await output;
      const nextEvents = join(root, "restart-requests");
      const resumed = await cli({
        ...removedCheckEnv,
        GMS_TEST_REQUEST_EVENTS: nextEvents,
      });
      expect(resumed.exitCode, JSON.stringify(resumed)).toBe(0);
      const requests = (await Bun.file(nextEvents).exists())
        ? (await readFile(nextEvents, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [];
      expect(requests.map((item) => item.kind)).toEqual([...window.next]);
      expect(requests.every((item) => item.postId === postId)).toBe(true);
      const recovered = await work();
      expect(recovered).toMatchObject({
        removal_state: "removed",
        archive_settled: true,
      });
      expect(recovered?.saved_media_version_id).toBe(
        before?.saved_media_version_id,
      );
      expect(recovered?.deletion_media_version_id).toBe(
        before?.saved_media_version_id,
      );
      if (window.settled) expect(recovered).toEqual(before);
      const runs = await testSql<
        { outcome: string }[]
      >`SELECT outcome FROM runs ORDER BY started_at DESC LIMIT 2`;
      expect(runs.map((run) => run.outcome)).toEqual([
        "succeeded",
        "interrupted",
      ]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        process.kill(child.pid, "SIGKILL");
        await child.exited;
      }
      await output;
    }
  },
  20_000,
);
