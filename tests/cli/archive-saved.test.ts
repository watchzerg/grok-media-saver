import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveSaved,
  initializeProjectDatabase,
  saveSelectedPost,
} from "../../src/application-runtime";
import { readDatabaseConfig, readSaveConfig } from "../../src/config";
import {
  type PageResponse,
  UnconfirmedStopError,
} from "../../src/grok/adapter";
import { databaseEnv, testSql, useIsolatedPostgres } from "../helpers/postgres";
import { statefulArchiveBrowser } from "../helpers/stateful-archive-browser";

useIsolatedPostgres();
const ids = [
  "123e4567-e89b-42d3-a456-426614174000",
  "123e4567-e89b-42d3-a456-426614174001",
  "123e4567-e89b-42d3-a456-426614174002",
] as const;
let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
const page = (...members: string[]): PageResponse => ({
  kind: "page",
  assets: members.map((assetId) => ({ assetId, mimeType: "image/png" })),
  hasNextPage: true,
});
async function setup(pages: PageResponse[]) {
  await testSql`DROP TABLE IF EXISTS media_versions, post_work, runs CASCADE`;
  expect(
    (await initializeProjectDatabase(readDatabaseConfig(databaseEnv))).status,
  ).toBe("ok");
  root = await mkdtemp(join(tmpdir(), "gms-archive-saved-"));
  const config = readSaveConfig({
    ...databaseEnv,
    GROK_ARCHIVE_DIR: root,
    PLAYWRIGHT_MCP_EXTENSION_TOKEN: "fixture",
    GROK_API_INTERVAL_MIN_SECONDS: "0",
    GROK_API_INTERVAL_MAX_SECONDS: "0",
  });
  const fake = statefulArchiveBrowser(pages);
  return { config, fake };
}

test("S1 连续归档两轮后合法空页完成，保持同一 Run 和连接并固定等待", async () => {
  const { config, fake } = await setup([page(ids[0]), page(ids[1]), page()]);
  const result = await archiveSaved(config, { connect: fake.connect });
  expect(result.status, JSON.stringify(result)).toBe("ok");
  expect(result.summary).toMatchObject({
    saved: 0,
    discovered: 2,
    archived: 2,
    skipped: 0,
    unconfirmed: 0,
    unprocessed: 0,
    newRemovals: 2,
    rounds: 2,
    lastRoundComplete: true,
    lastPage: "empty",
    endReason: "completed",
    leftovers: { save: 0, archive: 0 },
  });
  expect(fake.connections).toBe(1);
  expect(fake.closes).toBe(1);
  const pages = fake.requests.filter((r) => r.kind === "page");
  const deletions = fake.requests.filter((r) => r.kind === "delete");
  expect(pages).toHaveLength(3);
  expect(
    Number(pages[1]?.at) - Number(deletions[0]?.at),
  ).toBeGreaterThanOrEqual(4900);
  expect(
    Number(pages[2]?.at) - Number(deletions[1]?.at),
  ).toBeGreaterThanOrEqual(4900);
  const runs = await testSql`SELECT command, outcome, summary FROM runs`;
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({
    command: "archive-saved",
    outcome: "succeeded",
    summary: result.summary,
  });
  expect(
    await testSql`SELECT * FROM post_work WHERE NOT archive_settled`,
  ).toHaveLength(0);
}, 20000);

test("S1 空页遗留查询失败保留未知且持久记录已知批量观察", async () => {
  const { config, fake } = await setup([page()]);
  fake.onRequest = async (kind) => {
    if (kind === "page") await testSql`DROP TABLE post_work CASCADE`;
  };
  const result = await archiveSaved(config, { connect: fake.connect });
  expect(result.status).toBe("failed");
  expect(result.summary).toMatchObject({
    discovered: 0,
    rounds: 0,
    lastRoundComplete: null,
    lastPage: "empty",
    endReason: "fault",
    leftovers: null,
  });
  expect(result.summaryRecorded).toBe(true);
  const [run] = await testSql`SELECT summary, outcome FROM runs`;
  expect(run).toMatchObject({ summary: result.summary, outcome: "failed" });
});

test("S1 最后一项逐项收尾停止保留完整轮事实且不追加读页", async () => {
  const { config, fake } = await setup([page(ids[0]), page()]);
  const controller = new AbortController();
  const baseConnect = fake.connect;
  const result = await archiveSaved(config, {
    signal: controller.signal,
    connect: async (...args) => {
      const browser = await baseConnect(...args);
      return {
        ...browser,
        closePage: async () => {
          await browser.closePage();
          if (fake.removed.size) controller.abort();
        },
      };
    },
  });
  expect(result.status).toBe("cancelled");
  expect(result.summary).toMatchObject({
    archived: 1,
    newRemovals: 1,
    rounds: 1,
    lastRoundComplete: true,
    lastPage: "nonempty",
    endReason: "stopped",
  });
  expect(fake.requests.filter((r) => r.kind === "page")).toHaveLength(1);
});

test("S1 读页请求停止无法确认属于基础故障，禁止重试和补请求", async () => {
  const { config, fake } = await setup([page(ids[0])]);
  fake.onRequest = (kind) => {
    if (kind === "page")
      throw new UnconfirmedStopError("fixture request stop unknown");
  };
  const result = await archiveSaved(config, { connect: fake.connect });
  expect(result.summary).toMatchObject({
    lastPage: "failed",
    endReason: "fault",
    rounds: 0,
    discovered: 0,
  });
  expect(
    fake.requests.filter((r) => r.kind !== "close-page").map((r) => r.kind),
  ).toEqual(["page"]);
  expect(result.summaryRecorded).toBe(true);
});

test("S1 同页等价和跨轮成功失败重现不重做，不追加 No Progress 探测", async () => {
  const { config, fake } = await setup([
    page(ids[0].toUpperCase(), ids[0], ids[1]),
    page(ids[0], ids[1]),
    page(ids[2]),
  ]);
  fake.unavailable.add(ids[1]);
  const result = await archiveSaved(config, { connect: fake.connect });
  expect(result.summary).toMatchObject({
    discovered: 2,
    archived: 1,
    skipped: 0,
    unconfirmed: 1,
    unprocessed: 0,
    newRemovals: 1,
    rounds: 2,
    lastRoundComplete: true,
    lastPage: "nonempty",
    endReason: "no-progress",
    leftovers: { save: 0, archive: 1 },
  });
  expect(
    fake.requests.filter((r) => r.kind === "detail").map((r) => r.postId),
  ).toEqual([ids[0], ids[1]]);
  expect(fake.requests.filter((r) => r.kind === "delete")).toHaveLength(1);
  expect(fake.requests.filter((r) => r.kind === "page")).toHaveLength(2);
  expect(
    await testSql`SELECT * FROM post_work WHERE post_id=${ids[2]}`,
  ).toHaveLength(0);
}, 12000);

test("S1 空页必须分列全部历史遗留而不提升或自动重试 save 工作", async () => {
  const { config, fake } = await setup([page()]);
  await testSql`INSERT INTO post_work (post_id,goal,status) VALUES (${ids[0]},'save','failed'),(${ids[1]},'archive','pending')`;
  const result = await archiveSaved(config, { connect: fake.connect });
  expect(result).toMatchObject({
    status: "failed",
    summaryRecorded: true,
    summary: {
      endReason: "leftovers",
      leftovers: { save: 1, archive: 1 },
      discovered: 0,
      rounds: 0,
      lastRoundComplete: null,
      lastPage: "empty",
    },
  });
  expect(
    fake.requests.filter((r) => r.kind !== "close-page").map((r) => r.kind),
  ).toEqual(["page"]);
  expect(
    await testSql<
      { goal: string }[]
    >`SELECT goal FROM post_work WHERE post_id=${ids[0]}`,
  ).toEqual([{ goal: "save" }]);
});

test("S1 进展后阻挡保留完成事实和未开始成员，停止优先于下一轮", async () => {
  const { config, fake } = await setup([page(...ids), page()]);
  fake.blocked.add(ids[1]);
  const result = await archiveSaved(config, { connect: fake.connect });
  expect(result).toMatchObject({
    status: "blocked",
    summary: {
      discovered: 3,
      archived: 1,
      unconfirmed: 1,
      unprocessed: 1,
      newRemovals: 1,
      rounds: 1,
      lastRoundComplete: false,
      endReason: "blocked",
    },
  });
  expect(fake.requests.filter((r) => r.kind === "page")).toHaveLength(1);
  expect(
    fake.requests.filter((r) => r.kind === "detail").map((r) => r.postId),
  ).toEqual([ids[0], ids[1]]);
  expect(
    await testSql`SELECT * FROM post_work WHERE post_id=${ids[2]}`,
  ).toHaveLength(0);
});

test("S1 轮间等待取消立即停止，不等待五秒或再次读页", async () => {
  const { config, fake } = await setup([page(ids[0]), page()]);
  const controller = new AbortController();
  let waitingAt = 0;
  const result = await archiveSaved(config, {
    connect: fake.connect,
    signal: controller.signal,
    onStage: (stage) => {
      if (stage === "等待下一轮（5 秒）") {
        waitingAt = Date.now();
        setTimeout(() => controller.abort(), 25);
      }
    },
  });
  expect(result.status).toBe("cancelled");
  expect(Date.now() - waitingAt).toBeLessThan(1000);
  expect(result.summary).toMatchObject({
    archived: 1,
    newRemovals: 1,
    lastRoundComplete: true,
    endReason: "stopped",
  });
  expect(fake.requests.filter((r) => r.kind === "page")).toHaveLength(1);
});

test("S1 共享许可等待中停止，不请求详情或预建其余成员", async () => {
  const { config, fake } = await setup([page(ids[0], ids[1])]);
  config.requestIntervalMinSeconds = config.requestIntervalMaxSeconds = 2;
  const controller = new AbortController();
  fake.onRequest = (kind) => {
    if (kind === "page") setTimeout(() => controller.abort(), 25);
  };
  const result = await archiveSaved(config, {
    connect: fake.connect,
    signal: controller.signal,
  });
  expect(result).toMatchObject({
    status: "cancelled",
    summary: {
      unconfirmed: 1,
      unprocessed: 1,
      endReason: "stopped",
      lastRoundComplete: false,
    },
  });
  expect(
    fake.requests.filter((r) => r.kind !== "close-page").map((r) => r.kind),
  ).toEqual(["page"]);
  expect(
    await testSql`SELECT * FROM post_work WHERE post_id=${ids[1]}`,
  ).toHaveLength(0);
});

test("S1 一次 DELETE 执行后失回执以精确 GET 取得进展，列表重现不再删", async () => {
  const { config, fake } = await setup([page(ids[0]), page(ids[0])]);
  fake.lostDeleteReceipt.add(ids[0]);
  const result = await archiveSaved(config, { connect: fake.connect });
  expect(result.summary).toMatchObject({
    archived: 1,
    newRemovals: 1,
    rounds: 2,
    endReason: "no-progress",
  });
  expect(
    fake.requests
      .filter((r) => ["delete", "check"].includes(r.kind))
      .map((r) => `${r.kind}:${r.postId}`),
  ).toEqual([`delete:${ids[0]}`, `check:${ids[0]}`]);
}, 12000);

test("S1 逐项清理失败结束且已结清事实不抹去，独立资源继续关闭", async () => {
  const { config, fake } = await setup([page(ids[0], ids[1])]);
  fake.onRequest = (kind) => {
    if (kind === "delete") fake.closePageError = true;
  };
  const result = await archiveSaved(config, { connect: fake.connect });
  expect(result).toMatchObject({
    status: "failed",
    summary: {
      archived: 1,
      unprocessed: 1,
      newRemovals: 1,
      endReason: "fault",
    },
  });
  expect(result.cleanupErrors).toHaveLength(1);
  expect(fake.closes).toBe(1);
  expect(
    await testSql<
      { archive_settled: boolean }[]
    >`SELECT archive_settled FROM post_work WHERE post_id=${ids[0]}`,
  ).toEqual([{ archive_settled: true }]);
  expect(
    await testSql`SELECT * FROM post_work WHERE post_id=${ids[1]}`,
  ).toHaveLength(0);
});

test("S1 摘要提交后最终资源清理失败独立报告，持久成功摘要保留", async () => {
  const { config, fake } = await setup([page()]);
  fake.closeError = true;
  const result = await archiveSaved(config, { connect: fake.connect });
  expect(result.status).toBe("failed");
  expect(result.summaryRecorded).toBe(true);
  expect(result.cleanupErrors).toHaveLength(1);
  const [run] = await testSql`SELECT outcome, summary FROM runs`;
  expect(run).toMatchObject({
    outcome: "succeeded",
    summary: { endReason: "completed", leftovers: { save: 0, archive: 0 } },
  });
});

async function applicationProcess(
  config: ReturnType<typeof readSaveConfig>,
  preloads: string[] = [],
  extra: Record<string, string> = {},
) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      ...preloads.flatMap((path) => ["--preload", `./${path}`]),
      "tests/helpers/archive-saved-application.ts",
    ],
    {
      env: {
        ...databaseEnv,
        GROK_ARCHIVE_DIR: config.archiveRoot,
        PLAYWRIGHT_MCP_EXTENSION_TOKEN: "fixture",
        GROK_API_INTERVAL_MIN_SECONDS: "0",
        GROK_API_INTERVAL_MAX_SECONDS: "0",
        ...extra,
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
  expect(exit, stderr).toBe(0);
  return JSON.parse(stdout) as {
    result: Awaited<ReturnType<typeof archiveSaved>>;
    requests: { kind: string; postId?: string }[];
  };
}

test("S1 摘要实际提交后失回执保留本次观察和记账未知，不追写", async () => {
  const { config } = await setup([page()]);
  const { result } = await applicationProcess(config, [
    "tests/helpers/lose-run-summary-receipt.ts",
  ]);
  expect(result).toMatchObject({
    status: "failed",
    summaryRecorded: null,
    summary: { lastPage: "empty", leftovers: { save: 0, archive: 0 } },
  });
  const [run] = await testSql`SELECT outcome, finished_at, summary FROM runs`;
  expect(run?.finished_at).not.toBeNull();
  expect(run).toMatchObject({
    outcome: "succeeded",
    summary: { endReason: "completed", lastPage: "empty" },
  });
});

test("S1 摘要真实事务拒绝不假定回滚，历史摘要仍未知", async () => {
  const { config } = await setup([page()]);
  await testSql.unsafe(
    `CREATE OR REPLACE FUNCTION reject_batch_summary() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.summary IS NOT NULL THEN RAISE EXCEPTION 'fixture reject summary'; END IF; RETURN NEW; END $$`,
  );
  await testSql.unsafe(
    `CREATE TRIGGER reject_summary BEFORE UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION reject_batch_summary()`,
  );
  const { result } = await applicationProcess(config);
  expect(result).toMatchObject({
    status: "failed",
    summaryRecorded: null,
    summary: { discovered: 0, lastPage: "empty" },
  });
  const [run] = await testSql`SELECT summary, finished_at FROM runs`;
  expect(run).toEqual({ summary: null, finished_at: null });
});

test("S1 删除结清实际提交丢回执保留新移除且禁止遗留查询和摘要追写", async () => {
  const { config } = await setup([page()]);
  const { result, requests } = await applicationProcess(
    config,
    ["tests/helpers/lose-archive-receipt.ts"],
    {
      GMS_TEST_BATCH_IDS: JSON.stringify([ids[0], ids[1]]),
      GMS_TEST_LOSE_ARCHIVE_RECEIPT: "settle",
    },
  );
  expect(result).toMatchObject({
    status: "failed",
    summaryRecorded: false,
    summary: {
      newRemovals: 1,
      unconfirmed: 1,
      unprocessed: 1,
      leftovers: null,
      endReason: "fault",
    },
  });
  expect(requests.filter((r) => r.kind === "page")).toHaveLength(1);
  expect(
    requests.filter((r) => r.kind === "delete").map((r) => r.postId),
  ).toEqual([ids[0]]);
  expect(
    await testSql<
      { archive_settled: boolean }[]
    >`SELECT archive_settled FROM post_work WHERE post_id=${ids[0]}`,
  ).toEqual([{ archive_settled: true }]);
  const [run] = await testSql`SELECT summary, finished_at FROM runs`;
  expect(run).toEqual({ summary: null, finished_at: null });
});

test("S1 删除结清真实回滚仍保留新证据和未知提交，不续跑", async () => {
  const { config } = await setup([page()]);
  await testSql.unsafe(
    `CREATE OR REPLACE FUNCTION reject_batch_settle() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.archive_settled THEN RAISE EXCEPTION 'fixture reject archive settle'; END IF; RETURN NEW; END $$`,
  );
  await testSql.unsafe(
    `CREATE TRIGGER reject_settle BEFORE UPDATE ON post_work FOR EACH ROW EXECUTE FUNCTION reject_batch_settle()`,
  );
  const { result, requests } = await applicationProcess(config, [], {
    GMS_TEST_BATCH_IDS: JSON.stringify([ids[0], ids[1]]),
  });
  expect(result).toMatchObject({
    status: "failed",
    summaryRecorded: false,
    summary: {
      newRemovals: 1,
      unconfirmed: 1,
      unprocessed: 1,
      leftovers: null,
      endReason: "fault",
    },
  });
  expect(
    requests.filter((r) => r.kind === "delete").map((r) => r.postId),
  ).toEqual([ids[0]]);
  expect(
    await testSql<
      { archive_settled: boolean; removal_state: string }[]
    >`SELECT archive_settled, removal_state FROM post_work WHERE post_id=${ids[0]}`,
  ).toEqual([{ archive_settled: false, removal_state: "pending" }]);
});

test("S1 丢锁后的新移除只作观察，不修改工作或补写汇总", async () => {
  const { config, fake } = await setup([page(ids[0], ids[1])]);
  fake.onRequest = async (kind) => {
    if (kind === "delete")
      await testSql`SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory' AND granted`;
  };
  const result = await archiveSaved(config, { connect: fake.connect });
  expect(result).toMatchObject({
    status: "failed",
    summaryRecorded: false,
    summary: {
      newRemovals: 1,
      unconfirmed: 1,
      unprocessed: 1,
      leftovers: null,
      endReason: "fault",
    },
  });
  expect(
    fake.requests.filter((r) => r.kind === "delete").map((r) => r.postId),
  ).toEqual([ids[0]]);
  expect(
    await testSql<
      { archive_settled: boolean; removal_state: string }[]
    >`SELECT archive_settled, removal_state FROM post_work WHERE post_id=${ids[0]}`,
  ).toEqual([{ archive_settled: false, removal_state: "pending" }]);
});

test("S1 浏览器断连结束，保留已提交事实且不重新连接", async () => {
  const { config, fake } = await setup([page(ids[0], ids[1])]);
  fake.onRequest = (kind) => {
    if (kind === "delete") fake.disconnect();
  };
  const result = await archiveSaved(config, { connect: fake.connect });
  expect(result).toMatchObject({
    status: "failed",
    summary: {
      newRemovals: 1,
      archived: 1,
      unprocessed: 1,
      endReason: "fault",
    },
  });
  expect(fake.connections).toBe(1);
  expect(fake.requests.filter((r) => r.kind === "page")).toHaveLength(1);
  expect(
    await testSql`SELECT * FROM post_work WHERE post_id=${ids[1]}`,
  ).toHaveLength(0);
});

async function seedBound(
  config: ReturnType<typeof readSaveConfig>,
  id: string,
  removalState: "removed" | "pending",
) {
  const fake = statefulArchiveBrowser([]);
  expect(
    (
      await saveSelectedPost(
        config,
        id,
        new AbortController().signal,
        undefined,
        (signal) => fake.connect(signal, () => {}),
      )
    ).status,
  ).toBe("ok");
  await testSql`UPDATE post_work SET goal='archive', removal_state=${removalState}, deletion_media_version_id=saved_media_version_id WHERE post_id=${id}`;
  const [version] = await testSql<
    { relative_path: string }[]
  >`SELECT relative_path FROM media_versions WHERE post_id=${id}`;
  if (!version) throw new Error("Missing fixture saved version");
  return join(root, version.relative_path);
}

test("S1 旧移除事实的本地结清不算推进，不追加读页", async () => {
  const { config, fake } = await setup([page(ids[0]), page()]);
  await seedBound(config, ids[0], "removed");
  fake.removed.add(ids[0]);
  const result = await archiveSaved(config, { connect: fake.connect });
  expect(result.summary).toMatchObject({
    archived: 1,
    newRemovals: 0,
    endReason: "no-progress",
    rounds: 1,
    leftovers: { save: 0, archive: 0 },
  });
  expect(
    fake.requests.filter((r) => r.kind !== "close-page").map((r) => r.kind),
  ).toEqual(["page"]);
});

test("S1 旧未知意图本轮精确核对移除后的文件冲突仍算进展，其他成员继续", async () => {
  const { config, fake } = await setup([page(ids[0], ids[1]), page()]);
  const path = await seedBound(config, ids[0], "pending");
  await writeFile(path, "conflict");
  fake.removed.add(ids[0]);
  const result = await archiveSaved(config, { connect: fake.connect });
  expect(result.summary).toMatchObject({
    discovered: 2,
    archived: 1,
    unconfirmed: 1,
    newRemovals: 2,
    rounds: 1,
    endReason: "leftovers",
    lastPage: "empty",
    leftovers: { save: 0, archive: 1 },
  });
  expect(
    fake.requests
      .filter((r) => ["check", "detail", "delete"].includes(r.kind))
      .map((r) => `${r.kind}:${r.postId}`),
  ).toEqual([`check:${ids[0]}`, `detail:${ids[1]}`, `delete:${ids[1]}`]);
  expect(
    await testSql<
      { removal_state: string; archive_settled: boolean }[]
    >`SELECT removal_state, archive_settled FROM post_work WHERE post_id=${ids[0]}`,
  ).toEqual([{ removal_state: "removed", archive_settled: false }]);
}, 12000);

test("S1 旧已移除绑定文件缺失时补救原媒体，不发详情或 DELETE", async () => {
  const { config, fake } = await setup([page(ids[0]), page()]);
  const path = await seedBound(config, ids[0], "removed");
  await unlink(path);
  fake.removed.add(ids[0]);
  const result = await archiveSaved(config, { connect: fake.connect });
  expect(result.summary).toMatchObject({
    archived: 1,
    newRemovals: 0,
    endReason: "no-progress",
  });
  expect(
    fake.requests.filter((r) => r.kind !== "close-page").map((r) => r.kind),
  ).toEqual(["page", "media"]);
  expect(await Bun.file(path).exists()).toBe(true);
});

test("S1 非法页不部分采纳，有限临时读页失败不算轮次或空页", async () => {
  const { config, fake } = await setup([
    { kind: "temporary", status: 503 },
    { kind: "unknown" },
    page(ids[0]),
  ]);
  const result = await archiveSaved(config, { connect: fake.connect });
  expect(result).toMatchObject({
    status: "failed",
    summary: {
      discovered: 0,
      rounds: 0,
      lastPage: "failed",
      lastRoundComplete: null,
      endReason: "page-failed",
      leftovers: { save: 0, archive: 0 },
    },
  });
  expect(fake.requests.filter((r) => r.kind === "page")).toHaveLength(2);
  expect(await testSql`SELECT * FROM post_work`).toHaveLength(0);
});

test("S1 每次读页最多两次尝试，持续临时失败不追加第三请求", async () => {
  const { config, fake } = await setup([
    { kind: "temporary", status: 503 },
    { kind: "temporary", status: 503 },
    page(ids[0]),
  ]);
  const result = await archiveSaved(config, { connect: fake.connect });
  expect(result.summary).toMatchObject({
    rounds: 0,
    discovered: 0,
    lastPage: "failed",
    endReason: "page-failed",
  });
  expect(fake.requests.filter((r) => r.kind === "page")).toHaveLength(2);
});

test("S1 已结清首次跳过不检查文件，无进展直接退出", async () => {
  const { config, fake } = await setup([page(ids[0])]);
  const path = await seedBound(config, ids[0], "removed");
  await testSql`UPDATE post_work SET archive_settled=true WHERE post_id=${ids[0]}`;
  await unlink(path);
  const result = await archiveSaved(config, { connect: fake.connect });
  expect(result.summary).toMatchObject({
    archived: 0,
    skipped: 1,
    unconfirmed: 0,
    newRemovals: 0,
    endReason: "no-progress",
  });
  expect(
    fake.requests.filter((r) => r.kind !== "close-page").map((r) => r.kind),
  ).toEqual(["page"]);
  expect(await Bun.file(path).exists()).toBe(false);
});

test("S1 在途 DELETE 首次停止仍收集已发响应并记录必要事实，不再安排成员", async () => {
  const { config, fake } = await setup([page(ids[0], ids[1])]);
  const controller = new AbortController();
  fake.onRequest = (kind) => {
    if (kind === "delete") controller.abort();
  };
  const result = await archiveSaved(config, {
    connect: fake.connect,
    signal: controller.signal,
  });
  expect(result).toMatchObject({
    status: "cancelled",
    summaryRecorded: true,
    summary: {
      archived: 1,
      newRemovals: 1,
      unprocessed: 1,
      endReason: "stopped",
      lastRoundComplete: false,
    },
  });
  expect(
    fake.requests
      .filter((r) => ["delete", "check", "detail"].includes(r.kind))
      .map((r) => r.kind),
  ).toEqual(["detail", "delete"]);
  expect(
    await testSql<
      { archive_settled: boolean }[]
    >`SELECT archive_settled FROM post_work WHERE post_id=${ids[0]}`,
  ).toEqual([{ archive_settled: true }]);
});

test("S1 已有进展不能掩盖后续基础磁盘故障", async () => {
  const { config, fake } = await setup([page(...ids)]);
  await writeFile(join(root, ids[1]), "fixture blocks Post directory");
  const result = await archiveSaved(config, { connect: fake.connect });
  expect(result).toMatchObject({
    status: "failed",
    summary: {
      archived: 1,
      newRemovals: 1,
      unconfirmed: 1,
      unprocessed: 1,
      endReason: "fault",
    },
  });
  expect(fake.requests.filter((r) => r.kind === "page")).toHaveLength(1);
  expect(
    fake.requests.filter((r) => r.kind === "detail").map((r) => r.postId),
  ).toEqual([ids[0], ids[1]]);
  expect(
    await testSql`SELECT * FROM post_work WHERE post_id=${ids[2]}`,
  ).toHaveLength(0);
});

test("S1 五秒轮间等待后只补共享间隔余量，未叠加完整间隔", async () => {
  const { config, fake } = await setup([page(ids[0]), page()]);
  config.requestIntervalMinSeconds = config.requestIntervalMaxSeconds = 6;
  const result = await archiveSaved(config, { connect: fake.connect });
  expect(result.status, JSON.stringify(result)).toBe("ok");
  const lastDelete = fake.requests.find((r) => r.kind === "delete");
  const finalPage = fake.requests.filter((r) => r.kind === "page").at(-1);
  const gap = Number(finalPage?.at) - Number(lastDelete?.at);
  expect(gap).toBeGreaterThanOrEqual(5900);
  expect(gap).toBeLessThan(9000);
}, 35000);

test("S1 合法页清理失败仍保留完整发现事实，不预建或开始成员", async () => {
  const { config, fake } = await setup([page(ids[0], ids[1])]);
  fake.closePageError = true;
  const result = await archiveSaved(config, { connect: fake.connect });
  expect(result).toMatchObject({
    status: "failed",
    summaryRecorded: true,
    summary: {
      discovered: 2,
      unprocessed: 2,
      rounds: 0,
      lastRoundComplete: null,
      lastPage: "nonempty",
      endReason: "fault",
    },
  });
  expect(await testSql`SELECT * FROM post_work`).toHaveLength(0);
  expect(
    fake.requests.filter((r) => r.kind !== "close-page").map((r) => r.kind),
  ).toEqual(["page"]);
});

test("S1 浏览器逐资源清理自带期限时不被外层五秒总期限截断", async () => {
  const { config, fake } = await setup([page()]);
  const connect = fake.connect;
  const result = await archiveSaved(config, {
    connect: async (...args) => {
      const browser = await connect(...args);
      return {
        ...browser,
        close: async () => {
          await Bun.sleep(3000);
          await Bun.sleep(3000);
          await browser.close();
        },
      };
    },
  });
  expect(result.status).toBe("ok");
  expect(result.cleanupErrors).toHaveLength(0);
  expect(fake.closes).toBe(1);
}, 10000);

for (const existingSave of [false, true]) {
  test(`S1 成员锁核对期间停止保持未处理且${existingSave ? "不提升纯 save 目标" : "不创建归档工作"}`, async () => {
    const { config, fake } = await setup([page(ids[0])]);
    if (existingSave) {
      const saved = await saveSelectedPost(
        config,
        ids[0],
        new AbortController().signal,
        undefined,
        (signal) => fake.connect(signal, () => {}),
      );
      expect(saved.status).toBe("ok");
    }
    const before = await testSql`SELECT * FROM post_work ORDER BY post_id`;
    const { result, requests } = await applicationProcess(
      config,
      ["tests/helpers/stop-batch-member-lock.ts"],
      {
        GMS_TEST_BATCH_IDS: JSON.stringify([ids[0]]),
        GMS_TEST_BATCH_STOP_MEMBER_LOCK: "1",
      },
    );
    expect(result.status).toBe("cancelled");
    expect(await testSql`SELECT * FROM post_work ORDER BY post_id`).toEqual(
      before,
    );
    expect(result.summary).toMatchObject({
      discovered: 1,
      archived: 0,
      skipped: 0,
      unconfirmed: 0,
      unprocessed: 1,
      newRemovals: 0,
      rounds: 1,
      lastRoundComplete: false,
      lastPage: "nonempty",
      endReason: "stopped",
      leftovers: { save: 0, archive: 0 },
    });
    expect(result.posts).toHaveLength(0);
    expect(requests.map((request) => request.kind)).toEqual([
      "page",
      "close-page",
    ]);
    const [run] =
      await testSql`SELECT outcome, summary FROM runs WHERE command='archive-saved'`;
    expect(run).toMatchObject({ outcome: "stopped", summary: result.summary });
    expect(result.summaryRecorded).toBe(true);
    const [locks] =
      await testSql`SELECT count(*)::integer AS count FROM pg_locks WHERE locktype='advisory' AND classid=1297043787::oid AND objid=1::oid`;
    expect(locks?.count).toBe(0);
  }, 20000);
}
