import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeProjectDatabase,
  saveSelectedPost,
  verifySavedPost,
} from "../../src/application-runtime";
import {
  readDatabaseConfig,
  readSaveConfig,
  readVerifyConfig,
} from "../../src/config";
import { checkArchiveFile } from "../../src/files/verify";
import {
  parsePostDetailResponse,
  RetryableRequestError,
} from "../../src/grok/adapter";
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
  const result = await saveViaApplication(config, postId, matchingDetail());
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
  const result = await saveViaApplication(config, postId, matchingDetail());
  expect(result.status).toBe("failed");
  expect(result.message).toContain("已保存");
  expect(result.saveRecorded).toBe(true);
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
  const result = await saveViaApplication(config, postId, matchingDetail());
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
  const result = await saveViaApplication(config, postId, matchingDetail());
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
  const result = await saveViaApplication(config, postId, {
    connect: async () => ({
      getPostDetail: async () => ({
        kind: "post",
        selection: {
          assetId: postId,
          key: "https://assets.grok.com/new-source.png",
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
  const result = await saveViaApplication(config, postId, {
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

test.each(["408", "503", "network"])(
  "save post retries a %s detail failure once before reusing the recovered file",
  async (failure) => {
    const config = await seed();
    await writeFile(join(config.archiveRoot, relativePath), bytes);
    let attempts = 0;
    const result = await saveViaApplication(config, postId, {
      connect: async () => ({
        getPostDetail: async () => {
          attempts += 1;
          if (attempts === 1) {
            if (failure === "network")
              throw new RetryableRequestError("fixture network failure");
            return { kind: "temporary", status: Number(failure) };
          }
          return (await matchingDetail().connect()).getPostDetail();
        },
        close: async () => {},
      }),
    });
    expect(attempts).toBe(2);
    expect(result.status).toBe("ok");
    expect(result.saveRecorded).toBe(true);
  },
);

test("save post stops after the second temporary detail failure", async () => {
  const config = await seed();
  await writeFile(join(config.archiveRoot, relativePath), bytes);
  let attempts = 0;
  const result = await saveViaApplication(config, postId, {
    connect: async () => ({
      getPostDetail: async () => {
        attempts += 1;
        return { kind: "temporary", status: 503 };
      },
      close: async () => {},
    }),
  });
  expect(attempts).toBe(2);
  expect(result.status).toBe("failed");
  expect(result.saveRecorded).toBe(true);
});

test("stop during detail response does not record a successful Run", async () => {
  const config = await seed();
  await writeFile(join(config.archiveRoot, relativePath), bytes);
  const controller = new AbortController();
  const result = await saveViaApplication(config, postId, {
    signal: controller.signal,
    connect: async () => ({
      getPostDetail: async () => {
        controller.abort();
        return (await matchingDetail().connect()).getPostDetail();
      },
      close: async () => {},
    }),
  });
  expect(result.status).toBe("cancelled");
  const [run] = await testSql<{ outcome: string }[]>`
    SELECT outcome FROM runs ORDER BY started_at DESC LIMIT 1
  `;
  expect(run?.outcome).toBe("stopped");
});

test("stop after checking a saved file does not report successful reuse", async () => {
  const config = await seed();
  await writeFile(join(config.archiveRoot, relativePath), bytes);
  expect(
    (await saveViaApplication(config, postId, matchingDetail())).status,
  ).toBe("ok");
  const controller = new AbortController();
  const stages: string[] = [];
  const result = await saveViaApplication(config, postId, {
    ...matchingDetail(),
    signal: controller.signal,
    onStage: (stage) => {
      stages.push(stage);
      if (stage === "已核验保存文件") controller.abort();
    },
  });
  expect(stages).toContain("已核验保存文件");
  expect(result.status).toBe("cancelled");
  expect(result.saveRecorded).toBe(true);
  const [run] = await testSql<{ outcome: string }[]>`
    SELECT outcome FROM runs ORDER BY started_at DESC LIMIT 1
  `;
  expect(run?.outcome).toBe("stopped");
  const [work] = await testSql<{ status: string }[]>`
    SELECT status FROM post_work WHERE post_id = ${postId}
  `;
  expect(work?.status).toBe("saved");
});

test("current applicable size conflict does not reuse recovered file", async () => {
  const config = await seed();
  await writeFile(join(config.archiveRoot, relativePath), bytes);
  const result = await saveViaApplication(config, postId, {
    connect: async () => ({
      getPostDetail: async () => ({
        kind: "post",
        selection: {
          assetId: postId,
          key: "https://assets.grok.com/source.png",
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
  const result = await saveViaApplication(config, postId, {
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
  const first = await saveViaApplication(config, postId, {
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
  const resumed = await saveViaApplication(config, postId, matchingDetail());
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

test("real CLI retries temporary detail after the shared request interval", async () => {
  const config = await seed();
  await writeFile(join(config.archiveRoot, relativePath), bytes);
  const timesPath = join(config.archiveRoot, "request-times");
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
        GROK_API_INTERVAL_MIN_SECONDS: "0.08",
        GROK_API_INTERVAL_MAX_SECONDS: "0.08",
        GMS_TEST_RETRY_DETAIL: "1",
        GMS_TEST_REQUEST_TIMES: timesPath,
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
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(stdout).toContain("Post 保存完成");
  const times = (await readFile(timesPath, "utf8"))
    .trim()
    .split("\n")
    .map(Number);
  expect(times).toHaveLength(2);
  expect((times[1] ?? 0) - (times[0] ?? 0)).toBeGreaterThanOrEqual(70);
});

test("real CLI stops if SIGINT arrives while detail is returning", async () => {
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
        GMS_TEST_ABORT_DETAIL: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stderr, exitCode] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode, stderr).toBe(130);
  const [run] = await testSql<{ outcome: string }[]>`
    SELECT outcome FROM runs ORDER BY started_at DESC LIMIT 1
  `;
  expect(run?.outcome).toBe("stopped");
});

test("real CLI SIGINT while checking a saved file exits stopped", async () => {
  const config = await seed();
  await writeFile(join(config.archiveRoot, relativePath), bytes);
  expect(
    (await saveViaApplication(config, postId, matchingDetail())).status,
  ).toBe("ok");
  const largeBytes = Buffer.alloc(64 * 1024 * 1024, 7);
  const largeDigest = new Bun.CryptoHasher("sha256")
    .update(largeBytes)
    .digest("hex");
  const largeRelativePath = `${postId}/${largeDigest}.png`;
  await writeFile(join(config.archiveRoot, largeRelativePath), largeBytes);
  await testSql`
    UPDATE media_versions
    SET sha256 = ${largeDigest}, byte_count = ${largeBytes.length},
        relative_path = ${largeRelativePath}
    WHERE post_id = ${postId}
  `;
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
  let sawCheckStage = false;
  const output = (async () => {
    let stdout = "";
    for await (const chunk of child.stdout) {
      stdout += Buffer.from(chunk).toString();
      if (!sawCheckStage && stdout.includes("阶段：核验已保存文件。")) {
        sawCheckStage = true;
        child.kill("SIGINT");
      }
    }
    return stdout;
  })();
  const [stdout, stderr, exitCode] = await Promise.all([
    output,
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(sawCheckStage, stdout).toBe(true);
  expect(exitCode, stderr).toBe(130);
  const [run] = await testSql<{ outcome: string }[]>`
    SELECT outcome FROM runs ORDER BY started_at DESC LIMIT 1
  `;
  expect(run?.outcome).toBe("stopped");
  const [work] = await testSql<{ status: string }[]>`
    SELECT status FROM post_work WHERE post_id = ${postId}
  `;
  expect(work?.status).toBe("saved");
});

test.each([
  ["核对收尾执行器锁", "stopped"],
  ["收尾 Run", "stopped"],
  ["Run 已收尾", "succeeded"],
] as const)(
  "stop at %s reports cancellation while preserving the committed Run fact",
  async (stopAt, outcome) => {
    const config = await seed();
    await writeFile(join(config.archiveRoot, relativePath), bytes);
    const controller = new AbortController();
    const result = await saveViaApplication(config, postId, {
      ...matchingDetail(),
      signal: controller.signal,
      onStage: (stage) => {
        if (stage === stopAt) {
          if (stage === "核对收尾执行器锁")
            queueMicrotask(() => controller.abort());
          else controller.abort();
        }
      },
    });
    expect(result.status).toBe("cancelled");
    expect(result.saveRecorded).toBe(true);
    const [run] = await testSql<{ outcome: string }[]>`
      SELECT outcome FROM runs ORDER BY started_at DESC LIMIT 1
    `;
    expect(run?.outcome).toBe(outcome);
    const [work] = await testSql<{ status: string }[]>`
      SELECT status FROM post_work WHERE post_id = ${postId}
    `;
    expect(work?.status).toBe("saved");
  },
);

test.each([
  ["blocked", "HTTP 429", "saved", "核对收尾执行器锁", "stopped"],
  ["blocked", "HTTP 429", "saved", "Run 已收尾", "failed"],
  ["failed", "需要下载", "pending", "核对收尾执行器锁", "stopped"],
  ["failed", "需要下载", "pending", "Run 已收尾", "failed"],
] as const)(
  "stop after %s result (%s, %s) at %s preserves facts",
  async (businessStatus, reason, workStatus, stopAt, outcome) => {
    const config = await seed();
    await writeFile(join(config.archiveRoot, relativePath), bytes);
    const controller = new AbortController();
    const result = await saveViaApplication(config, postId, {
      connect:
        businessStatus === "blocked"
          ? async () => ({
              getPostDetail: async () => ({
                kind: "blocked" as const,
                status: 429,
                retryAfter: "60",
              }),
              close: async () => {},
            })
          : async () => ({
              getPostDetail: async () =>
                parsePostDetailResponse(postId, {
                  status: 200,
                  contentType: "application/json",
                  finalPath: "/rest/app-chat/conversations/fixture",
                  body: {
                    assetId: postId,
                    key: "https://assets.grok.com/changed.png",
                    mimeType: "image/png",
                  },
                }),
              close: async () => {},
            }),
      signal: controller.signal,
      onStage: (stage) => {
        if (stage === stopAt) controller.abort();
      },
    });
    expect(result.status).toBe("cancelled");
    expect(result.message).toContain(reason);
    expect(result.saveRecorded).toBe(true);
    const [run] = await testSql<{ outcome: string }[]>`
      SELECT outcome FROM runs ORDER BY started_at DESC LIMIT 1
    `;
    expect(run?.outcome).toBe(outcome);
    const [work] = await testSql<{ status: string }[]>`
      SELECT status FROM post_work WHERE post_id = ${postId}
    `;
    expect(work?.status).toBe(workStatus);
  },
);

test("real CLI SIGINT during Run finish exits 130 without rewriting its success", async () => {
  const config = await seed();
  await writeFile(join(config.archiveRoot, relativePath), bytes);
  await testSql.unsafe(`
    CREATE FUNCTION delay_run_finish() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.finished_at IS NOT NULL THEN PERFORM pg_sleep(1); END IF;
      RETURN NEW;
    END $$
  `);
  await testSql.unsafe(`
    CREATE TRIGGER delay_run_finish BEFORE UPDATE ON runs
    FOR EACH ROW EXECUTE FUNCTION delay_run_finish()
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
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode, `${stdout}\n${stderr}`).toBe(130);
    const [run] = await testSql<{ outcome: string }[]>`
      SELECT outcome FROM runs ORDER BY started_at DESC LIMIT 1
    `;
    expect(run?.outcome).toBe("succeeded");
    expect(stdout + stderr).toContain("停止");
  } finally {
    child.kill();
    await child.exited;
    await testSql.unsafe("DROP TRIGGER delay_run_finish ON runs");
    await testSql.unsafe("DROP FUNCTION delay_run_finish()");
  }
});

test.each([
  ["blocked", "HTTP 429", "saved"],
  ["failed", "需要下载", "pending"],
] as const)(
  "real CLI SIGINT during %s Run finish exits 130 and preserves the reason",
  async (businessStatus, reason, workStatus) => {
    const config = await seed();
    if (businessStatus === "blocked")
      await writeFile(join(config.archiveRoot, relativePath), bytes);
    await testSql.unsafe(`
      CREATE FUNCTION delay_run_finish() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.finished_at IS NOT NULL THEN PERFORM pg_sleep(1); END IF;
        RETURN NEW;
      END $$
    `);
    await testSql.unsafe(`
      CREATE TRIGGER delay_run_finish BEFORE UPDATE ON runs
      FOR EACH ROW EXECUTE FUNCTION delay_run_finish()
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
          GMS_TEST_BLOCKED: businessStatus === "blocked" ? "1" : "0",
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
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode, `${stdout}\n${stderr}`).toBe(130);
      expect(stderr).toContain("停止");
      expect(stderr).toContain(reason);
      const [run] = await testSql<{ outcome: string }[]>`
        SELECT outcome FROM runs ORDER BY started_at DESC LIMIT 1
      `;
      expect(run?.outcome).toBe("failed");
      const [work] = await testSql<{ status: string }[]>`
        SELECT status FROM post_work WHERE post_id = ${postId}
      `;
      expect(work?.status).toBe(workStatus);
    } finally {
      child.kill();
      await child.exited;
      await testSql.unsafe("DROP TRIGGER delay_run_finish ON runs");
      await testSql.unsafe("DROP FUNCTION delay_run_finish()");
    }
  },
);

test.each(["正式文件已发布", "提交保存结果", "保存结果已提交"])(
  "stop at %s preserves a resumable or saved fact",
  async (stopAt) => {
    const config = await seed();
    await writeFile(join(config.archiveRoot, postId, tempName), bytes);
    const controller = new AbortController();
    const first = await saveViaApplication(config, postId, {
      ...matchingDetail(),
      signal: controller.signal,
      onStage: (stage) => {
        if (stage === stopAt) controller.abort();
      },
    });
    expect(first.status).toBe("cancelled");
    const resumed = await saveViaApplication(config, postId, matchingDetail());
    expect(resumed.status, resumed.message).toBe("ok");
    const [count] = await testSql<
      { count: number }[]
    >`SELECT count(*)::integer AS count FROM media_versions`;
    expect(count?.count).toBe(1);
  },
);

test("known save transaction rollback leaves the published file and intent for the next save", async () => {
  const config = await seed();
  await writeFile(join(config.archiveRoot, postId, tempName), bytes);
  await testSql.unsafe(`
    CREATE FUNCTION reject_save_update() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status = 'saved' THEN RAISE EXCEPTION 'simulated transaction rollback'; END IF;
      RETURN NEW;
    END $$
  `);
  await testSql.unsafe(`
    CREATE TRIGGER reject_save_update BEFORE UPDATE ON post_work
    FOR EACH ROW EXECUTE FUNCTION reject_save_update()
  `);
  try {
    const first = await saveViaApplication(config, postId, matchingDetail());
    expect(first.status).toBe("failed");
    expect(first.message).not.toContain("结果未知");
    expect(
      await Bun.file(join(config.archiveRoot, relativePath)).bytes(),
    ).toEqual(bytes);
    const [work] = await testSql<
      { status: string; publish_temp_name: string }[]
    >`
      SELECT status, publish_temp_name FROM post_work WHERE post_id = ${postId}
    `;
    expect(work).toEqual({ status: "finalizing", publish_temp_name: tempName });
    const [run] = await testSql<{ outcome: string; finished: boolean }[]>`
      SELECT outcome, finished_at IS NOT NULL AS finished FROM runs ORDER BY started_at DESC LIMIT 1
    `;
    expect(run).toEqual({ outcome: "failed", finished: true });
  } finally {
    await testSql.unsafe("DROP TRIGGER reject_save_update ON post_work");
    await testSql.unsafe("DROP FUNCTION reject_save_update()");
  }
  const resumed = await saveViaApplication(config, postId, matchingDetail());
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
    const result = await saveViaApplication(config, postId, matchingDetail());
    expect(result.status).toBe("failed");
    expect(result.message).toContain("已保存");
    expect(result.saveRecorded).toBe(true);
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

test("blocked current detail preserves global reason and recovered version", async () => {
  const config = await seed();
  await writeFile(join(config.archiveRoot, relativePath), bytes);
  const result = await saveViaApplication(config, postId, {
    connect: async () => ({
      getPostDetail: async () => ({
        kind: "blocked",
        status: 429,
        retryAfter: "60",
      }),
      close: async () => {},
    }),
  });
  expect(result.status).toBe("blocked");
  expect(result.message).toContain("HTTP 429");
  expect(result.message).toContain("60");
  const [work] = await testSql<
    { status: string; saved_media_version_id: string }[]
  >`
    SELECT status, saved_media_version_id::text FROM post_work WHERE post_id = ${postId}
  `;
  expect(work?.status).toBe("saved");
  expect(work?.saved_media_version_id).toBeTruthy();
});

test("known media version conflict is reported as conflict and finishes Run", async () => {
  const config = await seed();
  await writeFile(join(config.archiveRoot, relativePath), bytes);
  await testSql`
    INSERT INTO media_versions (id, post_id, sha256, byte_count, mime_type, relative_path, saved_at)
    VALUES (${crypto.randomUUID()}::uuid, ${postId}, ${digest}, ${bytes.length + 1}, 'image/png', ${relativePath}, now())
  `;
  const result = await saveViaApplication(config, postId, matchingDetail());
  expect(result.status).toBe("failed");
  expect(result.message).toContain("冲突");
  expect(result.message).not.toContain("提交结果未知");
  const [run] = await testSql<{ outcome: string; finished: boolean }[]>`
    SELECT outcome, finished_at IS NOT NULL AS finished FROM runs ORDER BY started_at DESC LIMIT 1
  `;
  expect(run).toEqual({ outcome: "failed", finished: true });
  const [work] = await testSql<{ status: string }[]>`
    SELECT status FROM post_work WHERE post_id = ${postId}
  `;
  expect(work?.status).toBe("finalizing");
});

test("committed save with lost application receipt resumes from saved DB fact", async () => {
  const config = await seed();
  await writeFile(join(config.archiveRoot, postId, tempName), bytes);
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--preload",
      "./tests/helpers/fake-save-browser.ts",
      "--preload",
      "./tests/helpers/lose-save-receipt.ts",
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
  const [stderr, code] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, stderr).toBe(1);
  expect(stderr).toContain("提交结果未知");
  const [work] = await testSql<
    { status: string; publish_temp_name: string | null }[]
  >`
    SELECT status, publish_temp_name FROM post_work WHERE post_id = ${postId}
  `;
  expect(work).toEqual({ status: "saved", publish_temp_name: null });
  const resumed = await saveViaApplication(config, postId, matchingDetail());
  expect(resumed.status, resumed.message).toBe("ok");
  const [count] = await testSql<{ count: number }[]>`
    SELECT count(*)::integer AS count FROM media_versions
  `;
  expect(count?.count).toBe(1);
});

test.each(["发布文件", "正式文件已发布", "提交保存结果", "保存结果已提交"])(
  "real CLI process killed at %s resumes from persisted file and DB facts",
  async (stage) => {
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
          GMS_TEST_STOP_STAGE: stage,
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
      expect(first?.status).toBe(
        stage === "保存结果已提交" ? "saved" : "finalizing",
      );
      expect(
        await Bun.file(join(config.archiveRoot, relativePath)).exists(),
      ).toBe(stage !== "发布文件");
      const resumed = await saveViaApplication(
        config,
        postId,
        matchingDetail(),
      );
      expect(resumed.status, resumed.message).toBe("ok");
      const [count] = await testSql<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM media_versions
      `;
      expect(count?.count).toBe(1);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  },
);

test("real CLI reports blocked detail and known wait without clearing saved fact", async () => {
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
        GMS_TEST_BLOCKED: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stderr, code] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code).toBe(1);
  expect(stderr).toContain("HTTP 429");
  expect(stderr).toContain("建议等待 60");
  const [work] = await testSql<{ status: string }[]>`
    SELECT status FROM post_work WHERE post_id = ${postId}
  `;
  expect(work?.status).toBe("saved");
});

test("real CLI still exits 1 for a download needed without SIGINT", async () => {
  const config = await seed();
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
  const [stderr, code] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code).toBe(1);
  expect(stderr).toContain("需要下载");
  const [run] = await testSql<{ outcome: string }[]>`
    SELECT outcome FROM runs ORDER BY started_at DESC LIMIT 1
  `;
  expect(run?.outcome).toBe("failed");
});

test("P2-01 S1 save 拒绝未结清 archive 并保留发布恢复事实", async () => {
  const config = await seed();
  await testSql`UPDATE post_work SET goal = 'archive', last_error = '保留恢复现场' WHERE post_id = ${postId}`;
  await writeFile(join(config.archiveRoot, postId, tempName), bytes);
  const [before] =
    await testSql`SELECT * FROM post_work WHERE post_id = ${postId}`;
  let requests = 0;
  const result = await saveViaApplication(config, postId, {
    connect: async () => {
      requests += 1;
      throw new Error("不得连接浏览器");
    },
  });
  expect(result.status).toBe("failed");
  expect(result.message).toContain("archive post");
  expect(result.message).toContain("未处理");
  expect(requests).toBe(0);
  const [after] =
    await testSql`SELECT * FROM post_work WHERE post_id = ${postId}`;
  expect(after).toEqual(before);
  expect(await readFile(join(config.archiveRoot, postId, tempName))).toEqual(
    bytes,
  );
});

test("P2-01 S1 已结清 archive 即使文件缺失也直接跳过", async () => {
  const config = await seed();
  await testSql`UPDATE post_work SET goal = 'archive', archive_settled = true WHERE post_id = ${postId}`;
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

test.each([false, true])(
  "P2-01 S2 指定 save 保护 archive，结清=%s",
  async (settled) => {
    const config = await seed();
    await testSql`UPDATE post_work SET goal = 'archive', archive_settled = ${settled} WHERE post_id = ${postId}`;
    const [before] =
      await testSql`SELECT * FROM post_work WHERE post_id = ${postId}`;
    await rm(config.archiveRoot, { recursive: true });
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", "src/cli.ts", "save", "post", postId],
      {
        cwd: process.cwd(),
        env: {
          ...databaseEnv,
          GROK_ARCHIVE_DIR: config.archiveRoot,
          PLAYWRIGHT_MCP_EXTENSION_TOKEN: "fixture",
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
    expect(exitCode, stderr).toBe(settled ? 0 : 1);
    expect(stdout + stderr).toContain(settled ? "已归档结清" : "archive post");
    expect(stdout + stderr).not.toContain("核对发布意图");
    expect(stdout + stderr).not.toContain("读取当前详情");
    const [after] =
      await testSql`SELECT * FROM post_work WHERE post_id = ${postId}`;
    expect(after).toEqual(before);
  },
);
