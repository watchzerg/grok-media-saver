import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeProjectDatabase } from "../../src/application-runtime";
import { readDatabaseConfig } from "../../src/config";
import { databaseEnv, testSql, useIsolatedPostgres } from "../helpers/postgres";
import { seedSettledArchive } from "../helpers/seed-settled-archive";

useIsolatedPostgres();

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

test("retry fixes its initial set, continues ordinary failure, and saves image and video", async () => {
  await resetSchema();
  const root = await mkdtemp(join(tmpdir(), "gms-retry-mixed-"));
  const ids = [0, 1, 2, 3, 4].map(
    (n) => `123e4567-e89b-42d3-a456-42661417400${n}`,
  );
  const detailLog = join(root, "details.txt");
  try {
    for (const [index, status] of [
      "failed",
      "pending",
      "pending",
      "saved",
    ].entries())
      await testSql`INSERT INTO post_work (post_id, status) VALUES (${ids[index]}, ${status})`;
    await testSql.unsafe(`
      CREATE FUNCTION add_retry_work() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status = 'saved' THEN
          INSERT INTO post_work (post_id, status) VALUES ('${ids[4]}', 'pending') ON CONFLICT DO NOTHING;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER add_retry_work AFTER UPDATE ON post_work
      FOR EACH ROW EXECUTE FUNCTION add_retry_work();
    `);
    const result = await runFakeRetry({
      ...databaseEnv,
      GROK_ARCHIVE_DIR: root,
      GMS_TEST_MEDIA: "1",
      GMS_TEST_DETAIL_IDS: detailLog,
      GMS_TEST_UNAVAILABLE_ID: ids[0],
      GMS_TEST_VIDEO_ID: ids[2],
    });
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.stderr).toContain(
      "保存完成 2，归档完成 0，已结清跳过 0，未确认完成 1，未处理 0",
    );
    expect((await readFile(detailLog, "utf8")).trim().split("\n")).toEqual(
      ids.slice(0, 3),
    );
    const works = await testSql<{ post_id: string; status: string }[]>`
      SELECT post_id, status FROM post_work ORDER BY post_id`;
    expect(works.map(({ status }) => status)).toEqual([
      "failed",
      "saved",
      "saved",
      "saved",
      "pending",
    ]);
    const [run] = await testSql<{ outcome: string; summary: unknown }[]>`
      SELECT outcome, summary FROM runs WHERE command = 'retry'`;
    expect(run).toEqual({
      outcome: "failed",
      summary: {
        saved: 2,
        archived: 0,
        skipped: 0,
        unconfirmed: 1,
        unprocessed: 0,
      },
    });
    const files = await testSql<
      { mime_type: string }[]
    >`SELECT mime_type FROM media_versions ORDER BY post_id`;
    expect(files.map(({ mime_type }) => mime_type)).toEqual([
      "image/png",
      "video/mp4",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function runFakeRetry(env: Record<string, string>) {
  return collectCli(startFakeRetry(env));
}

function startFakeRetry(env: Record<string, string>) {
  return Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--preload",
      "./tests/helpers/fake-save-browser.ts",
      "src/cli.ts",
      "retry",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...env,
        PLAYWRIGHT_MCP_EXTENSION_TOKEN: "fixture-token",
        GROK_API_INTERVAL_MIN_SECONDS: env.GROK_API_INTERVAL_MIN_SECONDS ?? "0",
        GROK_API_INTERVAL_MAX_SECONDS: env.GROK_API_INTERVAL_MAX_SECONDS ?? "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

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

test("P2-08 S2 混合retry固定选择未完成目标并串行保存或归档", async () => {
  await resetSchema();
  const root = await mkdtemp(join(tmpdir(), "gms-retry-goals-"));
  const events = join(root, "events");
  const browserEvents = join(root, "browser-events");
  const ids = Array.from(
    { length: 5 },
    (_, i) => `123e4567-e89b-42d3-a456-42661417400${i}`,
  );
  try {
    await testSql`INSERT INTO post_work (post_id, goal, status)
      VALUES (${ids[0]}, 'archive', 'pending'), (${ids[1]}, 'archive', 'saved'),
      (${ids[2]}, 'archive', 'saved'), (${ids[3]}, 'save', 'pending'), (${ids[4]}, 'save', 'saved')`;
    await seedSettledArchive(testSql, ids[1] as string);
    await testSql`UPDATE post_work SET archive_settled=false, removal_state='none', deletion_media_version_id=NULL WHERE post_id=${ids[1]}`;
    await seedSettledArchive(testSql, ids[2] as string);
    const excluded =
      await testSql`SELECT * FROM post_work WHERE post_id IN (${ids[2]}, ${ids[4]}) ORDER BY post_id`;
    const result = await runFakeRetry({
      ...databaseEnv,
      GROK_ARCHIVE_DIR: root,
      GMS_TEST_MEDIA: "1",
      GMS_TEST_REQUEST_EVENTS: events,
      GMS_TEST_BROWSER_EVENTS: browserEvents,
    });
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    const rows =
      await testSql`SELECT goal, status, archive_settled FROM post_work WHERE post_id IN (${ids[0]},${ids[1]},${ids[3]}) ORDER BY post_id`;
    expect(rows).toEqual([
      { goal: "archive", status: "saved", archive_settled: true },
      { goal: "archive", status: "saved", archive_settled: true },
      { goal: "save", status: "saved", archive_settled: false },
    ]);
    expect(
      await testSql`SELECT * FROM post_work WHERE post_id IN (${ids[2]}, ${ids[4]}) ORDER BY post_id`,
    ).toEqual(excluded);
    expect(
      (await readFile(events, "utf8"))
        .trim()
        .split("\n")
        .map((line) => {
          const request = JSON.parse(line);
          return `${request.kind}:${request.postId}`;
        }),
    ).toEqual([
      `detail:${ids[0]}`,
      `media:${ids[0]}`,
      `delete:${ids[0]}`,
      `detail:${ids[1]}`,
      `media:${ids[1]}`,
      `delete:${ids[1]}`,
      `detail:${ids[3]}`,
      `media:${ids[3]}`,
    ]);
    expect((await readFile(browserEvents, "utf8")).trim().split("\n")).toEqual([
      "connect",
      "close-page",
      "close-page",
      "close-page",
      "close",
    ]);
    const [run] = await testSql`SELECT outcome, summary FROM runs`;
    expect(run).toEqual({
      outcome: "succeeded",
      summary: {
        saved: 1,
        archived: 2,
        skipped: 0,
        unconfirmed: 0,
        unprocessed: 0,
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
