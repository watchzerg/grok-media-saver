import { expect, test } from "bun:test";
import {
  checkProjectDatabase,
  initializeProjectDatabase,
  readProjectStatus,
} from "../../src/application-runtime";
import { readDatabaseConfig } from "../../src/config";
import { databaseEnv, testSql, useIsolatedPostgres } from "../helpers/postgres";

useIsolatedPostgres();

test("db init creates the current schema once and succeeds on an exact repeat", async () => {
  const first = await runCli(databaseEnv, ["db", "init"]);
  expect(first.exitCode, JSON.stringify(first)).toBe(0);
  expect(first.stdout).toContain("数据库结构已初始化");
  expect(first.stderr).toBe("");

  const tables = await testSql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `;
  expect(tables.map((row) => row.table_name)).toEqual([
    "media_versions",
    "post_work",
    "runs",
  ]);

  const repeat = await runCli(databaseEnv, ["db", "init"]);
  expect(repeat.exitCode).toBe(0);
  expect(repeat.stdout).toContain("数据库结构已初始化");

  await testSql`CREATE INDEX unexpected_runs_idx ON runs(command)`;
  const extraIndex = await runCli(databaseEnv, ["db", "init"]);
  expect(extraIndex.exitCode).toBe(1);
  expect(extraIndex.stderr).toContain("数据库结构与当前版本不一致");
  await testSql`DROP INDEX unexpected_runs_idx`;
});

test("db init rejects an incompatible existing table without adding missing tables", async () => {
  await testSql`DROP TABLE IF EXISTS media_versions, post_work, runs CASCADE`;
  await testSql`CREATE TABLE runs (id integer PRIMARY KEY)`;
  const result = await runCli(databaseEnv, ["db", "init"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("数据库结构与当前版本不一致");
  expect(result.stderr).not.toContain(databaseEnv.GROK_DB_PASSWORD);

  const tables = await testSql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `;
  expect(tables.map((row) => row.table_name)).toEqual(["runs"]);
});

test("db init needs only database settings and reports database credentials safely", async () => {
  await testSql`DROP TABLE IF EXISTS runs CASCADE`;
  const missing = await runCli({ PATH: process.env.PATH ?? "" }, [
    "db",
    "init",
  ]);
  expect(missing.exitCode).toBe(2);
  expect(missing.stderr).toContain("GROK_DB_HOST");
  expect(missing.stderr).not.toContain("PLAYWRIGHT_MCP_EXTENSION_TOKEN");

  const invalid = await runCli({ ...databaseEnv, GROK_DB_PORT: "70000" }, [
    "db",
    "init",
  ]);
  expect(invalid.exitCode).toBe(2);
  expect(invalid.stderr).toContain("GROK_DB_PORT");
  expect(invalid.stderr).not.toContain(databaseEnv.GROK_DB_PASSWORD);

  const badPassword = await runCli(
    { ...databaseEnv, GROK_DB_PASSWORD: "different-secret-value" },
    ["db", "init"],
  );
  expect(badPassword.exitCode).toBe(1);
  expect(badPassword.stderr).not.toContain("different-secret-value");
});

test("db init reports a controlled close timeout through the real CLI process", async () => {
  await testSql`DROP TABLE IF EXISTS media_versions, post_work, runs CASCADE`;
  expect(
    (await initializeProjectDatabase(readDatabaseConfig(databaseEnv))).status,
  ).toBe("ok");

  const result = await runCloseCli();
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toContain("数据库初始化失败");
  expect(result.stderr).toContain("数据库关闭失败：受控关闭超时");
  expect(result.stderr).not.toContain("数据库结构已初始化");
});

test("db init keeps the primary error and reports an additional close error", async () => {
  await testSql`DROP TABLE IF EXISTS media_versions, post_work, runs CASCADE`;
  await testSql`CREATE TABLE runs (id integer PRIMARY KEY)`;

  const result = await runCloseCli();
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("数据库关闭失败：受控关闭超时");
  expect(result.stderr).toContain("数据库结构与当前版本不一致");
  expect(result.stdout).toContain("数据库初始化失败");

  await testSql`DROP TABLE runs`;
});

test("Application checks schema without creating it and initializes no Run", async () => {
  await testSql`DROP TABLE IF EXISTS media_versions, post_work, runs CASCADE`;
  const config = readDatabaseConfig(databaseEnv);
  const missing = await checkProjectDatabase(config);
  expect(missing.status).toBe("failed");
  expect(missing.message).toContain("数据库结构不完整");
  const beforeInit = await testSql<{ count: number }[]>`
    SELECT count(*)::integer AS count FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `;
  expect(beforeInit[0]?.count).toBe(0);

  const initialized = await initializeProjectDatabase(config);
  expect(initialized.status).toBe("ok");
  expect((await checkProjectDatabase(config)).status).toBe("ok");
  const runCount = await testSql<
    { count: number }[]
  >`SELECT count(*)::integer AS count FROM runs`;
  expect(runCount[0]?.count).toBe(0);
  await testSql`DROP TABLE media_versions, post_work, runs CASCADE`;
});

test("schema declares unique Post identity and same Post digest constraints", async () => {
  await testSql`DROP TABLE IF EXISTS media_versions, post_work, runs CASCADE`;
  expect(
    (await initializeProjectDatabase(readDatabaseConfig(databaseEnv))).status,
  ).toBe("ok");
  const constraints = await testSql<
    { relation: string; constraint_name: string; definition: string }[]
  >`
    SELECT r.relname AS relation, c.conname AS constraint_name,
      pg_get_constraintdef(c.oid, true) AS definition
    FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE n.nspname = 'public'
      AND r.relname IN ('post_work', 'media_versions')
    ORDER BY r.relname, c.conname
  `;
  expect(constraints).toContainEqual({
    relation: "post_work",
    constraint_name: "post_work_pkey",
    definition: "PRIMARY KEY (post_id)",
  });
  expect(constraints).toContainEqual({
    relation: "media_versions",
    constraint_name: "media_versions_post_id_sha256_key",
    definition: "UNIQUE (post_id, sha256)",
  });

  const postA = "00000000-0000-4000-8000-000000000001";
  const postB = "00000000-0000-4000-8000-000000000002";
  const versionA = "10000000-0000-4000-8000-000000000001";
  const versionB = "10000000-0000-4000-8000-000000000002";
  await testSql`INSERT INTO post_work (post_id, status) VALUES (${postA}, 'saved'), (${postB}, 'saved')`;
  await testSql`
    INSERT INTO media_versions (id, post_id, sha256, byte_count, mime_type, relative_path, saved_at)
    VALUES (${versionA}, ${postA}, 'a', 1, 'image/png', 'a', now()),
      (${versionB}, ${postB}, 'b', 1, 'image/png', 'b', now())
  `;
  const missingVersionError = await captureError(
    () =>
      testSql`UPDATE post_work SET saved_media_version_id = '20000000-0000-4000-8000-000000000001' WHERE post_id = ${postA}`,
  );
  expect(missingVersionError.message).toContain(
    "post_work_saved_media_version_fkey",
  );
  const otherPostVersionError = await captureError(
    () =>
      testSql`UPDATE post_work SET saved_media_version_id = ${versionB} WHERE post_id = ${postA}`,
  );
  expect(otherPostVersionError.message).toContain(
    "post_work_saved_media_version_fkey",
  );
  await testSql`UPDATE post_work SET saved_media_version_id = ${versionA} WHERE post_id = ${postA}`;
  await testSql`DROP TABLE media_versions, post_work, runs CASCADE`;
});

async function runCli(env: Record<string, string>, args: string[]) {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "src/cli.ts", ...args],
    {
      cwd: process.cwd(),
      env,
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

async function runCloseCli() {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "tests/helpers/db-init-close-cli.ts"],
    {
      cwd: process.cwd(),
      env: databaseEnv,
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

async function captureError(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("Expected an Error instance.");
  }
  throw new Error("Expected the database operation to fail.");
}

test("status reports database facts without changing them or needing other resources", async () => {
  expect(
    (await initializeProjectDatabase(readDatabaseConfig(databaseEnv))).status,
  ).toBe("ok");

  const empty = await runCli(databaseEnv, ["status"]);
  expect(empty.exitCode, JSON.stringify(empty)).toBe(0);
  expect(empty.stdout).toContain("尚无 Run");
  expect(empty.stdout).toContain("没有未完成 Post");
  expect(empty.stderr).toBe("");

  const runId = "00000000-0000-4000-8000-000000000010";
  const finishedRunId = "00000000-0000-4000-8000-000000000011";
  const postIds = [
    "10000000-0000-4000-8000-000000000010",
    "10000000-0000-4000-8000-000000000011",
    "10000000-0000-4000-8000-000000000012",
    "10000000-0000-4000-8000-000000000013",
  ];
  const versionId = "20000000-0000-4000-8000-000000000010";
  await testSql`
    INSERT INTO runs (id, command, target_post_id, started_at, finished_at, outcome, summary)
    VALUES
      (${runId}, 'save-first-page', NULL, '2026-09-26T10:00:00Z', NULL, NULL, NULL),
      (${finishedRunId}, 'retry', NULL, '2026-09-26T09:00:00Z', '2026-09-26T09:01:00Z', 'failed',
        '{"saved": 2, "failed": 1, "unprocessed": 3}'::jsonb)
  `;
  await testSql`
    INSERT INTO post_work (post_id, status, last_run_id, last_error)
    VALUES
      (${postIds[0]}, 'pending', ${runId}, NULL),
      (${postIds[1]}, 'failed', ${finishedRunId}, 'HTTP 404'),
      (${postIds[2]}, 'finalizing', ${runId}, NULL),
      (${postIds[3]}, 'saved', ${finishedRunId}, NULL)
  `;
  await testSql`
    INSERT INTO media_versions (id, post_id, sha256, byte_count, mime_type, relative_path, saved_at)
    VALUES (${versionId}, ${postIds[3]}, ${"a".repeat(64)}, 12, 'image/png',
      'moved-after-save.png', '2026-09-26T08:00:00Z')
  `;
  await testSql`
    UPDATE post_work SET saved_media_version_id = ${versionId}
    WHERE post_id = ${postIds[3]}
  `;

  const before = await readPersistedFacts();
  const result = await runCli(databaseEnv, ["status"]);
  const after = await readPersistedFacts();

  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(result.stdout).toContain("最近 Run");
  expect(result.stdout).toContain("2026-09-26");
  expect(result.stdout).toContain("数量未知");
  expect(result.stdout).toContain("可能仍在运行或已中断");
  expect(result.stdout).toContain("当前未完成 Post");
  expect(result.stdout).toContain(postIds[0]);
  expect(result.stdout).toContain(postIds[1]);
  expect(result.stdout).toContain(postIds[2]);
  expect(result.stdout).not.toContain(postIds[3]);
  expect(result.stdout).not.toContain("HTTP 404");
  expect(result.stdout).not.toContain("崩溃时间");
  expect(result.stderr).toBe("");
  expect(after).toEqual(before);

  const historicalFailure = await runCli(databaseEnv, ["status"]);
  expect(historicalFailure.exitCode).toBe(0);
});

test("status reports saved run summary and fails safely when the database is unavailable", async () => {
  await testSql`UPDATE post_work SET saved_media_version_id = NULL`;
  await testSql`DELETE FROM media_versions`;
  await testSql`DELETE FROM post_work`;
  await testSql`DELETE FROM runs`;
  await testSql`
    INSERT INTO runs (id, command, started_at, finished_at, outcome, summary)
    VALUES ('00000000-0000-4000-8000-000000000012', 'save-post',
      '2026-09-26T12:00:00Z', '2026-09-26T12:05:00Z', 'failed',
      '{"saved": 2, "failed": 1, "unprocessed": 3}'::jsonb)
  `;

  const result = await runCli(databaseEnv, ["status"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("最近 Run");
  expect(result.stdout).toContain("已保存 2");
  expect(result.stdout).toContain("失败 1");
  expect(result.stdout).toContain("未处理 3");

  const unavailable = await runCli(
    { ...databaseEnv, GROK_DB_PASSWORD: "status-secret" },
    ["status"],
  );
  expect(unavailable.exitCode).toBe(1);
  expect(unavailable.stderr).toContain("状态查询失败");
  expect(unavailable.stderr).not.toContain("status-secret");
});

test("status reports a database close failure after reading the status", async () => {
  const result = await readProjectStatus(
    readDatabaseConfig(databaseEnv),
    async (sql) => {
      await sql.close();
      throw new Error("受控关闭超时");
    },
  );

  expect(result.status).toBe("failed");
  expect(result.message).toContain("状态查询已完成");
  expect(result.cleanupErrors).toContain("数据库关闭失败：受控关闭超时");
});

async function readPersistedFacts() {
  const runs = await testSql<unknown[]>`
    SELECT id, command, target_post_id, started_at, finished_at, outcome, summary
    FROM runs ORDER BY id
  `;
  const work = await testSql<unknown[]>`
    SELECT post_id, status, last_run_id, last_error, publish_temp_name,
      publish_relative_path, publish_expected_bytes, publish_sha256
    FROM post_work ORDER BY post_id
  `;
  return { runs, work };
}
