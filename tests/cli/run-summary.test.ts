import { expect, test } from "bun:test";
import {
  initializeProjectDatabase,
  readProjectStatus,
} from "../../src/application-runtime";
import { readDatabaseConfig } from "../../src/config";
import { databaseEnv, testSql, useIsolatedPostgres } from "../helpers/postgres";

useIsolatedPostgres();

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
