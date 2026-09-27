import { expect, test } from "bun:test";
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
import { readDatabaseConfig, readVerifyConfig } from "../../src/config";
import { databaseEnv, testSql } from "../helpers/postgres";

const postId = "123e4567-e89b-42d3-a456-426614174000";
const contents = Buffer.from("verified archive fixture");
const digest = new Bun.CryptoHasher("sha256").update(contents).digest("hex");

test("verify reports a matching saved file through the real CLI", async () => {
  await testSql`DROP TABLE IF EXISTS media_versions, post_work, runs CASCADE`;
  expect(
    (await initializeProjectDatabase(readDatabaseConfig(databaseEnv))).status,
  ).toBe("ok");

  const archiveRoot = await mkdtemp(join(tmpdir(), "gms-verify-"));
  const relativePath = `${postId}/${digest}.png`;
  const filePath = join(archiveRoot, relativePath);
  await mkdir(join(archiveRoot, postId), { recursive: true });
  await writeFile(filePath, contents);
  await testSql`
    INSERT INTO post_work (post_id, status)
    VALUES (${postId}, 'saved')
  `;
  await testSql`
    INSERT INTO media_versions
      (id, post_id, sha256, byte_count, mime_type, relative_path, saved_at)
    VALUES
      ('223e4567-e89b-42d3-a456-426614174000', ${postId}, ${digest},
       ${contents.length}, 'image/png', ${relativePath}, now())
  `;
  await testSql`
    UPDATE post_work
    SET saved_media_version_id = '223e4567-e89b-42d3-a456-426614174000'
    WHERE post_id = ${postId}
  `;

  try {
    const before = await readPersistedFacts();
    const result = await runCli(
      { ...databaseEnv, GROK_ARCHIVE_DIR: archiveRoot },
      ["verify", `  ${postId.toUpperCase()}  `],
    );
    const after = await readPersistedFacts();

    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.stdout).toContain(postId);
    expect(result.stdout).toContain("核验通过");
    expect(result.stderr).toBe("");
    expect(after).toEqual(before);
    expect(await Bun.file(filePath).text()).toBe(contents.toString());

    const applicationResult = await verifySavedPost(
      readVerifyConfig({ ...databaseEnv, GROK_ARCHIVE_DIR: archiveRoot }),
      postId,
    );
    expect(applicationResult.status).toBe("ok");
    expect(applicationResult.message).toContain("文件核验通过");
  } finally {
    await rm(archiveRoot, { recursive: true, force: true });
  }
});

test("verify reports current-directory file anomalies without changing facts", async () => {
  const archiveRoot = await mkdtemp(join(tmpdir(), "gms-verify-cases-"));
  const otherRoot = await mkdtemp(join(tmpdir(), "gms-verify-other-"));
  const validPath = `${postId}/valid.bin`;
  const validFile = join(archiveRoot, validPath);
  await mkdir(join(archiveRoot, postId), { recursive: true });
  await writeFile(validFile, contents);
  await seedVersion(validPath);

  try {
    const cases: Array<[string, string, string]> = [
      ["missing", `${postId}/missing.bin`, "保存文件缺失"],
      ["changed bytes", validPath, "大小或 SHA-256"],
      ["directory", `${postId}/directory`, "路径是目录"],
      ["symlink", `${postId}/symlink`, "符号链接"],
    ];
    await mkdir(join(archiveRoot, postId, "directory"));
    await symlink(validFile, join(archiveRoot, postId, "symlink"));
    await writeFile(validFile, "different bytes");

    for (const [name, relativePath, expectedText] of cases) {
      await setVersionPath(relativePath);
      const before = await readPersistedFacts();
      const result = await runCli(
        { ...databaseEnv, GROK_ARCHIVE_DIR: archiveRoot },
        ["verify", postId],
      );
      const after = await readPersistedFacts();
      expect(result.exitCode, `${name}: ${JSON.stringify(result)}`).toBe(1);
      expect(result.stdout).toContain(expectedText);
      expect(result.stderr).toBe("");
      expect(after).toEqual(before);
    }

    await setVersionPath(validPath);
    const changedRoot = await runCli(
      { ...databaseEnv, GROK_ARCHIVE_DIR: otherRoot },
      ["verify", postId],
    );
    expect(changedRoot.exitCode).toBe(1);
    expect(changedRoot.stdout).toContain("保存文件缺失");

    await chmod(validFile, 0);
    if (process.getuid?.() !== 0) {
      const denied = await runCli(
        { ...databaseEnv, GROK_ARCHIVE_DIR: archiveRoot },
        ["verify", postId],
      );
      expect(denied.exitCode).toBe(1);
      expect(denied.stdout).toContain("无法访问归档文件");
      expect(denied.stdout).not.toContain("保存文件缺失");
    }
    await chmod(validFile, 0o600);
  } finally {
    await rm(archiveRoot, { recursive: true, force: true });
    await rm(otherRoot, { recursive: true, force: true });
  }
});

test("verify reports input and configuration errors before resource startup", async () => {
  const invalidId = await runCli({ PATH: process.env.PATH ?? "" }, [
    "verify",
    "https://grok.com/imagine/post/123",
  ]);
  expect(invalidId.exitCode).toBe(2);
  expect(invalidId.stderr).toContain("Post ID");
  expect(invalidId.stderr).not.toContain("GROK_DB_HOST");

  const missingConfig = await runCli({ PATH: process.env.PATH ?? "" }, [
    "verify",
    postId,
  ]);
  expect(missingConfig.exitCode).toBe(2);
  expect(missingConfig.stderr).toContain("GROK_DB_HOST");
  expect(missingConfig.stderr).not.toContain("PLAYWRIGHT_MCP_EXTENSION_TOKEN");

  const missingArchive = await runCli(databaseEnv, ["verify", postId]);
  expect(missingArchive.exitCode).toBe(2);
  expect(missingArchive.stderr).toContain("GROK_ARCHIVE_DIR");

  const archiveRoot = await mkdtemp(join(tmpdir(), "gms-verify-config-"));
  const secret = "verify-private-db-secret";
  try {
    const rejectedPassword = await runCli(
      {
        ...databaseEnv,
        GROK_ARCHIVE_DIR: archiveRoot,
        GROK_DB_PASSWORD: secret,
      },
      ["verify", postId],
    );
    expect(rejectedPassword.exitCode).toBe(1);
    expect(rejectedPassword.stderr).not.toContain(secret);
    expect(rejectedPassword.stdout).not.toContain(secret);
    expect(rejectedPassword.stderr).not.toContain(
      "PLAYWRIGHT_MCP_EXTENSION_TOKEN",
    );
  } finally {
    await rm(archiveRoot, { recursive: true, force: true });
  }
});

test("verify reports a Post without a saved version", async () => {
  await testSql`UPDATE post_work SET saved_media_version_id = NULL`;
  await testSql`DELETE FROM media_versions`;
  await testSql`DELETE FROM post_work`;
  await testSql`INSERT INTO post_work (post_id, status) VALUES (${postId}, 'failed')`;
  const archiveRoot = await mkdtemp(join(tmpdir(), "gms-verify-unsaved-"));
  try {
    const result = await runCli(
      { ...databaseEnv, GROK_ARCHIVE_DIR: archiveRoot },
      ["verify", postId],
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("没有可核验的保存记录");
  } finally {
    await rm(archiveRoot, { recursive: true, force: true });
  }
});

async function runCli(env: Record<string, string>, args: string[]) {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "src/cli.ts", ...args],
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

async function readPersistedFacts() {
  const runs = await testSql<unknown[]>`
    SELECT id, command, target_post_id, started_at, finished_at, outcome, summary
    FROM runs ORDER BY id
  `;
  const work = await testSql<unknown[]>`
    SELECT post_id, status, last_run_id, selected_key, quality, mime_type,
      expected_bytes, saved_media_version_id, last_error, publish_temp_name,
      publish_relative_path, publish_expected_bytes, publish_sha256
    FROM post_work ORDER BY post_id
  `;
  const versions = await testSql<unknown[]>`
    SELECT id, post_id, sha256, byte_count, mime_type, relative_path, saved_at
    FROM media_versions ORDER BY id
  `;
  return { runs, work, versions };
}

async function seedVersion(relativePath: string) {
  await testSql`DROP TABLE IF EXISTS media_versions, post_work, runs CASCADE`;
  expect(
    (await initializeProjectDatabase(readDatabaseConfig(databaseEnv))).status,
  ).toBe("ok");
  await testSql`
    INSERT INTO post_work (post_id, status)
    VALUES (${postId}, 'saved')
  `;
  await testSql`
    INSERT INTO media_versions
      (id, post_id, sha256, byte_count, mime_type, relative_path, saved_at)
    VALUES
      ('223e4567-e89b-42d3-a456-426614174000', ${postId}, ${digest},
       ${contents.length}, 'image/png', ${relativePath}, now())
  `;
  await testSql`
    UPDATE post_work
    SET saved_media_version_id = '223e4567-e89b-42d3-a456-426614174000'
    WHERE post_id = ${postId}
  `;
}

async function setVersionPath(relativePath: string) {
  await testSql`UPDATE media_versions SET relative_path = ${relativePath} WHERE post_id = ${postId}`;
}
