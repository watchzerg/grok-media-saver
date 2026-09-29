import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveSaved,
  initializeProjectDatabase,
} from "../../src/application-runtime";
import { readDatabaseConfig, readSaveConfig } from "../../src/config";
import type { PageResponse } from "../../src/grok/adapter";
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
