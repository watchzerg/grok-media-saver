import { expect, test } from "bun:test";
import {
  checkProjectDatabase,
  initializeProjectDatabase,
} from "../../src/application-runtime";
import { readDatabaseConfig } from "../../src/config";
import { databaseEnv, testSql } from "../helpers/postgres";

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
