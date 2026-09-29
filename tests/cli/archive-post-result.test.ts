import { afterEach, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databaseEnv, testSql, useIsolatedPostgres } from "../helpers/postgres";

const archiveWork = (await import(
  "../../src/store/archive-work.ts?receipt-source" as string
)) as typeof import("../../src/store/archive-work");
mock.module("../../src/store/archive-work.ts", () => ({
  ...archiveWork,
  confirmRemoval: async (
    ...args: Parameters<typeof archiveWork.confirmRemoval>
  ) => {
    await archiveWork.confirmRemoval(...args);
    if (loseConfirmReceipt) throw new Error("测试：移除确认提交回执丢失");
  },
}));

const { archiveSelectedPost, initializeProjectDatabase } = await import(
  "../../src/application-runtime"
);
const { readDatabaseConfig, readSaveConfig } = await import("../../src/config");
const postId = "123e4567-e89b-42d3-a456-426614174000";
const password = "fixture-token";
let archiveRoot: string | undefined;
let loseConfirmReceipt = false;

useIsolatedPostgres();
afterEach(async () => {
  loseConfirmReceipt = false;
  if (archiveRoot) await rm(archiveRoot, { recursive: true, force: true });
  archiveRoot = undefined;
});

function config() {
  return readSaveConfig({
    ...databaseEnv,
    GROK_ARCHIVE_DIR: archiveRoot,
    PLAYWRIGHT_MCP_EXTENSION_TOKEN: password,
    GROK_API_INTERVAL_MIN_SECONDS: "0",
    GROK_API_INTERVAL_MAX_SECONDS: "0",
  });
}

async function seedPendingArchive() {
  await testSql`DROP TABLE IF EXISTS media_versions, post_work, runs CASCADE`;
  expect(
    (await initializeProjectDatabase(readDatabaseConfig(databaseEnv))).status,
  ).toBe("ok");
  archiveRoot = await mkdtemp(join(tmpdir(), "gms-archive-result-"));
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--preload",
      "./tests/helpers/fake-save-browser.ts",
      "src/cli.ts",
      "archive",
      "post",
      postId,
    ],
    {
      env: {
        ...databaseEnv,
        GROK_ARCHIVE_DIR: archiveRoot,
        PLAYWRIGHT_MCP_EXTENSION_TOKEN: password,
        GROK_API_INTERVAL_MIN_SECONDS: "0",
        GROK_API_INTERVAL_MAX_SECONDS: "0",
        GMS_TEST_MEDIA: "1",
        GMS_TEST_DELETE_STATUS: "503",
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
  expect(exitCode, `${stdout}\n${stderr}`).toBe(1);
  const [row] = await testSql`
    SELECT removal_state, archive_settled FROM post_work WHERE post_id = ${postId}
  `;
  expect(row).toEqual({ removal_state: "pending", archive_settled: false });
}

function removedCheck() {
  const requests: string[] = [];
  return {
    requests,
    connect: async () => ({
      getPostDetail: async () => {
        throw new Error("不应读取详情");
      },
      checkPost: async (id: string) => {
        requests.push(`check:${id}`);
        return {
          status: 404,
          contentType: "application/json",
          body: { code: 5, message: "Asset not found" },
          finalUrl: `https://grok.com/rest/assets/${id}`,
          method: "GET" as const,
          redirected: false,
        };
      },
      close: async () => {},
    }),
  };
}

test("P3-01 S1 Application 保留真实提交但失回执的新确认并按DB恢复", async () => {
  await seedPendingArchive();
  loseConfirmReceipt = true;
  const fake = removedCheck();
  const result = await archiveSelectedPost(
    config(),
    postId,
    new AbortController().signal,
    undefined,
    fake.connect,
  );
  expect(result).toMatchObject({
    status: "failed",
    remoteObservation: "removed",
    newRemovalConfirmed: true,
    archiveRecorded: null,
    fatalExecution: true,
  });
  expect(fake.requests).toEqual([`check:${postId}`]);
  expect(
    await testSql`
    SELECT removal_state, archive_settled FROM post_work WHERE post_id = ${postId}
  `,
  ).toEqual([{ removal_state: "removed", archive_settled: false }]);

  loseConfirmReceipt = false;
  const recovery = await archiveSelectedPost(
    config(),
    postId,
    new AbortController().signal,
    undefined,
    async () => {
      throw new Error("持久 removed 后恢复不得再核对远端");
    },
  );
  expect(recovery).toMatchObject({
    status: "ok",
    remoteObservation: "removed",
    newRemovalConfirmed: false,
    archiveRecorded: true,
  });
});

test("P3-01 S1 Application 保留真实事务拒绝前已取得的新确认", async () => {
  await seedPendingArchive();
  await testSql.unsafe(`CREATE FUNCTION reject_new_removal() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.removal_state = 'removed' THEN
        RAISE EXCEPTION '测试：拒绝移除确认事务';
      END IF;
      RETURN NEW;
    END $$`);
  await testSql`CREATE TRIGGER reject_new_removal BEFORE UPDATE ON post_work
    FOR EACH ROW EXECUTE FUNCTION reject_new_removal()`;
  const fake = removedCheck();
  try {
    const result = await archiveSelectedPost(
      config(),
      postId,
      new AbortController().signal,
      undefined,
      fake.connect,
    );
    expect(result).toMatchObject({
      status: "failed",
      remoteObservation: "removed",
      newRemovalConfirmed: true,
      archiveRecorded: null,
      fatalExecution: true,
    });
    expect(fake.requests).toEqual([`check:${postId}`]);
    expect(
      await testSql`
      SELECT removal_state, archive_settled FROM post_work WHERE post_id = ${postId}
    `,
    ).toEqual([{ removal_state: "pending", archive_settled: false }]);
  } finally {
    await testSql`DROP TRIGGER reject_new_removal ON post_work`;
    await testSql`DROP FUNCTION reject_new_removal()`;
  }

  const retry = await archiveSelectedPost(
    config(),
    postId,
    new AbortController().signal,
    undefined,
    fake.connect,
  );
  expect(retry).toMatchObject({
    status: "ok",
    remoteObservation: "removed",
    newRemovalConfirmed: true,
    archiveRecorded: true,
  });
  expect(fake.requests).toEqual([`check:${postId}`, `check:${postId}`]);
  expect(
    await testSql`
    SELECT removal_state, archive_settled FROM post_work WHERE post_id = ${postId}
  `,
  ).toEqual([{ removal_state: "removed", archive_settled: true }]);
});
