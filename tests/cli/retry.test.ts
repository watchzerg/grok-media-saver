import { expect, test } from "bun:test";
import {
  initializeProjectDatabase,
  retryUnfinishedPosts,
} from "../../src/application-runtime";
import { readDatabaseConfig } from "../../src/config";
import { databaseEnv, testSql, useIsolatedPostgres } from "../helpers/postgres";

useIsolatedPostgres();

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
  await installRetryDelayTrigger();
  const firstProcess = startCli(
    { ...databaseEnv, GROK_ARCHIVE_DIR: "/tmp/archive-a" },
    ["retry"],
  );
  try {
    expect(await waitForRetryDelay()).toBe(true);
    const secondProcess = startCli(
      { ...databaseEnv, GROK_ARCHIVE_DIR: "/tmp/archive-b" },
      ["retry"],
    );
    const competing = await collectCli(secondProcess);
    const first = await collectCli(firstProcess);
    expect(competing.exitCode).toBe(1);
    expect(competing.stderr).toContain("已有保存执行正在运行");
    expect(first.exitCode).toBe(0);
    const afterRelease = await runCli(databaseEnv, ["retry"]);
    expect(afterRelease.exitCode).toBe(0);
    const [count] = await testSql<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM runs WHERE command = 'retry'
    `;
    expect(count?.count).toBe(2);
  } finally {
    await dropRetryDelayTrigger();
  }
});

test("SIGINT stops retry with exit 130 and records its Run before cleanup", async () => {
  await resetSchema();
  await installRetryDelayTrigger();
  try {
    const child = startCli(databaseEnv, ["retry"]);
    expect(await waitForRetryDelay()).toBe(true);
    child.kill("SIGINT");

    const result = await collectCli(child);
    expect(result.exitCode).toBe(130);
    expect(result.stderr).toContain("Run 已记录停止结果");
    const [run] = await testSql<
      { finished_at: Date | null; outcome: string | null; summary: unknown }[]
    >`SELECT finished_at, outcome, summary FROM runs`;
    expect(run?.finished_at).toBeInstanceOf(Date);
    expect(run?.outcome).toBe("stopped");
    expect(run?.summary).toBeNull();
  } finally {
    await dropRetryDelayTrigger();
  }
});

test("SIGINT during Run completion returns 130 while keeping the committed success", async () => {
  await resetSchema();
  await installRetryFinishDelayTrigger();
  try {
    const child = startCli(databaseEnv, ["retry"]);
    expect(await waitForRetryDelay()).toBe(true);
    child.kill("SIGINT");

    const result = await collectCli(child);
    expect(result.exitCode).toBe(130);
    expect(result.stderr).toContain("停止信号");
    const [run] = await testSql<
      { finished_at: Date | null; outcome: string | null; summary: unknown }[]
    >`SELECT finished_at, outcome, summary FROM runs`;
    expect(run?.finished_at).toBeInstanceOf(Date);
    expect(run?.outcome).toBe("succeeded");
    expect(run?.summary).toEqual({ saved: 0, failed: 0, unprocessed: 0 });
  } finally {
    await dropRetryFinishDelayTrigger();
  }
});

test("SIGINT during a rejected Run insert does not claim a stopped Run was recorded", async () => {
  await resetSchema();
  await installRetryInsertFailureTrigger();
  try {
    const child = startCli(databaseEnv, ["retry"]);
    expect(await waitForRetryDelay()).toBe(true);
    child.kill("SIGINT");

    const result = await collectCli(child);
    expect(result.exitCode).toBe(130);
    expect(result.stderr).not.toContain("Run 已记录停止结果");
    const [run] = await testSql<{ id: string }[]>`
      SELECT id FROM runs WHERE command = 'retry'
    `;
    expect(run).toBeUndefined();
  } finally {
    await dropRetryInsertFailureTrigger();
  }
});

test("retry does not compensate after a failed Run completion write", async () => {
  await resetSchema();
  await installRetryFinishFailureTrigger();
  try {
    const result = await runCli(databaseEnv, ["retry"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("结果未知");
    const [run] = await testSql<
      { outcome: string | null; finished_at: Date | null }[]
    >`SELECT outcome, finished_at FROM runs WHERE command = 'retry'`;
    expect(run?.outcome).toBeNull();
    expect(run?.finished_at).toBeNull();
    const [attempts] = await testSql<{ lastValue: string }[]>`
      SELECT last_value::text AS "lastValue" FROM retry_finish_attempt_seq
    `;
    expect(attempts?.lastValue).toBe("1");
  } finally {
    await dropRetryFinishFailureTrigger();
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

test("stopped retry keeps exit classification and reports cleanup failure separately", async () => {
  await resetSchema();
  await installRetryDelayTrigger();
  const controller = new AbortController();
  try {
    const resultPromise = retryUnfinishedPosts(
      readDatabaseConfig(databaseEnv),
      async (sql, timeoutSeconds) => {
        await sql.close({ timeout: timeoutSeconds });
        throw new Error("simulated stop cleanup failure");
      },
      controller.signal,
    );
    expect(await waitForRetryDelay()).toBe(true);
    controller.abort();
    const result = await resultPromise;

    expect(result.status).toBe("cancelled");
    expect(result.cleanupErrors).toEqual([
      "数据库关闭失败：simulated stop cleanup failure",
    ]);
    const [run] = await testSql<{ outcome: string; summary: unknown }[]>`
      SELECT outcome, summary FROM runs
    `;
    expect(run?.outcome).toBe("stopped");
    expect(run?.summary).toBeNull();
  } finally {
    await dropRetryDelayTrigger();
  }
});

async function runCli(env: Record<string, string>, args: string[]) {
  return collectCli(startCli(env, args));
}

function startCli(env: Record<string, string>, args: string[]) {
  return Bun.spawn([process.execPath, "--no-env-file", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function collectCli(child: Bun.ReadableSubprocess) {
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function installRetryDelayTrigger() {
  await testSql.unsafe(`
    CREATE FUNCTION delay_retry_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_sleep(1);
      RETURN NEW;
    END
    $$
  `);
  await testSql.unsafe(`
    CREATE TRIGGER delay_retry_insert BEFORE INSERT ON runs
    FOR EACH ROW WHEN (NEW.command = 'retry') EXECUTE FUNCTION delay_retry_insert()
  `);
}

async function dropRetryDelayTrigger() {
  await testSql.unsafe("DROP TRIGGER IF EXISTS delay_retry_insert ON runs");
  await testSql.unsafe("DROP FUNCTION IF EXISTS delay_retry_insert()");
}

async function installRetryFinishDelayTrigger() {
  await testSql.unsafe(`
    CREATE FUNCTION delay_retry_finish() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_sleep(1);
      RETURN NEW;
    END
    $$
  `);
  await testSql.unsafe(`
    CREATE TRIGGER delay_retry_finish BEFORE UPDATE ON runs
    FOR EACH ROW WHEN (NEW.outcome = 'succeeded') EXECUTE FUNCTION delay_retry_finish()
  `);
}

async function installRetryInsertFailureTrigger() {
  await testSql.unsafe(`
    CREATE FUNCTION fail_retry_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_sleep(1);
      RAISE EXCEPTION 'simulated Run insert failure';
    END
    $$
  `);
  await testSql.unsafe(`
    CREATE TRIGGER fail_retry_insert BEFORE INSERT ON runs
    FOR EACH ROW WHEN (NEW.command = 'retry') EXECUTE FUNCTION fail_retry_insert()
  `);
}

async function dropRetryInsertFailureTrigger() {
  await testSql.unsafe("DROP TRIGGER IF EXISTS fail_retry_insert ON runs");
  await testSql.unsafe("DROP FUNCTION IF EXISTS fail_retry_insert()");
}

async function installRetryFinishFailureTrigger() {
  await testSql.unsafe(`CREATE SEQUENCE retry_finish_attempt_seq START 1`);
  await testSql.unsafe(`
    CREATE FUNCTION fail_retry_finish() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM nextval('retry_finish_attempt_seq');
      IF NEW.outcome = 'succeeded' THEN
        RAISE EXCEPTION 'simulated Run completion write failure';
      END IF;
      RETURN NEW;
    END
    $$
  `);
  await testSql.unsafe(`
    CREATE TRIGGER fail_retry_finish BEFORE UPDATE ON runs
    FOR EACH ROW WHEN (OLD.command = 'retry') EXECUTE FUNCTION fail_retry_finish()
  `);
}

async function dropRetryFinishFailureTrigger() {
  await testSql.unsafe("DROP TRIGGER IF EXISTS fail_retry_finish ON runs");
  await testSql.unsafe("DROP FUNCTION IF EXISTS fail_retry_finish()");
  await testSql.unsafe("DROP SEQUENCE IF EXISTS retry_finish_attempt_seq");
}

async function dropRetryFinishDelayTrigger() {
  await testSql.unsafe("DROP TRIGGER IF EXISTS delay_retry_finish ON runs");
  await testSql.unsafe("DROP FUNCTION IF EXISTS delay_retry_finish()");
}

async function waitForRetryDelay() {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [activity] = await testSql<{ waiting: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND state = 'active' AND wait_event = 'PgSleep'
      ) AS waiting
    `;
    if (activity?.waiting) return true;
    await Bun.sleep(20);
  }
  return false;
}

async function resetSchema() {
  await testSql`DROP TABLE IF EXISTS media_versions, post_work, runs CASCADE`;
  expect(
    (await initializeProjectDatabase(readDatabaseConfig(databaseEnv))).status,
  ).toBe("ok");
}
