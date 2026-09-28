import { expect, test } from "bun:test";
import {
  initializeProjectDatabase,
  readProjectStatus,
  retryUnfinishedPosts,
} from "../../src/application-runtime";
import { readDatabaseConfig } from "../../src/config";
import { databaseEnv, testSql, useIsolatedPostgres } from "../helpers/postgres";

useIsolatedPostgres();

test("P2-11 S1 空 retry 返回并持久记录互斥五类零计数", async () => {
  await testSql`DROP TABLE IF EXISTS media_versions, post_work, runs CASCADE`;
  const config = readDatabaseConfig(databaseEnv);
  expect((await initializeProjectDatabase(config)).status).toBe("ok");
  const result = await retryUnfinishedPosts(config);
  const summary = {
    saved: 0,
    archived: 0,
    skipped: 0,
    unconfirmed: 0,
    unprocessed: 0,
  };
  expect(result).toMatchObject({
    status: "ok",
    summary,
    summaryRecorded: true,
  });
  expect((await readProjectStatus(config)).latestRun?.summary).toEqual(summary);
});

const postId = "123e4567-e89b-42d3-a456-426614174001";
async function reset() {
  await testSql`DROP TABLE IF EXISTS media_versions, post_work, runs CASCADE`;
  expect(
    (await initializeProjectDatabase(readDatabaseConfig(databaseEnv))).status,
  ).toBe("ok");
}

async function cli(
  args: string[],
  extra: Record<string, string> = {},
  preloads: string[] = [],
) {
  const root = await mkdtemp(join(tmpdir(), "gms-summary-"));
  roots.push(root);
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--preload",
      "./tests/helpers/fake-save-browser.ts",
      ...preloads.flatMap((path) => ["--preload", path]),
      "src/cli.ts",
      ...args,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...databaseEnv,
        GROK_ARCHIVE_DIR: root,
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

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 子进程归档目录由每个场景持有，最终统一清理。
const roots: string[] = [];

import { afterAll } from "bun:test";

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

test("P2-11 S2 单目标归档完成后的清理失败保留归档计数", async () => {
  await reset();
  const result = await cli(["archive", "post", postId], {
    GMS_TEST_CLOSE_FAILURE: "1",
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("归档已结清");
  expect(result.stderr).toContain("归档完成 1");
  expect(result.stderr).toContain("未确认完成 0");
  expect(
    (await readProjectStatus(readDatabaseConfig(databaseEnv))).latestRun
      ?.summary,
  ).toEqual({
    saved: 0,
    archived: 1,
    skipped: 0,
    unconfirmed: 0,
    unprocessed: 0,
  });
});

for (const command of [
  ["save", "post", postId],
  ["archive", "post", postId],
  ["retry"],
]) {
  test(`P2-11 S2 ${command[0]} 摘要实际提交失回执保留 Post 完成事实`, async () => {
    await reset();
    if (command[0] === "retry")
      await testSql`INSERT INTO post_work(post_id,status,goal) VALUES (${postId},'failed','archive')`;
    const result = await cli(command, {}, [
      "./tests/helpers/lose-run-summary-receipt.ts",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("摘要提交结果未知");
    expect(result.stderr).not.toContain("摘要已持久记录");
    expect(result.stderr).toContain(
      command[0] === "save" ? "Post 保存完成" : "归档已结清",
    );
    expect(result.stderr).toContain(
      command[0] === "save" ? "保存完成 1" : "归档完成 1",
    );
    expect(
      (await readProjectStatus(readDatabaseConfig(databaseEnv))).latestRun
        ?.summary,
    ).toMatchObject(
      command[0] === "save"
        ? { saved: 1, archived: 0, unconfirmed: 0 }
        : { saved: 0, archived: 1, unconfirmed: 0 },
    );
    const status = await cli(["status"]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain(
      command[0] === "save" ? "保存完成 1" : "归档完成 1",
    );
  });
}

test("P2-11 S2 已结清跳过与混合 retry 分类互斥", async () => {
  await reset();
  await testSql`INSERT INTO post_work(post_id,status) VALUES (${postId},'failed')`;
  await seedSettledArchive(testSql, postId);
  const skipped = await cli(["archive", "post", postId]);
  expect(skipped.exitCode).toBe(0);
  expect(skipped.stdout).toContain("已结清跳过 1");
  expect(skipped.stdout).toContain("归档完成 0");
  const ids = [2, 3, 4, 5].map(
    (n) => `123e4567-e89b-42d3-a456-42661417400${n}`,
  );
  for (const [index, id] of ids.entries())
    await testSql`INSERT INTO post_work(post_id,status,goal) VALUES (${id},'failed',${index === 1 ? "archive" : "save"})`;
  const mixed = await cli(["retry"], { GMS_TEST_BLOCKED_ID: ids[2] ?? "" });
  expect(mixed.exitCode).toBe(1);
  expect(mixed.stderr).toContain(
    "保存完成 1，归档完成 1，已结清跳过 0，未确认完成 1，未处理 1",
  );
  expect(mixed.stderr).toContain("归档已结清");
  expect(
    (await readProjectStatus(readDatabaseConfig(databaseEnv))).latestRun
      ?.summary,
  ).toEqual({
    saved: 1,
    archived: 1,
    skipped: 0,
    unconfirmed: 1,
    unprocessed: 1,
  });
});

import { seedSettledArchive } from "../helpers/seed-settled-archive";

for (const command of [["archive", "post", postId], ["retry"]]) {
  test(`P2-11 S2 ${command[0]} 摘要未提交仍展示完成，status 不倒推计数`, async () => {
    await reset();
    if (command[0] === "retry")
      await testSql`INSERT INTO post_work(post_id,status,goal) VALUES (${postId},'failed','archive')`;
    await testSql`CREATE FUNCTION reject_summary() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '模拟摘要未提交'; END $$`;
    await testSql`CREATE TRIGGER reject_summary BEFORE UPDATE OF summary ON runs FOR EACH ROW EXECUTE FUNCTION reject_summary()`;
    try {
      const result = await cli(command);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("归档已结清");
      expect(result.stderr).toContain("归档完成 1");
      expect(result.stderr).toContain("摘要提交结果未知");
      const status = await cli(["status"]);
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain("结束时间和数量未知");
      expect(status.stdout).not.toContain("归档完成 1");
      expect(
        (await readProjectStatus(readDatabaseConfig(databaseEnv))).latestRun
          ?.summary,
      ).toBeNull();
    } finally {
      await testSql`DROP FUNCTION reject_summary() CASCADE`;
    }
  });
  test(`P2-11 S2 ${command[0]} 已完成后摘要失回执和清理失败仍优先退出130`, async () => {
    await reset();
    if (command[0] === "retry")
      await testSql`INSERT INTO post_work(post_id,status,goal) VALUES (${postId},'failed','archive')`;
    const result = await cli(
      command,
      {
        GMS_TEST_SUMMARY_STOP: "1",
        GMS_TEST_FINAL_CLOSE_FAILURE: "1",
        GMS_TEST_CLOSE_FAILURE: "1",
      },
      ["./tests/helpers/lose-run-summary-receipt.ts"],
    );
    expect(result.exitCode).toBe(130);
    expect(result.stderr).toContain("归档已结清");
    expect(result.stderr).toContain("归档完成 1");
    expect(result.stderr).toContain("清理失败");
    expect(result.stderr).toContain("摘要提交结果未知");
  });
}

test("P2-11 S2 崩溃遗留 Run 的计数未知，当前工作完成不回填历史", async () => {
  await reset();
  await testSql`INSERT INTO post_work(post_id,status) VALUES (${postId},'failed')`;
  await seedSettledArchive(testSql, postId);
  await testSql`INSERT INTO runs(id,command,started_at) VALUES (${crypto.randomUUID()}::uuid,'archive-post',now())`;
  const status = await cli(["status"]);
  expect(status.exitCode).toBe(0);
  expect(status.stdout).toContain("结束时间和数量未知");
  expect(status.stdout).not.toContain("归档完成 1");
  expect(status.stdout).not.toContain("归档完成 0");
});
