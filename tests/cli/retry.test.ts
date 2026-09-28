import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeProjectDatabase,
  retryUnfinishedPosts,
} from "../../src/application-runtime";
import { readDatabaseConfig, readSaveConfig } from "../../src/config";
import {
  PublishConflictError,
  publishIntent,
} from "../../src/files/publish-intent";
import {
  parsePostDetailResponse,
  UnconfirmedStopError,
} from "../../src/grok/adapter";
import { databaseEnv, testSql, useIsolatedPostgres } from "../helpers/postgres";
import { seedSettledArchive } from "../helpers/seed-settled-archive";

useIsolatedPostgres();

test("P2-08 S2 空retry只需DB并接管遗留Run后记录零目标Run", async () => {
  await testSql`DROP TABLE IF EXISTS media_versions, post_work, runs CASCADE`;
  expect(
    (await initializeProjectDatabase(readDatabaseConfig(databaseEnv))).status,
  ).toBe("ok");

  const orphanId = crypto.randomUUID();
  await testSql`INSERT INTO runs(id,command,started_at) VALUES (${orphanId}::uuid,'save-post',now())`;
  const result = await runCli(databaseEnv, ["retry"]);
  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(result.stdout).toContain("没有未完成 Post");
  expect(result.stdout).toContain(
    "保存完成 0，归档完成 0，已结清跳过 0，未确认完成 0，未处理 0",
  );
  expect(result.stdout).not.toContain("阶段：");
  expect(result.stderr).toBe("");

  const [run] = await testSql<
    {
      command: string;
      finished_at: Date | null;
      outcome: string | null;
      summary: unknown;
    }[]
  >`SELECT command, finished_at, outcome, summary FROM runs WHERE command='retry'`;
  expect(
    (await testSql`SELECT outcome FROM runs WHERE id=${orphanId}::uuid`)[0],
  ).toEqual({ outcome: "interrupted" });
  expect(run?.command).toBe("retry");
  expect(run?.finished_at).toBeInstanceOf(Date);
  expect(run?.outcome).toBe("succeeded");
  expect(run?.summary).toEqual({
    saved: 0,
    archived: 0,
    skipped: 0,
    unconfirmed: 0,
    unprocessed: 0,
  });

  const status = await runCli(databaseEnv, ["status"]);
  expect(status.exitCode).toBe(0);
  expect(status.stdout).toContain("结果：succeeded");
  expect(status.stdout).toContain("保存完成 0");
});

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

test("SIGINT stops retry with exit 130 and records its Run before cleanup", async () => {
  await resetSchema();
  await installRetryDelayTrigger();
  try {
    const child = startCli(databaseEnv, ["retry"]);
    expect(await waitForRetryDelay()).toBe(true);
    child.kill("SIGINT");

    const result = await collectCli(child);
    expect(result.exitCode).toBe(130);
    expect(result.stderr).toContain("Run 已记录停止结果");
    const [run] = await testSql<
      { finished_at: Date | null; outcome: string | null; summary: unknown }[]
    >`SELECT finished_at, outcome, summary FROM runs`;
    expect(run?.finished_at).toBeInstanceOf(Date);
    expect(run?.outcome).toBe("stopped");
    expect(run?.summary).toEqual({
      saved: 0,
      archived: 0,
      skipped: 0,
      unconfirmed: 0,
      unprocessed: 0,
    });
  } finally {
    await dropRetryDelayTrigger();
  }
});

test("SIGINT during Run completion returns 130 while keeping the committed success", async () => {
  await resetSchema();
  await installRetryFinishDelayTrigger();
  try {
    const child = startCli(databaseEnv, ["retry"]);
    expect(await waitForRetryDelay()).toBe(true);
    child.kill("SIGINT");

    const result = await collectCli(child);
    expect(result.exitCode).toBe(130);
    expect(result.stderr).toContain("停止信号");
    const [run] = await testSql<
      { finished_at: Date | null; outcome: string | null; summary: unknown }[]
    >`SELECT finished_at, outcome, summary FROM runs`;
    expect(run?.finished_at).toBeInstanceOf(Date);
    expect(run?.outcome).toBe("succeeded");
    expect(run?.summary).toEqual({
      saved: 0,
      archived: 0,
      skipped: 0,
      unconfirmed: 0,
      unprocessed: 0,
    });
  } finally {
    await dropRetryFinishDelayTrigger();
  }
});

test("SIGINT during a rejected Run insert does not claim a stopped Run was recorded", async () => {
  await resetSchema();
  await installRetryInsertFailureTrigger();
  try {
    const child = startCli(databaseEnv, ["retry"]);
    expect(await waitForRetryDelay()).toBe(true);
    child.kill("SIGINT");

    const result = await collectCli(child);
    expect(result.exitCode).toBe(130);
    expect(result.stderr).not.toContain("Run 已记录停止结果");
    const [run] = await testSql<{ id: string }[]>`
      SELECT id FROM runs WHERE command = 'retry'
    `;
    expect(run).toBeUndefined();
  } finally {
    await dropRetryInsertFailureTrigger();
  }
});

test("retry does not compensate after a failed Run completion write", async () => {
  await resetSchema();
  await installRetryFinishFailureTrigger();
  try {
    const result = await runCli(databaseEnv, ["retry"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("结果未知");
    expect(result.stderr).toContain(
      "保存完成 0，归档完成 0，已结清跳过 0，未确认完成 0，未处理 0",
    );
    const [run] = await testSql<
      { outcome: string | null; finished_at: Date | null }[]
    >`SELECT outcome, finished_at FROM runs WHERE command = 'retry'`;
    expect(run?.outcome).toBeNull();
    expect(run?.finished_at).toBeNull();
    const [attempts] = await testSql<{ lastValue: string }[]>`
      SELECT last_value::text AS "lastValue" FROM retry_finish_attempt_seq
    `;
    expect(attempts?.lastValue).toBe("1");
  } finally {
    await dropRetryFinishFailureTrigger();
  }
});

test("retry saves a failed Post through the CLI and records its result", async () => {
  await resetSchema();
  const archiveRoot = await mkdtemp(join(tmpdir(), "gms-retry-"));
  try {
    await testSql`
    INSERT INTO post_work (post_id, status, last_error)
    VALUES ('123e4567-e89b-42d3-a456-426614174000', 'failed', 'HTTP 404')
  `;

    const result = await collectCli(
      Bun.spawn(
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
            ...databaseEnv,
            GROK_ARCHIVE_DIR: archiveRoot,
            PLAYWRIGHT_MCP_EXTENSION_TOKEN: "fixture-token",
            GMS_TEST_MEDIA: "1",
            GROK_API_INTERVAL_MIN_SECONDS: "0",
            GROK_API_INTERVAL_MAX_SECONDS: "0",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      ),
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("阶段：读取当前详情。");
    expect(result.stdout).toContain("阶段：下载当前媒体。");
    expect(result.stdout.indexOf("阶段：读取当前详情。")).toBeLessThan(
      result.stdout.indexOf("保存完成 1"),
    );
    expect(result.stdout).toContain("保存完成 1");
    expect(`${result.stdout}${result.stderr}`).not.toContain("fixture-token");
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      databaseEnv.GROK_DB_PASSWORD,
    );
    const [run] = await testSql<
      { finished_at: Date | null; outcome: string | null; summary: unknown }[]
    >`SELECT finished_at, outcome, summary FROM runs`;
    expect(run?.finished_at).toBeInstanceOf(Date);
    expect(run?.outcome).toBe("succeeded");
    expect(run?.summary).toEqual({
      saved: 1,
      archived: 0,
      skipped: 0,
      unconfirmed: 0,
      unprocessed: 0,
    });
    const [work] = await testSql<
      { status: string }[]
    >`SELECT status FROM post_work`;
    expect(work?.status).toBe("saved");
  } finally {
    await rm(archiveRoot, { recursive: true, force: true });
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

test("retry continues after a Post detail network failure exhausts its retry", async () => {
  await resetSchema();
  const root = await mkdtemp(join(tmpdir(), "gms-retry-network-"));
  const first = "123e4567-e89b-42d3-a456-426614174000";
  const second = "123e4567-e89b-42d3-a456-426614174001";
  const detailLog = join(root, "details.txt");
  try {
    await testSql`INSERT INTO post_work (post_id,status) VALUES (${first},'pending'),(${second},'pending')`;
    const result = await runFakeRetry({
      ...databaseEnv,
      GROK_ARCHIVE_DIR: root,
      GMS_TEST_MEDIA: "1",
      GMS_TEST_DETAIL_IDS: detailLog,
      GMS_TEST_NETWORK_FAILURE_ID: first,
    });
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.stderr).toContain(
      "保存完成 1，归档完成 0，已结清跳过 0，未确认完成 1，未处理 0",
    );
    expect((await readFile(detailLog, "utf8")).trim().split("\n")).toEqual([
      first,
      first,
      second,
    ]);
    const [later] = await testSql<{ status: string }[]>`
      SELECT status FROM post_work WHERE post_id=${second}`;
    expect(later?.status).toBe("saved");
    const [failed] = await testSql<
      { status: string; last_run_id: string; last_error: string }[]
    >`SELECT status,last_run_id::text AS last_run_id,last_error
      FROM post_work WHERE post_id=${first}`;
    const [run] = await testSql<{ id: string }[]>`
      SELECT id::text AS id FROM runs WHERE command='retry'`;
    expect(failed?.status).toBe("failed");
    expect(failed?.last_run_id).toBe(run?.id);
    expect(failed?.last_error).toContain("详情");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  {
    caseName: "initial detail and browser close",
    mediaRetry: false,
    closeFailure: true,
  },
  { caseName: "media retry detail", mediaRetry: true, closeFailure: false },
  {
    caseName: "media retry detail and browser close",
    mediaRetry: true,
    closeFailure: true,
  },
])(
  "retry records $caseName as a failed Post with accurate remaining count",
  async ({ mediaRetry, closeFailure }) => {
    await resetSchema();
    const root = await mkdtemp(join(tmpdir(), "gms-retry-detail-failure-"));
    const first = "123e4567-e89b-42d3-a456-426614174000";
    const second = "123e4567-e89b-42d3-a456-426614174001";
    const detailLog = join(root, "details.txt");
    try {
      await testSql`INSERT INTO post_work (post_id,status) VALUES (${first},'pending'),(${second},'pending')`;
      const result = await runFakeRetry({
        ...databaseEnv,
        GROK_ARCHIVE_DIR: root,
        GMS_TEST_MEDIA: "1",
        GMS_TEST_DETAIL_IDS: detailLog,
        ...(mediaRetry
          ? { GMS_TEST_MEDIA_RETRY_DETAIL_FAILURE_ID: first }
          : { GMS_TEST_NETWORK_FAILURE_ID: first }),
        ...(closeFailure ? { GMS_TEST_CLOSE_FAILURE: "1" } : {}),
      });
      expect(result.exitCode, result.stderr).toBe(1);
      expect(result.stderr).toContain(
        closeFailure
          ? "保存完成 0，归档完成 0，已结清跳过 0，未确认完成 1，未处理 1"
          : "保存完成 1，归档完成 0，已结清跳过 0，未确认完成 1，未处理 0",
      );
      if (closeFailure) expect(result.stderr).toContain("浏览器清理失败");
      expect((await readFile(detailLog, "utf8")).trim().split("\n")).toEqual(
        mediaRetry
          ? [first, first, first, second].slice(0, closeFailure ? 3 : 4)
          : [first, first, second].slice(0, closeFailure ? 2 : 3),
      );
      const [run] = await testSql<{ id: string; summary: unknown }[]>`
      SELECT id::text AS id,summary FROM runs WHERE command='retry'`;
      const [work] = await testSql<
        { status: string; last_run_id: string; last_error: string }[]
      >`
      SELECT status,last_run_id::text AS last_run_id,last_error
      FROM post_work WHERE post_id=${first}`;
      expect(run?.summary).toEqual({
        saved: closeFailure ? 0 : 1,
        archived: 0,
        skipped: 0,
        unconfirmed: 1,
        unprocessed: closeFailure ? 1 : 0,
      });
      expect(work?.status).toBe("failed");
      expect(work?.last_run_id).toBe(run?.id);
      expect(work?.last_error).toContain("详情");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("SIGINT after a nonempty retry snapshot records known unprocessed counts", async () => {
  await resetSchema();
  const root = await mkdtemp(join(tmpdir(), "gms-retry-early-stop-"));
  const postId = "123e4567-e89b-42d3-a456-426614174000";
  await testSql`INSERT INTO post_work (post_id,status) VALUES (${postId},'pending')`;
  await installRetryDelayTrigger();
  try {
    const child = startCli(
      {
        ...databaseEnv,
        GROK_ARCHIVE_DIR: root,
        PLAYWRIGHT_MCP_EXTENSION_TOKEN: "fixture-token",
      },
      ["retry"],
    );
    expect(await waitForRetryDelay()).toBe(true);
    child.kill("SIGINT");
    const result = await collectCli(child);
    expect(result.exitCode).toBe(130);
    expect(result.stderr).toContain(
      "保存完成 0，归档完成 0，已结清跳过 0，未确认完成 0，未处理 1",
    );
    const [run] = await testSql<{ outcome: string; summary: unknown }[]>`
      SELECT outcome,summary FROM runs WHERE command='retry'`;
    expect(run).toEqual({
      outcome: "stopped",
      summary: {
        saved: 0,
        archived: 0,
        skipped: 0,
        unconfirmed: 0,
        unprocessed: 1,
      },
    });
    const [work] = await testSql<{ status: string }[]>`
      SELECT status FROM post_work WHERE post_id=${postId}`;
    expect(work?.status).toBe("pending");
  } finally {
    await dropRetryDelayTrigger();
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  { response: "unavailable", blocked: false, closeFailure: false },
  { response: "unavailable", blocked: false, closeFailure: true },
  { response: "blocked", blocked: true, closeFailure: false },
  { response: "blocked", blocked: true, closeFailure: true },
  { response: "media-retry-blocked", blocked: true, closeFailure: false },
  { response: "media-retry-blocked", blocked: true, closeFailure: true },
])(
  "retry 保留返回式 $response 的原因与计数（cleanup=$closeFailure）",
  async ({ response, blocked, closeFailure }) => {
    await resetSchema();
    const root = await mkdtemp(join(tmpdir(), "gms-retry-return-cleanup-"));
    const first = "123e4567-e89b-42d3-a456-426614174000";
    const second = "123e4567-e89b-42d3-a456-426614174001";
    try {
      await testSql`INSERT INTO post_work (post_id,status) VALUES (${first},'pending'),(${second},'pending')`;
      const result = await runFakeRetry({
        ...databaseEnv,
        GROK_ARCHIVE_DIR: root,
        GMS_TEST_MEDIA: "1",
        ...(closeFailure ? { GMS_TEST_CLOSE_FAILURE: "1" } : {}),
        GMS_TEST_RETRY_AFTER: `60 fixture-token ${databaseEnv.GROK_DB_PASSWORD} https://example.invalid/?token=private-query`,
        [response === "media-retry-blocked"
          ? "GMS_TEST_MEDIA_RETRY_BLOCKED_ID"
          : blocked
            ? "GMS_TEST_BLOCKED_ID"
            : "GMS_TEST_UNAVAILABLE_ID"]: first,
      });
      expect(result.exitCode, result.stderr).toBe(1);
      const stopped = blocked || closeFailure;
      expect(result.stderr).toContain(
        stopped
          ? "保存完成 0，归档完成 0，已结清跳过 0，未确认完成 1，未处理 1"
          : "保存完成 1，归档完成 0，已结清跳过 0，未确认完成 1，未处理 0",
      );
      expect(result.stderr).toContain(
        blocked ? "HTTP 429" : "当前 Post 详情不可读取",
      );
      if (blocked) expect(result.stderr).toContain("服务端建议等待 60");
      if (closeFailure) expect(result.stderr).toContain("浏览器清理失败");
      const output = result.stdout + result.stderr;
      for (const secret of [
        "fixture-token",
        databaseEnv.GROK_DB_PASSWORD ?? "isolated-test-password",
        "private-query",
      ])
        expect(output).not.toContain(secret);
      const [run] = await testSql<{ summary: unknown }[]>`
      SELECT summary FROM runs WHERE command='retry'`;
      expect(run?.summary).toEqual({
        saved: stopped ? 0 : 1,
        archived: 0,
        skipped: 0,
        unconfirmed: 1,
        unprocessed: stopped ? 1 : 0,
      });
      if (response === "media-retry-blocked") {
        const [work] = await testSql<
          { status: string; saved_media_version_id: string | null }[]
        >`SELECT status,saved_media_version_id FROM post_work WHERE post_id=${first}`;
        expect(work).toEqual({
          status: "pending",
          saved_media_version_id: null,
        });
        expect(await readdir(join(root, first))).toEqual([]);
      }
      const [later] = await testSql<{ last_run_id: string | null }[]>`
      SELECT last_run_id FROM post_work WHERE post_id=${second}`;
      if (stopped) expect(later?.last_run_id).toBeNull();
      else expect(later?.last_run_id).not.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("retry continues after a finalizing Post conflicts with its published file", async () => {
  await resetSchema();
  const root = await mkdtemp(join(tmpdir(), "gms-retry-conflict-"));
  const first = "123e4567-e89b-42d3-a456-426614174000";
  const second = "123e4567-e89b-42d3-a456-426614174001";
  const bytes = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
    "hex",
  );
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const relative = `${first}/${digest}.png`;
  try {
    await mkdir(join(root, first));
    await writeFile(join(root, relative), "conflicting content");
    await testSql`
      INSERT INTO post_work (post_id,status,selected_key,quality,mime_type,
        publish_temp_name,publish_relative_path,publish_expected_bytes,publish_sha256)
      VALUES (${first},'finalizing','https://assets.grok.com/source.png','image','image/png',
        '.retry-conflict.part',${relative},${bytes.length},${digest})`;
    await testSql`INSERT INTO post_work (post_id,status) VALUES (${second},'pending')`;
    const result = await runFakeRetry({
      ...databaseEnv,
      GROK_ARCHIVE_DIR: root,
      GMS_TEST_MEDIA: "1",
    });
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.stderr).toContain(
      "保存完成 1，归档完成 0，已结清跳过 0，未确认完成 1，未处理 0",
    );
    expect(await readFile(join(root, relative), "utf8")).toBe(
      "conflicting content",
    );
    const works = await testSql<{ status: string }[]>`
      SELECT status FROM post_work ORDER BY post_id`;
    expect(works.map(({ status }) => status)).toEqual(["finalizing", "saved"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["different bytes", "directory", "symlink"])(
  "publish conflict after EEXIST preserves intent and classifies %s",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "gms-retry-publish-race-"));
    const postId = "123e4567-e89b-42d3-a456-426614174000";
    const bytes = Buffer.from("owned publication");
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const relativePath = `${postId}/${sha256}.png`;
    const finalPath = join(root, relativePath);
    const tempName = ".retry-race.part";
    try {
      await mkdir(join(root, postId));
      await writeFile(join(root, postId, tempName), bytes);
      await expect(
        publishIntent(
          root,
          postId,
          {
            mimeType: "image/png",
            sha256,
            relativePath,
            tempName,
            publishBytes: String(bytes.length),
          },
          new AbortController().signal,
          (stage) => {
            if (stage !== "发布文件") return;
            if (kind === "different bytes")
              writeFileSync(finalPath, "external content");
            else if (kind === "directory") mkdirSync(finalPath);
            else symlinkSync(tempName, finalPath);
          },
        ),
      ).rejects.toBeInstanceOf(PublishConflictError);
      expect(await readFile(join(root, postId, tempName))).toEqual(bytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each([{ closeFailure: false }, { closeFailure: true }])(
  "retry counts an ordinary publish conflict with browser cleanup failure=$closeFailure",
  async ({ closeFailure }) => {
    await resetSchema();
    const root = await mkdtemp(join(tmpdir(), "gms-retry-conflict-cleanup-"));
    const first = "123e4567-e89b-42d3-a456-426614174000";
    const second = "123e4567-e89b-42d3-a456-426614174001";
    try {
      await testSql`INSERT INTO post_work (post_id,status) VALUES (${first},'pending'),(${second},'pending')`;
      const result = await runFakeRetry({
        ...databaseEnv,
        GROK_ARCHIVE_DIR: root,
        GMS_TEST_MEDIA: "1",
        GMS_TEST_CONFLICT_ID: first,
        ...(closeFailure ? { GMS_TEST_CLOSE_FAILURE: "1" } : {}),
      });
      expect(result.exitCode, result.stderr).toBe(1);
      expect(result.stderr).toContain(
        closeFailure
          ? "保存完成 0，归档完成 0，已结清跳过 0，未确认完成 1，未处理 1"
          : "保存完成 1，归档完成 0，已结清跳过 0，未确认完成 1，未处理 0",
      );
      const [run] = await testSql<{ summary: unknown }[]>`
        SELECT summary FROM runs WHERE command='retry'`;
      expect(run?.summary).toEqual({
        saved: closeFailure ? 0 : 1,
        archived: 0,
        skipped: 0,
        unconfirmed: 1,
        unprocessed: closeFailure ? 1 : 0,
      });
      const [firstWork] = await testSql<
        { status: string; publish_temp_name: string | null }[]
      >`
        SELECT status,publish_temp_name FROM post_work WHERE post_id=${first}`;
      expect(firstWork?.status).toBe("finalizing");
      expect(firstWork?.publish_temp_name).not.toBeNull();
      const [later] = await testSql<
        { status: string; last_run_id: string | null }[]
      >`
        SELECT status,last_run_id FROM post_work WHERE post_id=${second}`;
      expect(later?.status).toBe(closeFailure ? "pending" : "saved");
      if (closeFailure) expect(later?.last_run_id).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("retry continues after an owned temp conflicts with its publish intent", async () => {
  await resetSchema();
  const root = await mkdtemp(join(tmpdir(), "gms-retry-temp-conflict-"));
  const first = "123e4567-e89b-42d3-a456-426614174000";
  const second = "123e4567-e89b-42d3-a456-426614174001";
  const bytes = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
    "hex",
  );
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const relative = `${first}/${digest}.png`;
  try {
    await mkdir(join(root, first));
    await writeFile(
      join(root, first, ".retry-conflict.part"),
      "conflicting content",
    );
    await testSql`
      INSERT INTO post_work (post_id,status,selected_key,quality,mime_type,
        publish_temp_name,publish_relative_path,publish_expected_bytes,publish_sha256)
      VALUES (${first},'finalizing','https://assets.grok.com/source.png','image','image/png',
        '.retry-conflict.part',${relative},${bytes.length},${digest})`;
    await testSql`INSERT INTO post_work (post_id,status) VALUES (${second},'pending')`;
    const result = await runFakeRetry({
      ...databaseEnv,
      GROK_ARCHIVE_DIR: root,
      GMS_TEST_MEDIA: "1",
    });
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.stderr).toContain(
      "保存完成 1，归档完成 0，已结清跳过 0，未确认完成 1，未处理 0",
    );
    expect(
      await readFile(join(root, first, ".retry-conflict.part"), "utf8"),
    ).toBe("conflicting content");
    const works = await testSql<
      { status: string }[]
    >`SELECT status FROM post_work ORDER BY post_id`;
    expect(works.map(({ status }) => status)).toEqual(["finalizing", "saved"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retry continues after an existing media version conflicts with its intent", async () => {
  await resetSchema();
  const root = await mkdtemp(join(tmpdir(), "gms-retry-version-conflict-"));
  const first = "123e4567-e89b-42d3-a456-426614174000";
  const second = "123e4567-e89b-42d3-a456-426614174001";
  const bytes = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
    "hex",
  );
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const relative = `${first}/${digest}.png`;
  try {
    await mkdir(join(root, first));
    await writeFile(join(root, relative), bytes);
    await testSql`
      INSERT INTO post_work (post_id,status,selected_key,quality,mime_type,
        publish_temp_name,publish_relative_path,publish_expected_bytes,publish_sha256)
      VALUES (${first},'finalizing','https://assets.grok.com/source.png','image','image/png',
        '.retry-conflict.part',${relative},${bytes.length},${digest})`;
    await testSql`INSERT INTO post_work (post_id,status) VALUES (${second},'pending')`;
    await testSql`
      INSERT INTO media_versions (id,post_id,sha256,byte_count,mime_type,relative_path,saved_at)
      VALUES (${crypto.randomUUID()}::uuid,${first},${digest},${bytes.length + 1},'image/png',${relative},now())`;
    const result = await runFakeRetry({
      ...databaseEnv,
      GROK_ARCHIVE_DIR: root,
      GMS_TEST_MEDIA: "1",
    });
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.stderr).toContain(
      "保存完成 1，归档完成 0，已结清跳过 0，未确认完成 1，未处理 0",
    );
    expect(await readFile(join(root, relative))).toEqual(bytes);
    const works = await testSql<
      { status: string }[]
    >`SELECT status FROM post_work ORDER BY post_id`;
    expect(works.map(({ status }) => status)).toEqual(["finalizing", "saved"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retry stops after a blocked Post and leaves later work untouched", async () => {
  await resetSchema();
  const root = await mkdtemp(join(tmpdir(), "gms-retry-blocked-"));
  const first = "123e4567-e89b-42d3-a456-426614174000";
  const second = "123e4567-e89b-42d3-a456-426614174001";
  try {
    await testSql`INSERT INTO post_work (post_id,status) VALUES (${first},'failed'),(${second},'pending')`;
    const result = await runFakeRetry({
      ...databaseEnv,
      GROK_ARCHIVE_DIR: root,
      GMS_TEST_BLOCKED_ID: first,
      GMS_TEST_MEDIA: "1",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("HTTP 429");
    expect(result.stderr).toContain("未处理 1");
    const [work] = await testSql<
      { status: string; last_run_id: string | null }[]
    >`
      SELECT status,last_run_id FROM post_work WHERE post_id=${second}`;
    expect(work).toEqual({ status: "pending", last_run_id: null });
    const [run] = await testSql<
      { summary: unknown }[]
    >`SELECT summary FROM runs WHERE command='retry'`;
    expect(run?.summary).toEqual({
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

test("retry settles a finalizing intent before checking the current detail", async () => {
  await resetSchema();
  const root = await mkdtemp(join(tmpdir(), "gms-retry-intent-"));
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const bytes = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
    "hex",
  );
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const relative = `${id}/${digest}.png`;
  const tempName = ".retry-recover.part";
  const detailLog = join(root, "details.txt");
  try {
    await mkdir(join(root, id));
    await writeFile(join(root, id, tempName), bytes);
    await testSql`
      INSERT INTO post_work (post_id,status,selected_key,quality,mime_type,
        publish_temp_name,publish_relative_path,publish_expected_bytes,publish_sha256)
      VALUES (${id},'finalizing','https://assets.grok.com/source.png','image','image/png',
        ${tempName},${relative},${bytes.length},${digest})`;
    const result = await runFakeRetry({
      ...databaseEnv,
      GROK_ARCHIVE_DIR: root,
      GMS_TEST_MEDIA: "1",
      GMS_TEST_DETAIL_IDS: detailLog,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect((await readFile(detailLog, "utf8")).trim()).toBe(id);
    expect(await Bun.file(join(root, relative)).bytes()).toEqual(bytes);
    const [work] = await testSql<
      { status: string; publish_temp_name: string | null }[]
    >`
      SELECT status,publish_temp_name FROM post_work WHERE post_id=${id}`;
    expect(work).toEqual({ status: "saved", publish_temp_name: null });
    const [versions] = await testSql<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM media_versions WHERE post_id=${id}`;
    expect(versions?.count).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SIGINT during nonempty retry leaves later members unprocessed", async () => {
  await resetSchema();
  const root = await mkdtemp(join(tmpdir(), "gms-retry-stop-"));
  const first = "123e4567-e89b-42d3-a456-426614174000";
  const second = "123e4567-e89b-42d3-a456-426614174001";
  try {
    await testSql`INSERT INTO post_work (post_id,status) VALUES (${first},'pending'),(${second},'failed')`;
    const result = await runFakeRetry({
      ...databaseEnv,
      GROK_ARCHIVE_DIR: root,
      GMS_TEST_ABORT_DETAIL: "1",
      GMS_TEST_MEDIA: "1",
    });
    expect(result.exitCode).toBe(130);
    expect(result.stderr).toContain(
      "保存完成 0，归档完成 0，已结清跳过 0，未确认完成 1，未处理 1",
    );
    const [later] = await testSql<
      { status: string; last_run_id: string | null }[]
    >`
      SELECT status,last_run_id FROM post_work WHERE post_id=${second}`;
    expect(later).toEqual({ status: "failed", last_run_id: null });
    const [run] = await testSql<{ outcome: string; summary: unknown }[]>`
      SELECT outcome,summary FROM runs WHERE command='retry'`;
    expect(run).toEqual({
      outcome: "stopped",
      summary: {
        saved: 0,
        archived: 0,
        skipped: 0,
        unconfirmed: 1,
        unprocessed: 1,
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SIGINT after one saved Post reports completed and unprocessed counts", async () => {
  await resetSchema();
  const root = await mkdtemp(join(tmpdir(), "gms-retry-stop-counts-"));
  const first = "123e4567-e89b-42d3-a456-426614174000";
  const second = "123e4567-e89b-42d3-a456-426614174001";
  try {
    await testSql`INSERT INTO post_work (post_id,status) VALUES (${first},'pending'),(${second},'pending')`;
    const result = await runFakeRetry({
      ...databaseEnv,
      GROK_ARCHIVE_DIR: root,
      GMS_TEST_MEDIA: "1",
      GMS_TEST_ABORT_DETAIL_ID: second,
    });
    expect(result.exitCode).toBe(130);
    expect(result.stderr).toContain(
      "保存完成 1，归档完成 0，已结清跳过 0，未确认完成 1，未处理 0",
    );
    const [run] = await testSql<{ outcome: string; summary: unknown }[]>`
      SELECT outcome,summary FROM runs WHERE command='retry'`;
    expect(run).toEqual({
      outcome: "stopped",
      summary: {
        saved: 1,
        archived: 0,
        skipped: 0,
        unconfirmed: 1,
        unprocessed: 0,
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SIGINT during retry reports a browser cleanup error with the known counts", async () => {
  await resetSchema();
  const root = await mkdtemp(join(tmpdir(), "gms-retry-stop-cleanup-"));
  const first = "123e4567-e89b-42d3-a456-426614174000";
  const second = "123e4567-e89b-42d3-a456-426614174001";
  try {
    await testSql`INSERT INTO post_work (post_id,status) VALUES (${first},'pending'),(${second},'pending')`;
    const result = await runFakeRetry({
      ...databaseEnv,
      GROK_ARCHIVE_DIR: root,
      GMS_TEST_ABORT_DETAIL: "1",
      GMS_TEST_CLOSE_FAILURE: "1",
      GMS_TEST_MEDIA: "1",
    });
    expect(result.exitCode).toBe(130);
    expect(result.stderr).toContain(
      "保存完成 0，归档完成 0，已结清跳过 0，未确认完成 1，未处理 1",
    );
    expect(result.stderr).toContain(
      "浏览器清理失败：simulated browser close failure",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retry leaves its Run open and later work untouched after losing its lock mid-Post", async () => {
  await resetSchema();
  const root = await mkdtemp(join(tmpdir(), "gms-retry-lock-loss-"));
  const first = "123e4567-e89b-42d3-a456-426614174000";
  const second = "123e4567-e89b-42d3-a456-426614174001";
  try {
    await testSql`INSERT INTO post_work (post_id,status) VALUES (${first},'pending'),(${second},'pending')`;
    await testSql.unsafe(`
      CREATE FUNCTION drop_lock_after_save() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.post_id = '${first}' AND NEW.status = 'saved' THEN
          PERFORM pg_advisory_unlock(1297043787, 1);
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER drop_lock_after_save AFTER UPDATE ON post_work
      FOR EACH ROW EXECUTE FUNCTION drop_lock_after_save();
    `);
    const result = await runFakeRetry({
      ...databaseEnv,
      GROK_ARCHIVE_DIR: root,
      GMS_TEST_MEDIA: "1",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("执行器会话锁已丢失");
    expect(result.stderr).toContain(
      "保存完成 1，归档完成 0，已结清跳过 0，未确认完成 0，未处理 1",
    );
    const [later] = await testSql<
      { status: string; last_run_id: string | null }[]
    >`
      SELECT status,last_run_id FROM post_work WHERE post_id=${second}`;
    expect(later).toEqual({ status: "pending", last_run_id: null });
    const [run] = await testSql<
      { outcome: string | null; finished_at: Date | null; summary: unknown }[]
    >`
      SELECT outcome,finished_at,summary FROM runs WHERE command='retry'`;
    expect(run).toEqual({ outcome: null, finished_at: null, summary: null });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retry stops later work when browser cleanup fails after a saved Post", async () => {
  await resetSchema();
  const root = await mkdtemp(join(tmpdir(), "gms-retry-cleanup-"));
  const first = "123e4567-e89b-42d3-a456-426614174000";
  const second = "123e4567-e89b-42d3-a456-426614174001";
  try {
    await testSql`INSERT INTO post_work (post_id,status) VALUES (${first},'pending'),(${second},'pending')`;
    const result = await runFakeRetry({
      ...databaseEnv,
      GROK_ARCHIVE_DIR: root,
      GMS_TEST_MEDIA: "1",
      GMS_TEST_CLOSE_FAILURE: "1",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("浏览器清理失败");
    expect(result.stderr).toContain(
      "保存完成 1，归档完成 0，已结清跳过 0，未确认完成 0，未处理 1",
    );
    const [firstWork] = await testSql<{ status: string }[]>`
      SELECT status FROM post_work WHERE post_id=${first}`;
    expect(firstWork?.status).toBe("saved");
    const [secondWork] = await testSql<
      { status: string; last_run_id: string | null }[]
    >`
      SELECT status,last_run_id FROM post_work WHERE post_id=${second}`;
    expect(secondWork).toEqual({ status: "pending", last_run_id: null });
    const [run] = await testSql<
      { summary: unknown }[]
    >`SELECT summary FROM runs WHERE command='retry'`;
    expect(run?.summary).toEqual({
      saved: 1,
      archived: 0,
      skipped: 0,
      unconfirmed: 0,
      unprocessed: 1,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retry CLI keeps completed counts when database cleanup fails", async () => {
  await resetSchema();
  const root = await mkdtemp(join(tmpdir(), "gms-retry-db-cleanup-"));
  const id = "123e4567-e89b-42d3-a456-426614174000";
  try {
    await testSql`INSERT INTO post_work (post_id,status) VALUES (${id},'pending')`;
    const result = await runFakeRetry({
      ...databaseEnv,
      GROK_ARCHIVE_DIR: root,
      GMS_TEST_MEDIA: "1",
      GMS_TEST_DATABASE_CLOSE_FAILURE: "1",
    });
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.stderr).toContain("重试 Run 已记录");
    expect(result.stderr).toContain(
      "保存完成 1，归档完成 0，已结清跳过 0，未确认完成 0，未处理 0",
    );
    expect(result.stderr).toContain(
      "数据库关闭失败：simulated database close failure",
    );
    expect(result.stderr).not.toContain("fixture-token");
    expect(result.stderr).not.toContain(databaseEnv.GROK_DB_PASSWORD);
    const [run] = await testSql<{ outcome: string; summary: unknown }[]>`
      SELECT outcome,summary FROM runs WHERE command='retry'`;
    expect(run).toEqual({
      outcome: "succeeded",
      summary: {
        saved: 1,
        archived: 0,
        skipped: 0,
        unconfirmed: 0,
        unprocessed: 0,
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retry CLI reports only confirmed progress after a save commit loses its receipt", async () => {
  await resetSchema();
  const root = await mkdtemp(join(tmpdir(), "gms-retry-unknown-save-"));
  const id = "123e4567-e89b-42d3-a456-426614174000";
  try {
    await testSql`INSERT INTO post_work (post_id,status) VALUES (${id},'pending')`;
    const result = await runFakeRetry({
      ...databaseEnv,
      GROK_ARCHIVE_DIR: root,
      GMS_TEST_MEDIA: "1",
      GMS_TEST_LOSE_SAVE_RECEIPT: "1",
    });
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.stderr).toContain("重试结果未知；未确认 Run 记账");
    expect(result.stderr).toContain(
      "保存完成 0，归档完成 0，已结清跳过 0，未确认完成 1，未处理 0",
    );
    expect(result.stderr).not.toContain("保存完成 1");
    const [run] = await testSql<
      { outcome: string | null; summary: unknown }[]
    >`SELECT outcome,summary FROM runs WHERE command='retry'`;
    expect(run).toEqual({ outcome: null, summary: null });
    const [work] = await testSql<{ status: string }[]>`
      SELECT status FROM post_work WHERE post_id=${id}`;
    expect(work?.status).toBe("saved");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retry shares nonzero pacing across failed Posts, detail retries and media requests", async () => {
  await resetSchema();
  const root = await mkdtemp(join(tmpdir(), "gms-retry-pacing-"));
  const first = "123e4567-e89b-42d3-a456-426614174000";
  const second = "123e4567-e89b-42d3-a456-426614174001";
  const third = "123e4567-e89b-42d3-a456-426614174002";
  const eventsPath = join(root, "requests.jsonl");
  try {
    await testSql`INSERT INTO post_work (post_id,status) VALUES (${first},'pending'),(${second},'pending'),(${third},'pending')`;
    const result = await runFakeRetry({
      ...databaseEnv,
      GROK_ARCHIVE_DIR: root,
      GROK_API_INTERVAL_MIN_SECONDS: "0.15",
      GROK_API_INTERVAL_MAX_SECONDS: "0.15",
      GMS_TEST_REQUEST_EVENTS: eventsPath,
      GMS_TEST_UNAVAILABLE_ID: first,
      GMS_TEST_RETRY_DETAIL: "1",
      GMS_TEST_RETRY_MEDIA_ID: second,
      GMS_TEST_MEDIA: "1",
    });
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.stderr).toContain(
      "保存完成 2，归档完成 0，已结清跳过 0，未确认完成 1，未处理 0",
    );
    const events: { kind: string; postId: string; at: number }[] = (
      await readFile(eventsPath, "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.map(({ kind, postId }) => [kind, postId])).toEqual([
      ["detail", first],
      ["detail", second],
      ["detail", second],
      ["media", second],
      ["detail", second],
      ["media", second],
      ["detail", third],
      ["detail", third],
      ["media", third],
    ]);
    for (let index = 1; index < events.length; index += 1) {
      const previous = events[index - 1];
      const current = events[index];
      if (!previous || !current) throw new Error("缺少请求时间证据");
      expect(
        current.at - previous.at,
        `${previous.kind} ${previous.postId} → ${current.kind} ${current.postId}`,
      ).toBeGreaterThanOrEqual(140);
    }
    const [run] = await testSql<
      { outcome: string; summary: unknown }[]
    >`SELECT outcome,summary FROM runs WHERE command='retry'`;
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
    const works = await testSql<
      { status: string }[]
    >`SELECT status FROM post_work ORDER BY post_id`;
    expect(works.map((work) => work.status)).toEqual([
      "failed",
      "saved",
      "saved",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SIGINT cancels retry pacing before the next Post opens a browser request", async () => {
  await resetSchema();
  const root = await mkdtemp(join(tmpdir(), "gms-retry-pacing-stop-"));
  const first = "123e4567-e89b-42d3-a456-426614174000";
  const second = "123e4567-e89b-42d3-a456-426614174001";
  const eventsPath = join(root, "requests.jsonl");
  await writeFile(eventsPath, "");
  await testSql`INSERT INTO post_work (post_id,status) VALUES (${first},'pending'),(${second},'pending')`;
  const child = startFakeRetry({
    ...databaseEnv,
    GROK_ARCHIVE_DIR: root,
    GROK_API_INTERVAL_MIN_SECONDS: "5",
    GROK_API_INTERVAL_MAX_SECONDS: "5",
    GMS_TEST_REQUEST_EVENTS: eventsPath,
    GMS_TEST_UNAVAILABLE_ID: first,
    GMS_TEST_MEDIA: "1",
  });
  const resultPromise = collectCli(child);
  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const [work] = await testSql<
        { status: string }[]
      >`SELECT status FROM post_work WHERE post_id=${first}`;
      if (work?.status === "failed") break;
      await Bun.sleep(10);
    }
    await Bun.sleep(100);
    const stoppedAt = Date.now();
    child.kill("SIGINT");
    const result = await resultPromise;
    expect(Date.now() - stoppedAt).toBeLessThan(2000);
    expect(result.exitCode, result.stderr).toBe(130);
    expect(result.stderr).toContain(
      "保存完成 0，归档完成 0，已结清跳过 0，未确认完成 2，未处理 0",
    );
    const events: { kind: string; postId: string }[] = (
      await readFile(eventsPath, "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.map(({ kind, postId }) => [kind, postId])).toEqual([
      ["detail", first],
    ]);
    const [work] = await testSql<
      { status: string; last_run_id: string | null }[]
    >`SELECT status,last_run_id FROM post_work WHERE post_id=${second}`;
    expect(work).toEqual({ status: "pending", last_run_id: null });
    const [run] = await testSql<
      { outcome: string; summary: unknown }[]
    >`SELECT outcome,summary FROM runs WHERE command='retry'`;
    expect(run).toEqual({
      outcome: "stopped",
      summary: {
        saved: 0,
        archived: 0,
        skipped: 0,
        unconfirmed: 2,
        unprocessed: 0,
      },
    });
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await resultPromise;
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
      ...(env.GMS_TEST_DATABASE_CLOSE_FAILURE === "1"
        ? ["--preload", "./tests/helpers/fail-retry-db-close.ts"]
        : []),
      ...(env.GMS_TEST_LOSE_SAVE_RECEIPT === "1"
        ? ["--preload", "./tests/helpers/lose-save-receipt.ts"]
        : []),
      ...(env.GMS_TEST_LOSE_ARCHIVE_RECEIPT
        ? ["--preload", "./tests/helpers/lose-archive-receipt.ts"]
        : []),
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

test("retry stops and leaves the Run unaccounted when its session lock is lost", async () => {
  await resetSchema();
  await testSql.unsafe(`
    CREATE FUNCTION drop_executor_lock() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_advisory_unlock(1297043787, 1);
      RETURN NEW;
    END
    $$
  `);
  await testSql.unsafe(`
    CREATE TRIGGER drop_executor_lock BEFORE INSERT ON runs
    FOR EACH ROW WHEN (NEW.command = 'retry') EXECUTE FUNCTION drop_executor_lock()
  `);

  try {
    const result = await runCli(databaseEnv, ["retry"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("执行器会话锁已丢失");
    const [run] = await testSql<
      { finished_at: Date | null; outcome: string | null; summary: unknown }[]
    >`SELECT finished_at, outcome, summary FROM runs`;
    expect(run?.finished_at).toBeNull();
    expect(run?.outcome).toBeNull();
    expect(run?.summary).toBeNull();
  } finally {
    await testSql.unsafe("DROP TRIGGER IF EXISTS drop_executor_lock ON runs");
    await testSql.unsafe("DROP FUNCTION IF EXISTS drop_executor_lock()");
  }
});

test("retry marks legacy open Runs interrupted without inventing a finish or summary", async () => {
  await resetSchema();
  await testSql`
    INSERT INTO runs (id, command, started_at)
    VALUES ('123e4567-e89b-42d3-a456-426614174001', 'save-post', now())
  `;

  const result = await runCli(databaseEnv, ["retry"]);
  expect(result.exitCode).toBe(0);
  const runs = await testSql<
    {
      command: string;
      finished_at: Date | null;
      outcome: string | null;
      summary: unknown;
    }[]
  >`SELECT command, finished_at, outcome, summary FROM runs ORDER BY command`;
  expect(runs).toContainEqual({
    command: "save-post",
    finished_at: null,
    outcome: "interrupted",
    summary: null,
  });
  expect(runs.find((run) => run.command === "retry")?.outcome).toBe(
    "succeeded",
  );
});

test("retry validates parameters and configuration before database startup", async () => {
  const usage = await runCli(databaseEnv, ["retry", "extra"]);
  expect(usage.exitCode).toBe(2);
  expect(usage.stderr).toContain("用法");

  const missingConfig = await runCli({ PATH: process.env.PATH ?? "" }, [
    "retry",
  ]);
  expect(missingConfig.exitCode).toBe(2);
  expect(missingConfig.stderr).toContain("GROK_DB_HOST");
  expect(missingConfig.stderr).not.toContain("PLAYWRIGHT_MCP_EXTENSION_TOKEN");
});

test("nonempty retry rejects missing save configuration before creating a Run", async () => {
  await resetSchema();
  await testSql`
    INSERT INTO post_work (post_id,status)
    VALUES ('123e4567-e89b-42d3-a456-426614174000','failed')`;
  const result = await runCli(databaseEnv, ["retry"]);
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("GROK_ARCHIVE_DIR");
  expect(result.stderr).toContain(
    "保存完成 0，归档完成 0，已结清跳过 0，未确认完成 0，未处理 1",
  );
  const [run] = await testSql<
    { id: string }[]
  >`SELECT id FROM runs WHERE command='retry'`;
  expect(run).toBeUndefined();
});

test("retry preserves its completed Run and reports an independent close failure", async () => {
  await resetSchema();
  const result = await retryUnfinishedPosts(
    readDatabaseConfig(databaseEnv),
    async (sql, timeoutSeconds) => {
      expect(timeoutSeconds).toBe(5);
      await sql.close({ timeout: timeoutSeconds });
      throw new Error("simulated database close failure");
    },
  );

  expect(result.status).toBe("failed");
  expect(result.message).toContain("重试 Run 已记录");
  expect(result.cleanupErrors).toEqual([
    "数据库关闭失败：simulated database close failure",
  ]);
  const [run] = await testSql<{ outcome: string }[]>`
    SELECT outcome FROM runs WHERE command = 'retry'
  `;
  expect(run?.outcome).toBe("succeeded");
});

test("stopped retry keeps exit classification and reports cleanup failure separately", async () => {
  await resetSchema();
  await installRetryDelayTrigger();
  const controller = new AbortController();
  try {
    const resultPromise = retryUnfinishedPosts(
      readDatabaseConfig(databaseEnv),
      async (sql, timeoutSeconds) => {
        await sql.close({ timeout: timeoutSeconds });
        throw new Error("simulated stop cleanup failure");
      },
      controller.signal,
    );
    expect(await waitForRetryDelay()).toBe(true);
    controller.abort();
    const result = await resultPromise;

    expect(result.status).toBe("cancelled");
    expect(result.cleanupErrors).toEqual([
      "数据库关闭失败：simulated stop cleanup failure",
    ]);
    const [run] = await testSql<{ outcome: string; summary: unknown }[]>`
      SELECT outcome, summary FROM runs
    `;
    expect(run?.outcome).toBe("stopped");
    expect(run?.summary).toEqual({
      saved: 0,
      archived: 0,
      skipped: 0,
      unconfirmed: 0,
      unprocessed: 0,
    });
  } finally {
    await dropRetryDelayTrigger();
  }
});

test("retry application result retains browser cleanup failure and known counts on stop", async () => {
  await resetSchema();
  const root = await mkdtemp(join(tmpdir(), "gms-retry-app-stop-"));
  const first = "123e4567-e89b-42d3-a456-426614174000";
  const second = "123e4567-e89b-42d3-a456-426614174001";
  const controller = new AbortController();
  try {
    await testSql`INSERT INTO post_work (post_id,status) VALUES (${first},'pending'),(${second},'pending')`;
    const result = await retryUnfinishedPosts(
      readDatabaseConfig(databaseEnv),
      async (sql, timeoutSeconds) => sql.close({ timeout: timeoutSeconds }),
      controller.signal,
      () =>
        readSaveConfig({
          ...databaseEnv,
          GROK_ARCHIVE_DIR: root,
          PLAYWRIGHT_MCP_EXTENSION_TOKEN: "fixture-token",
          GROK_API_INTERVAL_MIN_SECONDS: "0",
          GROK_API_INTERVAL_MAX_SECONDS: "0",
        }),
      async () => ({
        getPostDetail: async () => {
          controller.abort();
          return { kind: "unavailable", status: 404 };
        },
        close: async () => {
          throw new Error("simulated browser cleanup failure");
        },
      }),
    );
    expect(result.status).toBe("cancelled");
    expect(result.message).toContain(
      "保存完成 0，归档完成 0，已结清跳过 0，未确认完成 1，未处理 1",
    );
    expect(result.cleanupErrors).toEqual([
      "浏览器清理失败：simulated browser cleanup failure",
    ]);
    const [run] = await testSql<{ outcome: string; summary: unknown }[]>`
      SELECT outcome,summary FROM runs WHERE command='retry'`;
    expect(run).toEqual({
      outcome: "stopped",
      summary: {
        saved: 0,
        archived: 0,
        skipped: 0,
        unconfirmed: 1,
        unprocessed: 1,
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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

async function installRetryFinishDelayTrigger() {
  await testSql.unsafe(`
    CREATE FUNCTION delay_retry_finish() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_sleep(1);
      RETURN NEW;
    END
    $$
  `);
  await testSql.unsafe(`
    CREATE TRIGGER delay_retry_finish BEFORE UPDATE ON runs
    FOR EACH ROW WHEN (NEW.outcome = 'succeeded') EXECUTE FUNCTION delay_retry_finish()
  `);
}

async function installRetryInsertFailureTrigger() {
  await testSql.unsafe(`
    CREATE FUNCTION fail_retry_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_sleep(1);
      RAISE EXCEPTION 'simulated Run insert failure';
    END
    $$
  `);
  await testSql.unsafe(`
    CREATE TRIGGER fail_retry_insert BEFORE INSERT ON runs
    FOR EACH ROW WHEN (NEW.command = 'retry') EXECUTE FUNCTION fail_retry_insert()
  `);
}

async function dropRetryInsertFailureTrigger() {
  await testSql.unsafe("DROP TRIGGER IF EXISTS fail_retry_insert ON runs");
  await testSql.unsafe("DROP FUNCTION IF EXISTS fail_retry_insert()");
}

async function installRetryFinishFailureTrigger() {
  await testSql.unsafe(`CREATE SEQUENCE retry_finish_attempt_seq START 1`);
  await testSql.unsafe(`
    CREATE FUNCTION fail_retry_finish() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM nextval('retry_finish_attempt_seq');
      IF NEW.outcome = 'succeeded' THEN
        RAISE EXCEPTION 'simulated Run completion write failure';
      END IF;
      RETURN NEW;
    END
    $$
  `);
  await testSql.unsafe(`
    CREATE TRIGGER fail_retry_finish BEFORE UPDATE ON runs
    FOR EACH ROW WHEN (OLD.command = 'retry') EXECUTE FUNCTION fail_retry_finish()
  `);
}

async function dropRetryFinishFailureTrigger() {
  await testSql.unsafe("DROP TRIGGER IF EXISTS fail_retry_finish ON runs");
  await testSql.unsafe("DROP FUNCTION IF EXISTS fail_retry_finish()");
  await testSql.unsafe("DROP SEQUENCE IF EXISTS retry_finish_attempt_seq");
}

async function dropRetryFinishDelayTrigger() {
  await testSql.unsafe("DROP TRIGGER IF EXISTS delay_retry_finish ON runs");
  await testSql.unsafe("DROP FUNCTION IF EXISTS delay_retry_finish()");
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

const retryFirst = "123e4567-e89b-42d3-a456-426614174000";
const retrySecond = "123e4567-e89b-42d3-a456-426614174001";

test.each(["断连", "停止不确定", "丢锁"])(
  "P2-08 S1 核对%s停止整个Run并保留后项",
  async (fault) => {
    await resetSchema();
    const root = await mkdtemp(join(tmpdir(), "gms-retry-fatal-"));
    try {
      await testSql`INSERT INTO post_work (post_id,goal,status) VALUES (${retryFirst},'archive','saved'),(${retrySecond},'save','pending')`;
      await seedSettledArchive(testSql, retryFirst);
      await testSql`UPDATE post_work SET archive_settled=false, removal_state='pending' WHERE post_id=${retryFirst}`;
      const before = await testSql`SELECT * FROM post_work ORDER BY post_id`;
      const requests: string[] = [];
      let pageClosed = false;
      let databaseClosed = false;
      const result = await retryUnfinishedPosts(
        readDatabaseConfig(databaseEnv),
        async (sql, timeout) => {
          await sql.close({ timeout });
          databaseClosed = true;
        },
        undefined,
        () =>
          readSaveConfig({
            ...databaseEnv,
            GROK_ARCHIVE_DIR: root,
            PLAYWRIGHT_MCP_EXTENSION_TOKEN: "fixture-token",
            GROK_API_INTERVAL_MIN_SECONDS: "0",
            GROK_API_INTERVAL_MAX_SECONDS: "0",
          }),
        async () => ({
          getPostDetail: async (id) => {
            requests.push(`detail:${id}`);
            return { kind: "unavailable" as const, status: 404 };
          },
          checkPost: async (id) => {
            requests.push(`check:${id}`);
            if (fault === "停止不确定")
              throw new UnconfirmedStopError("模拟无法确认请求停止");
            if (fault === "丢锁") {
              await testSql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND pid IN (SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted)`;
              return {
                status: 404,
                contentType: "application/json",
                body: { code: 5, message: "Asset not found" },
                finalUrl: `https://grok.com/rest/assets/${id}`,
                method: "GET",
                redirected: false,
              };
            }
            throw new Error("模拟浏览器断连");
          },
          close: async () => {
            pageClosed = true;
          },
        }),
      );
      expect(result.status).toBe("failed");
      expect(requests).toEqual([`check:${retryFirst}`]);
      expect(await testSql`SELECT * FROM post_work ORDER BY post_id`).toEqual(
        before,
      );
      expect(pageClosed).toBe(true);
      expect(databaseClosed).toBe(true);
      const [run] = await testSql`SELECT finished_at, outcome FROM runs`;
      expect(run).toEqual({ finished_at: null, outcome: null });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

async function seedRetryArchives(root: string, ids: string[]) {
  for (const id of ids)
    await testSql`INSERT INTO post_work (post_id,goal,status) VALUES (${id},'archive','pending')`;
  const saved = await runFakeRetry({
    ...databaseEnv,
    GROK_ARCHIVE_DIR: root,
    GMS_TEST_MEDIA: "1",
  });
  expect(saved.exitCode, JSON.stringify(saved)).toBe(0);
  await testSql`UPDATE post_work SET last_run_id=NULL`;
  await testSql`DELETE FROM runs`;
}

test("P2-08 S2 混合未知与已移除补救共用许可且普通失败后继续", async () => {
  await resetSchema();
  const root = await mkdtemp(join(tmpdir(), "gms-retry-recovery-"));
  const events = join(root, "requests");
  const ids = Array.from(
    { length: 4 },
    (_, i) => `123e4567-e89b-42d3-a456-42661417400${i}`,
  );
  try {
    await seedRetryArchives(root, [ids[0] as string, ids[1] as string]);
    await testSql`UPDATE post_work SET archive_settled=false, removal_state='pending' WHERE post_id=${ids[0]}`;
    await testSql`UPDATE post_work SET archive_settled=false WHERE post_id=${ids[1]}`;
    const [version] =
      await testSql`SELECT relative_path FROM media_versions WHERE post_id=${ids[1]}`;
    await rm(join(root, version.relative_path));
    await testSql`INSERT INTO post_work(post_id,goal,status) VALUES (${ids[2]},'save','failed'),(${ids[3]},'archive','pending')`;
    const result = await runFakeRetry({
      ...databaseEnv,
      GROK_ARCHIVE_DIR: root,
      GMS_TEST_MEDIA: "1",
      GMS_TEST_REQUEST_EVENTS: events,
      GMS_TEST_CHECK_STATUS: "404",
      GMS_TEST_CHECK_BODY: JSON.stringify({
        code: 5,
        message: "Asset not found",
      }),
      GMS_TEST_UNAVAILABLE_ID: ids[2] as string,
      GROK_API_INTERVAL_MIN_SECONDS: "0.03",
      GROK_API_INTERVAL_MAX_SECONDS: "0.03",
    });
    expect(result.exitCode, JSON.stringify(result)).toBe(1);
    const requests = (await readFile(events, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      requests.map((request) => `${request.kind}:${request.postId}`),
    ).toEqual([
      `check:${ids[0]}`,
      "media:",
      `detail:${ids[2]}`,
      `detail:${ids[3]}`,
      `media:${ids[3]}`,
      `delete:${ids[3]}`,
    ]);
    for (let i = 1; i < requests.length; i++)
      expect(requests[i].at - requests[i - 1].at).toBeGreaterThanOrEqual(20);
    const rows =
      await testSql`SELECT goal,status,archive_settled FROM post_work ORDER BY post_id`;
    expect(rows).toEqual([
      { goal: "archive", status: "saved", archive_settled: true },
      { goal: "archive", status: "saved", archive_settled: true },
      { goal: "save", status: "failed", archive_settled: false },
      { goal: "archive", status: "saved", archive_settled: true },
    ]);
    expect((await testSql`SELECT outcome,summary FROM runs`)[0]).toEqual({
      outcome: "failed",
      summary: {
        saved: 0,
        archived: 3,
        skipped: 0,
        unconfirmed: 1,
        unprocessed: 0,
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["intent", "settle", "recovered"])(
  "P2-08 S2 %s提交已成功但丢回执不推进后项或收尾Run",
  async (receipt) => {
    await resetSchema();
    const root = await mkdtemp(join(tmpdir(), "gms-retry-receipt-"));
    const events = join(root, "requests");
    try {
      if (receipt === "recovered") {
        await seedRetryArchives(root, [retryFirst]);
        await testSql`UPDATE post_work SET archive_settled=false WHERE post_id=${retryFirst}`;
      } else
        await testSql`INSERT INTO post_work(post_id,goal,status) VALUES (${retryFirst},'archive','pending')`;
      await testSql`INSERT INTO post_work(post_id,goal,status,last_error) VALUES (${retrySecond},'save','failed','保留未开始事实')`;
      const [before] =
        await testSql`SELECT * FROM post_work WHERE post_id=${retrySecond}`;
      const result = await runFakeRetry({
        ...databaseEnv,
        GROK_ARCHIVE_DIR: root,
        GMS_TEST_MEDIA: "1",
        GMS_TEST_REQUEST_EVENTS: events,
        GMS_TEST_LOSE_ARCHIVE_RECEIPT: receipt,
      });
      expect(result.exitCode, JSON.stringify(result)).toBe(1);
      expect(result.stderr).toContain("未知");
      expect(
        (
          await testSql`SELECT * FROM post_work WHERE post_id=${retrySecond}`
        )[0],
      ).toEqual(before);
      expect((await testSql`SELECT finished_at,outcome FROM runs`)[0]).toEqual({
        finished_at: null,
        outcome: null,
      });
      if (receipt !== "recovered") {
        const requests = (await readFile(events, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(requests.map((request) => request.postId)).not.toContain(
          retrySecond,
        );
        expect(
          requests.filter((request) => request.kind === "delete").length,
        ).toBe(receipt === "intent" ? 0 : 1);
      }
      const [work] =
        await testSql`SELECT removal_state,archive_settled FROM post_work WHERE post_id=${retryFirst}`;
      expect(work).toEqual(
        receipt === "intent"
          ? { removal_state: "pending", archive_settled: false }
          : { removal_state: "removed", archive_settled: true },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("P2-08 S2 页面关闭失败仍断开连接与关闭DB且保留归档完成", async () => {
  await resetSchema();
  const root = await mkdtemp(join(tmpdir(), "gms-retry-cleanup-"));
  const events = join(root, "browser-events");
  try {
    await testSql`INSERT INTO post_work(post_id,goal,status) VALUES (${retryFirst},'archive','pending'),(${retrySecond},'save','pending')`;
    const before =
      await testSql`SELECT * FROM post_work WHERE post_id=${retrySecond}`;
    const result = await runFakeRetry({
      ...databaseEnv,
      GROK_ARCHIVE_DIR: root,
      GMS_TEST_MEDIA: "1",
      GMS_TEST_BROWSER_EVENTS: events,
      GMS_TEST_CLOSE_FAILURE: "1",
      GMS_TEST_DATABASE_CLOSE_FAILURE: "1",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("浏览器清理失败");
    expect(result.stderr).toContain("数据库关闭失败");
    expect((await readFile(events, "utf8")).trim().split("\n")).toEqual([
      "connect",
      "close-page",
      "close",
    ]);
    expect(
      (
        await testSql`SELECT archive_settled FROM post_work WHERE post_id=${retryFirst}`
      )[0],
    ).toEqual({ archive_settled: true });
    expect(
      await testSql`SELECT * FROM post_work WHERE post_id=${retrySecond}`,
    ).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P2-08 P2-11 S1 retry固定快照不纳入执行期新增工作且失败项不循环", async () => {
  await resetSchema();
  const root = await mkdtemp(join(tmpdir(), "gms-retry-snapshot-"));
  try {
    await testSql`INSERT INTO post_work(post_id,goal,status) VALUES (${retryFirst},'save','pending')`;
    const requests: string[] = [];
    const result = await retryUnfinishedPosts(
      readDatabaseConfig(databaseEnv),
      async (sql, timeout) => sql.close({ timeout }),
      undefined,
      () =>
        readSaveConfig({
          ...databaseEnv,
          GROK_ARCHIVE_DIR: root,
          PLAYWRIGHT_MCP_EXTENSION_TOKEN: "fixture-token",
          GROK_API_INTERVAL_MIN_SECONDS: "0",
          GROK_API_INTERVAL_MAX_SECONDS: "0",
        }),
      async () => ({
        getPostDetail: async (id) => {
          requests.push(id);
          await testSql`INSERT INTO post_work(post_id,goal,status,last_error) VALUES (${retrySecond},'archive','pending','执行期间新增')`;
          return { kind: "unavailable" as const, status: 404 };
        },
        close: async () => {},
      }),
    );
    expect(result.status).toBe("failed");
    expect(result.summary).toEqual({
      saved: 0,
      archived: 0,
      skipped: 0,
      unconfirmed: 1,
      unprocessed: 0,
    });
    expect(result.summaryRecorded).toBe(true);
    expect(result.posts).toMatchObject([
      {
        postId: retryFirst,
        goal: "save",
        result: { status: "failed", saveRecorded: false },
      },
    ]);
    expect(requests).toEqual([retryFirst]);
    expect(
      (
        await testSql`SELECT status,last_run_id,last_error FROM post_work WHERE post_id=${retrySecond}`
      )[0],
    ).toEqual({
      status: "pending",
      last_run_id: null,
      last_error: "执行期间新增",
    });
    expect((await testSql`SELECT summary FROM runs`)[0]).toEqual({
      summary: {
        saved: 0,
        archived: 0,
        skipped: 0,
        unconfirmed: 1,
        unprocessed: 0,
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["阻挡", "停止"])(
  "P2-08 S2 archive%s保留后项且结束本Run",
  async (reason) => {
    await resetSchema();
    const root = await mkdtemp(join(tmpdir(), "gms-retry-stop-"));
    const events = join(root, "requests");
    try {
      await testSql`INSERT INTO post_work(post_id,goal,status) VALUES (${retryFirst},'archive','pending'),(${retrySecond},'save','failed')`;
      const before =
        await testSql`SELECT * FROM post_work WHERE post_id=${retrySecond}`;
      const result = await runFakeRetry({
        ...databaseEnv,
        GROK_ARCHIVE_DIR: root,
        GMS_TEST_MEDIA: "1",
        GMS_TEST_REQUEST_EVENTS: events,
        ...(reason === "阻挡"
          ? { GMS_TEST_DELETE_STATUS: "429" }
          : { GMS_TEST_ABORT_DETAIL_ID: retryFirst }),
      });
      expect(result.exitCode, JSON.stringify(result)).toBe(
        reason === "阻挡" ? 1 : 130,
      );
      expect(
        await testSql`SELECT * FROM post_work WHERE post_id=${retrySecond}`,
      ).toEqual(before);
      const requests = (await readFile(events, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(requests.every((request) => request.postId === retryFirst)).toBe(
        true,
      );
      expect(requests.some((request) => request.kind === "check")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each([
  ...["断连", "停止不确定", "丢锁", "认证", "限流"].map((fault) => ({
    fault,
    failCleanup: false,
  })),
  { fault: "断连", failCleanup: true },
])(
  "P2-12 S1 DELETE阶段 $fault 清理失败=$failCleanup 阻止混合retry后项",
  async ({ fault, failCleanup }) => {
    await resetSchema();
    const root = await mkdtemp(join(tmpdir(), "gms-retry-delete-fault-"));
    try {
      await seedRetryArchives(root, [retryFirst]);
      await testSql`UPDATE post_work SET archive_settled=false, removal_state='none', deletion_media_version_id=NULL WHERE post_id=${retryFirst}`;
      await testSql`INSERT INTO post_work(post_id,goal,status) VALUES (${retrySecond},'save','failed')`;
      const before =
        await testSql`SELECT * FROM post_work WHERE post_id=${retrySecond}`;
      const requests: string[] = [];
      const cleanup: string[] = [];
      const result = await retryUnfinishedPosts(
        readDatabaseConfig(databaseEnv),
        async (sql, timeout) => {
          cleanup.push("database");
          await sql.close({ timeout });
          if (failCleanup) throw new Error("模拟独立DB关闭失败");
        },
        new AbortController().signal,
        () =>
          readSaveConfig({
            ...databaseEnv,
            GROK_ARCHIVE_DIR: root,
            PLAYWRIGHT_MCP_EXTENSION_TOKEN: "fixture-token",
            GROK_API_INTERVAL_MIN_SECONDS: "0",
            GROK_API_INTERVAL_MAX_SECONDS: "0",
          }),
        async () => ({
          getPostDetail: async (id) => {
            requests.push(`detail:${id}`);
            return parsePostDetailResponse(id, {
              status: 200,
              contentType: "application/json",
              finalPath: `/rest/assets/${id}`,
              body: {
                assetId: id,
                key: "https://assets.grok.com/source.png",
                mimeType: "image/png",
              },
            });
          },
          checkPost: async (id) => {
            requests.push(`check:${id}`);
            throw new Error("故障后不应追加核对");
          },
          deletePost: async (id) => {
            requests.push(`delete:${id}`);
            if (fault === "断连") throw new Error("模拟浏览器断连");
            if (fault === "停止不确定")
              throw new UnconfirmedStopError("模拟请求停止不确定");
            if (fault === "丢锁")
              await testSql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND pid IN (SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted)`;
            return {
              status: fault === "认证" ? 401 : fault === "限流" ? 429 : 200,
              contentType: "application/json",
              body: {},
              finalUrl: `https://grok.com/rest/assets/${id}`,
              method: "DELETE",
              redirected: false,
              retryAfter: "60",
            };
          },
          close: async () => {
            cleanup.push("browser");
            if (failCleanup) throw new Error("模拟独立连接关闭失败");
          },
        }),
      );
      expect(result.status).not.toBe("ok");
      expect(requests).toEqual([
        `detail:${retryFirst}`,
        `delete:${retryFirst}`,
      ]);
      expect(
        await testSql`SELECT * FROM post_work WHERE post_id=${retrySecond}`,
      ).toEqual(before);
      const [first] =
        await testSql`SELECT removal_state,archive_settled FROM post_work WHERE post_id=${retryFirst}`;
      expect(first).toEqual({
        removal_state: "pending",
        archive_settled: false,
      });
      expect(cleanup).toEqual(["browser", "database"]);
      if (failCleanup) {
        expect(result.cleanupErrors).toHaveLength(2);
        expect(result.cleanupErrors.join(" ")).toContain(
          "模拟独立连接关闭失败",
        );
        expect(result.cleanupErrors.join(" ")).toContain("模拟独立DB关闭失败");
      } else if (fault !== "丢锁") expect(result.cleanupErrors).toEqual([]);
      if (fault === "认证" || fault === "限流")
        expect(result.message).toContain("被阻挡");
      const [run] = await testSql`SELECT outcome FROM runs`;
      expect(run?.outcome).toBe(
        fault === "认证" || fault === "限流" ? "failed" : null,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
