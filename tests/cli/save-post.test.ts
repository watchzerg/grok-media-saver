import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeProjectDatabase,
  saveSelectedPost,
} from "../../src/application-runtime";
import { readDatabaseConfig, readSaveConfig } from "../../src/config";
import { parsePostDetailResponse } from "../../src/grok/adapter";
import { databaseEnv, testSql, useIsolatedPostgres } from "../helpers/postgres";
import { seedSettledArchive } from "../helpers/seed-settled-archive";

useIsolatedPostgres();

const postId = "123e4567-e89b-42d3-a456-426614174000";
const bytes = Buffer.from("verified recovery media");
const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const relativePath = `${postId}/${digest}.png`;
const tempName = ".recover123.part";
let archiveRoot: string | undefined;

afterEach(async () => {
  if (archiveRoot) await rm(archiveRoot, { recursive: true, force: true });
  archiveRoot = undefined;
});

async function seed() {
  await testSql`DROP TABLE IF EXISTS media_versions, post_work, runs CASCADE`;
  expect(
    (await initializeProjectDatabase(readDatabaseConfig(databaseEnv))).status,
  ).toBe("ok");
  archiveRoot = await mkdtemp(join(tmpdir(), "gms-save-post-"));
  await mkdir(join(archiveRoot, postId));
  await testSql`
    INSERT INTO post_work
      (post_id, status, selected_key, quality, mime_type,
       publish_temp_name, publish_relative_path, publish_expected_bytes, publish_sha256)
    VALUES (${postId}, 'finalizing', 'https://assets.grok.com/source.png',
      'image', 'image/png', ${tempName}, ${relativePath}, ${bytes.length}, ${digest})
  `;
  return readSaveConfig({
    ...databaseEnv,
    GROK_ARCHIVE_DIR: archiveRoot,
    PLAYWRIGHT_MCP_EXTENSION_TOKEN: "fixture-token",
  });
}

function matchingDetail() {
  return {
    connect: async () => ({
      getPostDetail: async () =>
        parsePostDetailResponse(postId, {
          status: 200,
          contentType: "application/json",
          finalPath: "/rest/app-chat/conversations/fixture",
          body: {
            assetId: postId,
            key: "https://assets.grok.com/source.png",
            mimeType: "image/png",
          },
        }),
      close: async () => {},
    }),
  };
}

async function saveViaApplication(
  config: ReturnType<typeof readSaveConfig>,
  id: string,
  options: {
    connect: (signal: AbortSignal) => Promise<{
      getPostDetail: (
        id: string,
        signal: AbortSignal,
      ) => Promise<import("../../src/grok/adapter").PostResponse>;
      close: () => Promise<void>;
    }>;
    signal?: AbortSignal;
    onStage?: (stage: string) => void;
  },
) {
  return saveSelectedPost(
    config,
    id,
    options.signal ?? new AbortController().signal,
    options.onStage,
    options.connect,
  );
}

test("conflicting final file keeps intent and exits nonzero from real CLI", async () => {
  const config = await seed();
  await writeFile(join(config.archiveRoot, relativePath), "different");
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "src/cli.ts", "save", "post", postId],
    {
      cwd: process.cwd(),
      env: {
        ...databaseEnv,
        GROK_ARCHIVE_DIR: config.archiveRoot,
        PLAYWRIGHT_MCP_EXTENSION_TOKEN: "fixture-token",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stderr, exitCode] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode).toBe(1);
  expect(stderr).toContain("冲突");
  const [work] = await testSql<{ status: string; publish_temp_name: string }[]>`
    SELECT status, publish_temp_name FROM post_work WHERE post_id = ${postId}
  `;
  expect(work).toEqual({ status: "finalizing", publish_temp_name: tempName });
});

test("real CLI process killed after the final file is published resumes from persisted file and DB facts", async () => {
  const config = await seed();
  await writeFile(join(config.archiveRoot, postId, tempName), bytes);
  const marker = join(config.archiveRoot, "stage-marker");
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--preload",
      "./tests/helpers/fake-save-browser.ts",
      "--preload",
      "./tests/helpers/pause-save-stage.ts",
      "src/cli.ts",
      "save",
      "post",
      postId,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...databaseEnv,
        GROK_ARCHIVE_DIR: config.archiveRoot,
        PLAYWRIGHT_MCP_EXTENSION_TOKEN: "fixture-token",
        GMS_TEST_STOP_STAGE: "正式文件已发布",
        GMS_TEST_STAGE_MARKER: marker,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    const deadline = Date.now() + 5_000;
    while (!(await Bun.file(marker).exists()) && Date.now() < deadline)
      await Bun.sleep(20);
    expect(await Bun.file(marker).exists()).toBe(true);
    child.kill("SIGKILL");
    await child.exited;
    const [first] = await testSql<{ status: string }[]>`
        SELECT status FROM post_work WHERE post_id = ${postId}
      `;
    expect(first?.status).toBe("finalizing");
    expect(
      await Bun.file(join(config.archiveRoot, relativePath)).exists(),
    ).toBe(true);
    const resumed = await saveViaApplication(config, postId, matchingDetail());
    expect(resumed.status, resumed.message).toBe("ok");
    const [count] = await testSql<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM media_versions
      `;
    expect(count?.count).toBe(1);
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
});

test("P2-01 S1 已结清 archive 即使文件缺失也直接跳过", async () => {
  const config = await seed();
  await seedSettledArchive(testSql, postId);
  await rm(config.archiveRoot, { recursive: true });
  const [before] =
    await testSql`SELECT * FROM post_work WHERE post_id = ${postId}`;
  let requests = 0;
  const stages: string[] = [];
  const result = await saveViaApplication(config, postId, {
    connect: async () => {
      requests += 1;
      throw new Error("不得连接浏览器");
    },
    onStage: (stage) => stages.push(stage),
  });
  expect(result.status).toBe("ok");
  expect(result.message).toContain("已归档结清");
  expect(result.message).toContain("跳过");
  expect(requests).toBe(0);
  expect(stages).not.toContain("核对发布意图");
  expect(stages).not.toContain("核验已保存文件");
  const [after] =
    await testSql`SELECT * FROM post_work WHERE post_id = ${postId}`;
  expect(after).toEqual(before);
});
