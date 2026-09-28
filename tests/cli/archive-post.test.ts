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
import { readDatabaseConfig, readSaveConfig } from "../../src/config";
import {
  parsePostDetailResponse,
  type RawCheckResponse,
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
  return {
    requests,
    connect: async () => ({
      getPostDetail: async (id: string) => {
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

test("P2-02 S1 显式提升 save 并核验复用同一版本，终态跳过不访问资源", async () => {
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
  expect(again.message).toContain("直接跳过");
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
        options(
          observation === "unknown"
            ? { raw: { body: { unexpected: true } } }
            : {},
        ).connect,
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
      ).toEqual(["check"]);
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

test("P2-04 S1 isDeleted false 无媒体结构也确认存在，保留意图明确未完成", async () => {
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
    fake.connect,
  );
  expect(result).toMatchObject({
    status: "failed",
    remoteObservation: "present",
    archiveRecorded: false,
  });
  expect(result.message).toContain("仍存在");
  expect(await work()).toEqual(before);
  expect(fake.requests).toEqual([`check:${postId}`]);
});

test.each(["missing", "conflict"])(
  "P2-04 S1 GET确认移除后绑定文件%s保留removed未结清，正确文件恢复后无请求结清",
  async (kind) => {
    const root = await seedPendingArchive();
    const [version] =
      await testSql`SELECT relative_path FROM media_versions WHERE post_id=${postId}`;
    const path = join(root, String(version?.relative_path));
    if (kind === "missing") await rm(path);
    else await writeFile(path, Buffer.alloc(media.length, 1));
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
  },
);

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
