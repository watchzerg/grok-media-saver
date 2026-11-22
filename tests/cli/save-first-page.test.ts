import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeProjectDatabase } from "../../src/application-runtime";
import { readDatabaseConfig } from "../../src/config";
import { databaseEnv, testSql, useIsolatedPostgres } from "../helpers/postgres";

useIsolatedPostgres();
const ids = [
  "123e4567-e89b-42d3-a456-426614174000",
  "123e4567-e89b-42d3-a456-426614174001",
  "123e4567-e89b-42d3-a456-426614174002",
  "123e4567-e89b-42d3-a456-426614174003",
  "123e4567-e89b-42d3-a456-426614174004",
];

async function run(env: Record<string, string>) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--preload",
      "./tests/helpers/fake-save-browser.ts",
      "src/cli.ts",
      "save",
      "first-page",
    ],
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

async function reset() {
  await testSql`DROP TABLE IF EXISTS media_versions, post_work, runs CASCADE`;
  expect(
    (await initializeProjectDatabase(readDatabaseConfig(databaseEnv))).status,
  ).toBe("ok");
}

test("S2 save first-page handles mixed results serially and leaves later members untouched on block", async () => {
  await reset();
  const root = await mkdtemp(join(tmpdir(), "gms-page-mixed-"));
  const events = join(root, "events");
  try {
    const result = await run({
      ...databaseEnv,
      GROK_ARCHIVE_DIR: root,
      PLAYWRIGHT_MCP_EXTENSION_TOKEN: "fixture",
      GROK_API_INTERVAL_MIN_SECONDS: "0",
      GROK_API_INTERVAL_MAX_SECONDS: "0",
      GMS_TEST_PAGE_IDS: ids.join(","),
      GMS_TEST_VIDEO_ID: ids[0] ?? "",
      GMS_TEST_UNAVAILABLE_ID: ids[2] ?? "",
      GMS_TEST_BLOCKED_ID: ids[3] ?? "",
      GMS_TEST_MEDIA: "1",
      GMS_TEST_REQUEST_EVENTS: events,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "保存完成 2，归档完成 0，已结清跳过 0，未确认完成 2，未处理 1",
    );
    const requests = (await readFile(events, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(requests.map((r) => `${r.kind}:${r.postId}`)).toEqual([
      "page:",
      `detail:${ids[0]}`,
      `media:${ids[0]}`,
      `detail:${ids[1]}`,
      `media:${ids[1]}`,
      `detail:${ids[2]}`,
      `detail:${ids[3]}`,
    ]);
    const [savedRun] = await testSql<
      { summary: unknown }[]
    >`SELECT summary FROM runs WHERE command='save-first-page'`;
    expect(savedRun?.summary).toEqual({
      saved: 2,
      archived: 0,
      skipped: 0,
      unconfirmed: 2,
      unprocessed: 1,
    });
    const savedWorks = await testSql<
      { post_id: string; status: string }[]
    >`SELECT post_id, status FROM post_work WHERE status='saved' ORDER BY post_id`;
    expect(savedWorks).toEqual(
      ids.slice(0, 2).map((post_id) => ({ post_id, status: "saved" })),
    );
    const [laterWork] = await testSql<
      { count: number }[]
    >`SELECT count(*)::integer AS count FROM post_work WHERE post_id=${ids[4]}`;
    expect(laterWork?.count).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("S2 stop leaves the next page member without work and reports exit 130", async () => {
  await reset();
  const root = await mkdtemp(join(tmpdir(), "gms-page-stop-"));
  const events = join(root, "events");
  try {
    const result = await run({
      ...databaseEnv,
      GROK_ARCHIVE_DIR: root,
      PLAYWRIGHT_MCP_EXTENSION_TOKEN: "fixture",
      GROK_API_INTERVAL_MIN_SECONDS: "0",
      GROK_API_INTERVAL_MAX_SECONDS: "0",
      GMS_TEST_PAGE_IDS: ids.slice(0, 2).join(","),
      GMS_TEST_ABORT_DETAIL_ID: ids[0] ?? "",
      GMS_TEST_MEDIA: "1",
      GMS_TEST_REQUEST_EVENTS: events,
    });
    expect(result.exitCode, result.stderr).toBe(130);
    expect(result.stderr).toContain("未处理 1");
    const requests = (await readFile(events, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(requests.map((r) => `${r.kind}:${r.postId}`)).toEqual([
      "page:",
      `detail:${ids[0]}`,
    ]);
    const [workCount] = await testSql<
      { count: number }[]
    >`SELECT count(*)::integer AS count FROM post_work WHERE post_id=${ids[1]}`;
    expect(workCount?.count).toBe(0);
    const [savedRun] = await testSql<
      { outcome: string; summary: unknown }[]
    >`SELECT outcome, summary FROM runs WHERE command='save-first-page'`;
    expect(savedRun?.outcome).toBe("stopped");
    expect(savedRun?.summary).toEqual({
      saved: 0,
      archived: 0,
      skipped: 0,
      unconfirmed: 1,
      unprocessed: 1,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
