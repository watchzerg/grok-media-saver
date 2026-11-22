import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveSaved,
  initializeProjectDatabase,
  saveSelectedPost,
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

test("S1 同页等价和跨轮成功失败重现不重做，不追加 No Progress 探测", async () => {
  const { config, fake } = await setup([
    page(ids[0].toUpperCase(), ids[0], ids[1]),
    page(ids[0], ids[1]),
    page(ids[2]),
  ]);
  fake.unavailable.add(ids[1]);
  const result = await archiveSaved(config, { connect: fake.connect });
  expect(result.summary).toMatchObject({
    discovered: 2,
    archived: 1,
    skipped: 0,
    unconfirmed: 1,
    unprocessed: 0,
    newRemovals: 1,
    rounds: 2,
    lastRoundComplete: true,
    lastPage: "nonempty",
    endReason: "no-progress",
    leftovers: { save: 0, archive: 1 },
  });
  expect(
    fake.requests.filter((r) => r.kind === "detail").map((r) => r.postId),
  ).toEqual([ids[0], ids[1]]);
  expect(fake.requests.filter((r) => r.kind === "delete")).toHaveLength(1);
  expect(fake.requests.filter((r) => r.kind === "page")).toHaveLength(2);
  expect(
    await testSql`SELECT * FROM post_work WHERE post_id=${ids[2]}`,
  ).toHaveLength(0);
}, 12000);

async function seedBound(
  config: ReturnType<typeof readSaveConfig>,
  id: string,
  removalState: "removed" | "pending",
) {
  const fake = statefulArchiveBrowser([]);
  expect(
    (
      await saveSelectedPost(
        config,
        id,
        new AbortController().signal,
        undefined,
        (signal) => fake.connect(signal, () => {}),
      )
    ).status,
  ).toBe("ok");
  await testSql`UPDATE post_work SET goal='archive', removal_state=${removalState}, deletion_media_version_id=saved_media_version_id WHERE post_id=${id}`;
  const [version] = await testSql<
    { relative_path: string }[]
  >`SELECT relative_path FROM media_versions WHERE post_id=${id}`;
  if (!version) throw new Error("Missing fixture saved version");
  return join(root, version.relative_path);
}

test("S1 旧移除事实的本地结清不算推进，不追加读页", async () => {
  const { config, fake } = await setup([page(ids[0]), page()]);
  await seedBound(config, ids[0], "removed");
  fake.removed.add(ids[0]);
  const result = await archiveSaved(config, { connect: fake.connect });
  expect(result.summary).toMatchObject({
    archived: 1,
    newRemovals: 0,
    endReason: "no-progress",
    rounds: 1,
    leftovers: { save: 0, archive: 0 },
  });
  expect(
    fake.requests.filter((r) => r.kind !== "close-page").map((r) => r.kind),
  ).toEqual(["page"]);
});
