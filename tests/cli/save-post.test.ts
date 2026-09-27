import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeProjectDatabase,
  verifySavedPost,
} from "../../src/application-runtime";
import {
  readDatabaseConfig,
  readSaveConfig,
  readVerifyConfig,
} from "../../src/config";
import { checkArchiveFile } from "../../src/files/verify";
import { savePost } from "../../src/save-post";
import { databaseEnv, testSql, useIsolatedPostgres } from "../helpers/postgres";

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
    VALUES (${postId}, 'finalizing', 'https://imagine-public.x.ai/source.png',
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
      getPostDetail: async () => ({
        kind: "post" as const,
        selection: {
          assetId: postId,
          key: "https://imagine-public.x.ai/source.png",
          quality: "image" as const,
          mimeType: "image/png",
        },
      }),
      close: async () => {},
    }),
  };
}

test("save post publishes a matching temp without replacing an existing target", async () => {
  const config = await seed();
  await writeFile(join(config.archiveRoot, postId, tempName), bytes);
  expect(
    await checkArchiveFile(
      config.archiveRoot,
      `${postId}/${tempName}`,
      bytes.length,
      digest,
    ),
  ).toEqual({ status: "ok" });
  const result = await savePost(config, postId, matchingDetail());
  expect(result.status, JSON.stringify(result)).toBe("ok");
  expect(
    await Bun.file(join(config.archiveRoot, relativePath)).bytes(),
  ).toEqual(bytes);
  expect(
    (
      await verifySavedPost(
        readVerifyConfig({
          ...databaseEnv,
          GROK_ARCHIVE_DIR: config.archiveRoot,
        }),
        postId,
      )
    ).status,
  ).toBe("ok");
  const [work] = await testSql<
    {
      status: string;
      publish_temp_name: string | null;
      saved_media_version_id: string;
    }[]
  >`
    SELECT status, publish_temp_name, saved_media_version_id::text FROM post_work WHERE post_id = ${postId}
  `;
  expect(work?.status).toBe("saved");
  expect(work?.publish_temp_name).toBeNull();
  expect(work?.saved_media_version_id).toBeTruthy();
  const [count] = await testSql<
    { count: number }[]
  >`SELECT count(*)::integer AS count FROM media_versions`;
  expect(count?.count).toBe(1);
});

test("matching final file settles intent while an unrelated temp name remains untouched", async () => {
  const config = await seed();
  await writeFile(join(config.archiveRoot, relativePath), bytes);
  await symlink("unrelated", join(config.archiveRoot, postId, tempName));
  const result = await savePost(config, postId, matchingDetail());
  expect(result.status).toBe("failed");
  expect(result.message).toContain("已保存");
  expect(
    await Bun.file(join(config.archiveRoot, relativePath)).bytes(),
  ).toEqual(bytes);
  const [work] = await testSql<
    { status: string; publish_temp_name: string | null }[]
  >`
    SELECT status, publish_temp_name FROM post_work WHERE post_id = ${postId}
  `;
  expect(work).toEqual({ status: "saved", publish_temp_name: null });
});

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

test("missing final and temp clear only the checked intent and leave pending download work", async () => {
  const config = await seed();
  const result = await savePost(config, postId, matchingDetail());
  expect(result.status).toBe("failed");
  expect(result.message).toContain("需要下载");
  const [work] = await testSql<
    {
      status: string;
      publish_temp_name: string | null;
      saved_media_version_id: string | null;
    }[]
  >`
    SELECT status, publish_temp_name, saved_media_version_id FROM post_work WHERE post_id = ${postId}
  `;
  expect(work).toEqual({
    status: "pending",
    publish_temp_name: null,
    saved_media_version_id: null,
  });
});

test("mismatching temporary file remains finalizing and is never published", async () => {
  const config = await seed();
  await writeFile(join(config.archiveRoot, postId, tempName), "wrong");
  const result = await savePost(config, postId, matchingDetail());
  expect(result.status).toBe("failed");
  expect(result.message).toContain("临时文件");
  expect(await Bun.file(join(config.archiveRoot, relativePath)).exists()).toBe(
    false,
  );
  const [work] = await testSql<{ status: string; publish_temp_name: string }[]>`
    SELECT status, publish_temp_name FROM post_work WHERE post_id = ${postId}
  `;
  expect(work).toEqual({ status: "finalizing", publish_temp_name: tempName });
});

test("saved recovery reads current detail and preserves recovered version when source changes", async () => {
  const config = await seed();
  await writeFile(join(config.archiveRoot, relativePath), bytes);
  const result = await savePost(config, postId, {
    connect: async () => ({
      getPostDetail: async () => ({
        kind: "post",
        selection: {
          assetId: postId,
          key: "https://imagine-public.x.ai/new-source.png",
          quality: "image",
          mimeType: "image/png",
        },
      }),
      close: async () => {},
    }),
  });
  expect(result.status).toBe("failed");
  expect(result.message).toContain("需要下载");
  const [work] = await testSql<
    { status: string; selected_key: string; saved_media_version_id: string }[]
  >`
    SELECT status, selected_key, saved_media_version_id::text FROM post_work WHERE post_id = ${postId}
  `;
  expect(work?.status).toBe("pending");
  expect(work?.selected_key).toContain("new-source");
  expect(work?.saved_media_version_id).toBeTruthy();
  expect(
    (
      await verifySavedPost(
        readVerifyConfig({
          ...databaseEnv,
          GROK_ARCHIVE_DIR: config.archiveRoot,
        }),
        postId,
      )
    ).status,
  ).toBe("ok");
});

test("current detail failure retains the recovered media version", async () => {
  const config = await seed();
  await writeFile(join(config.archiveRoot, relativePath), bytes);
  const result = await savePost(config, postId, {
    connect: async () => ({
      getPostDetail: async () => ({ kind: "unavailable", status: 404 }),
      close: async () => {},
    }),
  });
  expect(result.status).toBe("failed");
  expect(result.message).toContain("旧发布意图已结清");
  const [work] = await testSql<
    { status: string; saved_media_version_id: string }[]
  >`
    SELECT status, saved_media_version_id::text FROM post_work WHERE post_id = ${postId}
  `;
  expect(work?.status).toBe("failed");
  expect(work?.saved_media_version_id).toBeTruthy();
});

test("current applicable size conflict does not reuse recovered file", async () => {
  const config = await seed();
  await writeFile(join(config.archiveRoot, relativePath), bytes);
  const result = await savePost(config, postId, {
    connect: async () => ({
      getPostDetail: async () => ({
        kind: "post",
        selection: {
          assetId: postId,
          key: "https://imagine-public.x.ai/source.png",
          quality: "image",
          mimeType: "image/png",
          expectedBytes: bytes.length + 1,
        },
      }),
      close: async () => {},
    }),
  });
  expect(result.status).toBe("failed");
  expect(result.message).toContain("重新下载");
  const [work] = await testSql<
    { status: string; saved_media_version_id: string }[]
  >`
    SELECT status, saved_media_version_id::text FROM post_work WHERE post_id = ${postId}
  `;
  expect(work?.status).toBe("pending");
  expect(work?.saved_media_version_id).toBeTruthy();
});

test("stop during publication finishes the file and save transaction before returning cancelled", async () => {
  const config = await seed();
  await writeFile(join(config.archiveRoot, postId, tempName), bytes);
  const controller = new AbortController();
  const result = await savePost(config, postId, {
    ...matchingDetail(),
    signal: controller.signal,
    onStage: (stage) => {
      if (stage === "发布文件") controller.abort();
    },
  });
  expect(result.status).toBe("cancelled");
  const [work] = await testSql<
    { status: string; publish_temp_name: string | null }[]
  >`
    SELECT status, publish_temp_name FROM post_work WHERE post_id = ${postId}
  `;
  expect(work).toEqual({ status: "saved", publish_temp_name: null });
  expect(
    await Bun.file(join(config.archiveRoot, relativePath)).bytes(),
  ).toEqual(bytes);
});

test("stop before publication leaves the intent and temp for the next save", async () => {
  const config = await seed();
  await writeFile(join(config.archiveRoot, postId, tempName), bytes);
  const controller = new AbortController();
  const first = await savePost(config, postId, {
    ...matchingDetail(),
    signal: controller.signal,
    onStage: (stage) => {
      if (stage === "核对发布意图") controller.abort();
    },
  });
  expect(first.status).toBe("cancelled");
  const [work] = await testSql<{ status: string; publish_temp_name: string }[]>`
    SELECT status, publish_temp_name FROM post_work WHERE post_id = ${postId}
  `;
  expect(work).toEqual({ status: "finalizing", publish_temp_name: tempName });
  expect(await Bun.file(join(config.archiveRoot, relativePath)).exists()).toBe(
    false,
  );
  const resumed = await savePost(config, postId, matchingDetail());
  expect(resumed.status).toBe("ok");
});

test("real CLI resumes a matching final and reports a verifiable save", async () => {
  const config = await seed();
  await writeFile(join(config.archiveRoot, relativePath), bytes);
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--preload",
      "./tests/helpers/fake-save-browser.ts",
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
  expect({ exitCode, stdout, stderr }).toMatchObject({
    exitCode: 0,
    stderr: "",
  });
  expect(stdout).toContain("Post 保存完成");
  expect(
    (
      await verifySavedPost(
        readVerifyConfig({
          ...databaseEnv,
          GROK_ARCHIVE_DIR: config.archiveRoot,
        }),
        postId,
      )
    ).status,
  ).toBe("ok");
});

test.each(["正式文件已发布", "提交保存结果", "保存结果已提交"])(
  "stop at %s preserves a resumable or saved fact",
  async (stopAt) => {
    const config = await seed();
    await writeFile(join(config.archiveRoot, postId, tempName), bytes);
    const controller = new AbortController();
    const first = await savePost(config, postId, {
      ...matchingDetail(),
      signal: controller.signal,
      onStage: (stage) => {
        if (stage === stopAt) controller.abort();
      },
    });
    expect(first.status).toBe("cancelled");
    const resumed = await savePost(config, postId, matchingDetail());
    expect(resumed.status, resumed.message).toBe("ok");
    const [count] = await testSql<
      { count: number }[]
    >`SELECT count(*)::integer AS count FROM media_versions`;
    expect(count?.count).toBe(1);
  },
);

test("save transaction failure leaves the published file and intent for the next save", async () => {
  const config = await seed();
  await writeFile(join(config.archiveRoot, postId, tempName), bytes);
  await testSql.unsafe(`
    CREATE FUNCTION fail_save_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status = 'saved' THEN RAISE EXCEPTION 'simulated receipt loss'; END IF;
      RETURN NEW;
    END $$
  `);
  await testSql.unsafe(`
    CREATE TRIGGER fail_save_commit BEFORE UPDATE ON post_work
    FOR EACH ROW EXECUTE FUNCTION fail_save_commit()
  `);
  try {
    const first = await savePost(config, postId, matchingDetail());
    expect(first.status).toBe("failed");
    expect(first.message).toContain("结果未知");
    expect(
      await Bun.file(join(config.archiveRoot, relativePath)).bytes(),
    ).toEqual(bytes);
    const [work] = await testSql<
      { status: string; publish_temp_name: string }[]
    >`
      SELECT status, publish_temp_name FROM post_work WHERE post_id = ${postId}
    `;
    expect(work).toEqual({ status: "finalizing", publish_temp_name: tempName });
  } finally {
    await testSql.unsafe("DROP TRIGGER fail_save_commit ON post_work");
    await testSql.unsafe("DROP FUNCTION fail_save_commit()");
  }
  const resumed = await savePost(config, postId, matchingDetail());
  expect(resumed.status, resumed.message).toBe("ok");
  const [count] = await testSql<
    { count: number }[]
  >`SELECT count(*)::integer AS count FROM media_versions`;
  expect(count?.count).toBe(1);
});

test("temp cleanup failure keeps saved fact and reports failure", async () => {
  const config = await seed();
  await writeFile(join(config.archiveRoot, relativePath), bytes);
  await writeFile(join(config.archiveRoot, postId, tempName), bytes);
  const directory = join(config.archiveRoot, postId);
  await chmod(directory, 0o500);
  try {
    const result = await savePost(config, postId, matchingDetail());
    expect(result.status).toBe("failed");
    expect(result.message).toContain("已保存");
    expect(result.cleanupErrors.join(" ")).toContain("清理失败");
    const [work] = await testSql<
      { status: string }[]
    >`SELECT status FROM post_work WHERE post_id = ${postId}`;
    expect(work?.status).toBe("saved");
  } finally {
    await chmod(directory, 0o700);
  }
});

test("real CLI SIGINT during save transaction leaves a settled version", async () => {
  const config = await seed();
  await writeFile(join(config.archiveRoot, postId, tempName), bytes);
  await testSql.unsafe(`
    CREATE FUNCTION delay_save_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status = 'saved' THEN PERFORM pg_sleep(1); END IF;
      RETURN NEW;
    END $$
  `);
  await testSql.unsafe(`
    CREATE TRIGGER delay_save_commit BEFORE UPDATE ON post_work
    FOR EACH ROW EXECUTE FUNCTION delay_save_commit()
  `);
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--preload",
      "./tests/helpers/fake-save-browser.ts",
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
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    const deadline = Date.now() + 5_000;
    let sleeping = false;
    while (Date.now() < deadline) {
      const [activity] = await testSql<{ sleeping: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND state = 'active' AND wait_event = 'PgSleep'
        ) AS sleeping
      `;
      if (activity?.sleeping) {
        sleeping = true;
        break;
      }
      await Bun.sleep(20);
    }
    expect(sleeping).toBe(true);
    child.kill("SIGINT");
    const [stderr, exitCode] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode, stderr).toBe(130);
    const [work] = await testSql<
      { status: string; publish_temp_name: string | null }[]
    >`
      SELECT status, publish_temp_name FROM post_work WHERE post_id = ${postId}
    `;
    expect(work).toEqual({ status: "saved", publish_temp_name: null });
  } finally {
    child.kill();
    await child.exited;
    await testSql.unsafe("DROP TRIGGER delay_save_commit ON post_work");
    await testSql.unsafe("DROP FUNCTION delay_save_commit()");
  }
});
