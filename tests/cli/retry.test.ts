import { expect, test } from "bun:test";
import {
  initializeProjectDatabase,
  retryUnfinishedPosts,
} from "../../src/application-runtime";
import { readDatabaseConfig } from "../../src/config";
import { databaseEnv, testSql } from "../helpers/postgres";

test("retry records a successful empty run without connecting to the browser", async () => {
  await testSql`DROP TABLE IF EXISTS media_versions, post_work, runs CASCADE`;
  expect(
    (await initializeProjectDatabase(readDatabaseConfig(databaseEnv))).status,
  ).toBe("ok");

  const result = await runCli(databaseEnv, ["retry"]);
  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(result.stdout).toContain("没有未完成 Post");
  expect(result.stderr).toBe("");

  const [run] = await testSql<
    {
      command: string;
      finished_at: Date | null;
      outcome: string | null;
      summary: unknown;
    }[]
  >`SELECT command, finished_at, outcome, summary FROM runs`;
  expect(run?.command).toBe("retry");
  expect(run?.finished_at).toBeInstanceOf(Date);
  expect(run?.outcome).toBe("succeeded");
  expect(run?.summary).toEqual({ saved: 0, failed: 0, unprocessed: 0 });

  const status = await runCli(databaseEnv, ["status"]);
  expect(status.exitCode).toBe(0);
  expect(status.stdout).toContain("结果：succeeded");
  expect(status.stdout).toContain("已保存 0");
});

test("competing retry subprocesses share one database lock regardless of archive root", async () => {
  await resetSchema();
  const holder = await testSql.reserve();
  try {
    const [acquired] = await holder<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_lock(1297043787, 1) AS acquired
    `;
    expect(acquired?.acquired).toBe(true);
    const competing = await runCli(
      { ...databaseEnv, GROK_ARCHIVE_DIR: "/tmp/archive-b" },
      ["retry"],
    );
    expect(competing.exitCode).toBe(1);
    expect(competing.stderr).toContain("已有保存执行正在运行");
    const [count] = await testSql<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM runs WHERE command = 'retry'
    `;
    expect(count?.count).toBe(0);
  } finally {
    await holder`SELECT pg_advisory_unlock(1297043787, 1)`;
    holder.release();
  }
});

test("retry with unfinished work fails instead of reporting an empty success", async () => {
  await resetSchema();
  await testSql`
    INSERT INTO post_work (post_id, status, last_error)
    VALUES ('123e4567-e89b-42d3-a456-426614174000', 'failed', 'HTTP 404')
  `;

  const result = await runCli(databaseEnv, ["retry"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("尚未实现非空重试");
  expect(result.stdout).toBe("");
  const [run] = await testSql<
    { finished_at: Date | null; outcome: string | null; summary: unknown }[]
  >`SELECT finished_at, outcome, summary FROM runs`;
  expect(run?.finished_at).toBeInstanceOf(Date);
  expect(run?.outcome).toBe("failed");
  expect(run?.summary).toBeNull();
});

test("retry stops and leaves the Run unaccounted when its session lock is lost", async () => {
  await resetSchema();
  await testSql.unsafe(`
    CREATE FUNCTION drop_executor_lock() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_advisory_unlock(1297043787, 1);
      RETURN NEW;
    END
    $$
  `);
  await testSql.unsafe(`
    CREATE TRIGGER drop_executor_lock BEFORE INSERT ON runs
    FOR EACH ROW WHEN (NEW.command = 'retry') EXECUTE FUNCTION drop_executor_lock()
  `);

  try {
    const result = await runCli(databaseEnv, ["retry"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("执行器会话锁已丢失");
    const [run] = await testSql<
      { finished_at: Date | null; outcome: string | null; summary: unknown }[]
    >`SELECT finished_at, outcome, summary FROM runs`;
    expect(run?.finished_at).toBeNull();
    expect(run?.outcome).toBeNull();
    expect(run?.summary).toBeNull();
  } finally {
    await testSql.unsafe("DROP TRIGGER IF EXISTS drop_executor_lock ON runs");
    await testSql.unsafe("DROP FUNCTION IF EXISTS drop_executor_lock()");
  }
});

test("retry marks legacy open Runs interrupted without inventing a finish or summary", async () => {
  await resetSchema();
  await testSql`
    INSERT INTO runs (id, command, started_at)
    VALUES ('123e4567-e89b-42d3-a456-426614174001', 'save-post', now())
  `;

  const result = await runCli(databaseEnv, ["retry"]);
  expect(result.exitCode).toBe(0);
  const runs = await testSql<
    {
      command: string;
      finished_at: Date | null;
      outcome: string | null;
      summary: unknown;
    }[]
  >`SELECT command, finished_at, outcome, summary FROM runs ORDER BY command`;
  expect(runs).toContainEqual({
    command: "save-post",
    finished_at: null,
    outcome: "interrupted",
    summary: null,
  });
  expect(runs.find((run) => run.command === "retry")?.outcome).toBe(
    "succeeded",
  );
});

test("retry validates parameters and configuration before database startup", async () => {
  const usage = await runCli(databaseEnv, ["retry", "extra"]);
  expect(usage.exitCode).toBe(2);
  expect(usage.stderr).toContain("用法");

  const missingConfig = await runCli({ PATH: process.env.PATH ?? "" }, [
    "retry",
  ]);
  expect(missingConfig.exitCode).toBe(2);
  expect(missingConfig.stderr).toContain("GROK_DB_HOST");
  expect(missingConfig.stderr).not.toContain("PLAYWRIGHT_MCP_EXTENSION_TOKEN");
});

test("retry preserves its completed Run and reports an independent close failure", async () => {
  await resetSchema();
  const result = await retryUnfinishedPosts(
    readDatabaseConfig(databaseEnv),
    async (sql, timeoutSeconds) => {
      expect(timeoutSeconds).toBe(5);
      await sql.close({ timeout: timeoutSeconds });
      throw new Error("simulated database close failure");
    },
  );

  expect(result.status).toBe("failed");
  expect(result.message).toContain("重试 Run 已记录");
  expect(result.cleanupErrors).toEqual([
    "数据库关闭失败：simulated database close failure",
  ]);
  const [run] = await testSql<{ outcome: string }[]>`
    SELECT outcome FROM runs WHERE command = 'retry'
  `;
  expect(run?.outcome).toBe("succeeded");
});

async function runCli(env: Record<string, string>, args: string[]) {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "src/cli.ts", ...args],
    { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function resetSchema() {
  await testSql`DROP TABLE IF EXISTS media_versions, post_work, runs CASCADE`;
  expect(
    (await initializeProjectDatabase(readDatabaseConfig(databaseEnv))).status,
  ).toBe("ok");
}
