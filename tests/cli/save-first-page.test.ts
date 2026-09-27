import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeProjectDatabase,
  saveFirstPage,
} from "../../src/application-runtime";
import { readDatabaseConfig, readSaveConfig } from "../../src/config";
import { databaseEnv, testSql, useIsolatedPostgres } from "../helpers/postgres";

useIsolatedPostgres();
const ids = [
  "123e4567-e89b-42d3-a456-426614174000",
  "123e4567-e89b-42d3-a456-426614174001",
  "123e4567-e89b-42d3-a456-426614174002",
  "123e4567-e89b-42d3-a456-426614174003",
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

test("S2 save first-page completes an empty page once", async () => {
  await reset();
  const root = await mkdtemp(join(tmpdir(), "gms-page-empty-"));
  const events = join(root, "events");
  try {
    const result = await run({
      ...databaseEnv,
      GROK_ARCHIVE_DIR: root,
      PLAYWRIGHT_MCP_EXTENSION_TOKEN: "fixture",
      GROK_API_INTERVAL_MIN_SECONDS: "0",
      GROK_API_INTERVAL_MAX_SECONDS: "0",
      GMS_TEST_PAGE_IDS: "",
      GMS_TEST_REQUEST_EVENTS: events,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("已保存 0，失败 0，未处理 0");
    expect(
      (await readFile(events, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).kind),
    ).toEqual(["page"]);
    const [saved] = await testSql<
      { command: string; outcome: string; summary: unknown }[]
    >`SELECT command, outcome, summary FROM runs`;
    expect(saved).toEqual({
      command: "save-first-page",
      outcome: "succeeded",
      summary: { saved: 0, failed: 0, unprocessed: 0 },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("S1 Application schedules one page in order and persists only started Posts", async () => {
  await reset();
  const root = await mkdtemp(join(tmpdir(), "gms-page-app-"));
  const env = {
    ...databaseEnv,
    GROK_ARCHIVE_DIR: root,
    PLAYWRIGHT_MCP_EXTENSION_TOKEN: "fixture",
    GROK_API_INTERVAL_MIN_SECONDS: "0",
    GROK_API_INTERVAL_MAX_SECONDS: "0",
  };
  const seen: string[] = [];
  try {
    const result = await saveFirstPage(
      readDatabaseConfig(env),
      undefined,
      undefined,
      () => readSaveConfig(env),
      async () => ({
        getPostDetail: async (id) => {
          seen.push(id);
          return { kind: "unavailable", status: 404 };
        },
        close: async () => {},
      }),
      undefined,
      async () => ({
        getFirstPage: async () => ({
          kind: "page",
          assets: ids
            .slice(0, 2)
            .map((assetId) => ({ assetId, mimeType: "image/png" })),
          hasNextPage: true,
        }),
        close: async () => {},
      }),
    );
    expect(result.status).toBe("failed");
    expect(seen).toEqual(ids.slice(0, 2));
    const works = await testSql<
      { post_id: string }[]
    >`SELECT post_id FROM post_work ORDER BY post_id`;
    expect(works.map((work) => work.post_id)).toEqual(ids.slice(0, 2));
    const [savedRun] = await testSql<
      { summary: unknown }[]
    >`SELECT summary FROM runs WHERE command='save-first-page'`;
    expect(savedRun?.summary).toEqual({ saved: 0, failed: 2, unprocessed: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
      GMS_TEST_UNAVAILABLE_ID: ids[1] ?? "",
      GMS_TEST_BLOCKED_ID: ids[2] ?? "",
      GMS_TEST_MEDIA: "1",
      GMS_TEST_REQUEST_EVENTS: events,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("已保存 1，失败 2，未处理 1");
    const requests = (await readFile(events, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(requests.map((r) => `${r.kind}:${r.postId}`)).toEqual([
      "page:",
      `detail:${ids[0]}`,
      `media:${ids[0]}`,
      `detail:${ids[1]}`,
      `detail:${ids[2]}`,
    ]);
    const [savedRun] = await testSql<
      { summary: unknown }[]
    >`SELECT summary FROM runs WHERE command='save-first-page'`;
    expect(savedRun?.summary).toEqual({ saved: 1, failed: 2, unprocessed: 1 });
    const [laterWork] = await testSql<
      { count: number }[]
    >`SELECT count(*)::integer AS count FROM post_work WHERE post_id=${ids[3]}`;
    expect(laterWork?.count).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("S2 final page failure records an unknown summary and starts no Post", async () => {
  await reset();
  const root = await mkdtemp(join(tmpdir(), "gms-page-failed-"));
  try {
    const result = await run({
      ...databaseEnv,
      GROK_ARCHIVE_DIR: root,
      PLAYWRIGHT_MCP_EXTENSION_TOKEN: "fixture",
      GROK_API_INTERVAL_MIN_SECONDS: "0",
      GROK_API_INTERVAL_MAX_SECONDS: "0",
      GMS_TEST_PAGE_STATUS: "404",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Saved 第一页不可读取");
    expect(result.stderr).not.toContain("已保存 0，失败 0，未处理 0");
    const [savedRun] = await testSql<
      { outcome: string; summary: unknown }[]
    >`SELECT outcome, summary FROM runs WHERE command='save-first-page'`;
    expect(savedRun).toEqual({ outcome: "failed", summary: null });
    const [workCount] = await testSql<
      { count: number }[]
    >`SELECT count(*)::integer AS count FROM post_work`;
    expect(workCount?.count).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("S2 blocked page stops without Post work and reports HTTP 429", async () => {
  await reset();
  const root = await mkdtemp(join(tmpdir(), "gms-page-blocked-"));
  try {
    const result = await run({
      ...databaseEnv,
      GROK_ARCHIVE_DIR: root,
      PLAYWRIGHT_MCP_EXTENSION_TOKEN: "fixture",
      GROK_API_INTERVAL_MIN_SECONDS: "0",
      GROK_API_INTERVAL_MAX_SECONDS: "0",
      GMS_TEST_PAGE_IDS: ids.join(","),
      GMS_TEST_PAGE_BLOCKED: "1",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("HTTP 429");
    const [savedRun] = await testSql<
      { outcome: string; summary: unknown }[]
    >`SELECT outcome, summary FROM runs WHERE command='save-first-page'`;
    expect(savedRun).toEqual({ outcome: "failed", summary: null });
    const [workCount] = await testSql<
      { count: number }[]
    >`SELECT count(*)::integer AS count FROM post_work`;
    expect(workCount?.count).toBe(0);
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
    expect(result.stderr).toContain("未处理 2");
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
    expect(savedRun?.summary).toEqual({ saved: 0, failed: 0, unprocessed: 2 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("S2 page save rereads saved work and shares request interval across page, detail, and media", async () => {
  await reset();
  const root = await mkdtemp(join(tmpdir(), "gms-page-reuse-"));
  const events = join(root, "events");
  const env = {
    ...databaseEnv,
    GROK_ARCHIVE_DIR: root,
    PLAYWRIGHT_MCP_EXTENSION_TOKEN: "fixture",
    GROK_API_INTERVAL_MIN_SECONDS: "0.12",
    GROK_API_INTERVAL_MAX_SECONDS: "0.12",
    GMS_TEST_PAGE_IDS: ids.slice(0, 1).join(","),
    GMS_TEST_MEDIA: "1",
    GMS_TEST_REQUEST_EVENTS: events,
  };
  try {
    expect((await run(env)).exitCode).toBe(0);
    const second = await run(env);
    expect(second.exitCode, second.stderr).toBe(0);
    const requests = (await readFile(events, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(requests.map((r) => r.kind)).toEqual([
      "page",
      "detail",
      "media",
      "page",
      "detail",
    ]);
    for (const segment of [requests.slice(0, 3), requests.slice(3)]) {
      for (let index = 1; index < segment.length; index += 1) {
        expect(
          segment[index].at - segment[index - 1].at,
        ).toBeGreaterThanOrEqual(90);
      }
    }
    const runs = await testSql<
      { summary: unknown }[]
    >`SELECT summary FROM runs WHERE command='save-first-page' ORDER BY started_at`;
    expect(runs.map((item) => item.summary)).toEqual([
      { saved: 1, failed: 0, unprocessed: 0 },
      { saved: 1, failed: 0, unprocessed: 0 },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
