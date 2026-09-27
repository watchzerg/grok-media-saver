import { constants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ReservedSQL } from "bun";
import type { SaveConfig } from "./config";
import { checkArchiveFile } from "./files/verify";
import type { PostResponse } from "./grok/adapter";
import { connectDatabase, safeDatabaseError } from "./store/database";
import {
  assertExecutorLock,
  releaseExecutorLock,
  tryAcquireExecutorLock,
} from "./store/executor";
import { verifySchema } from "./store/schema";

type Work = {
  status: string;
  selectedKey: string | null;
  quality: string | null;
  mimeType: string | null;
  expectedBytes: string | null;
  savedMediaVersionId: string | null;
  tempName: string | null;
  relativePath: string | null;
  publishBytes: string | null;
  sha256: string | null;
};

export type SavePostSession = {
  getPostDetail(postId: string, signal: AbortSignal): Promise<PostResponse>;
  close(): Promise<void>;
  cleanupNotices?: string[];
};

export type SavePostOptions = {
  connect(signal: AbortSignal): Promise<SavePostSession>;
  signal?: AbortSignal;
  onStage?: (stage: string) => void;
};

export type SavePostResult = {
  status: "ok" | "failed" | "cancelled";
  message: string;
  cleanupErrors: string[];
};

function code(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

function safeSaveError(error: unknown, config: SaveConfig): string {
  let message = safeDatabaseError(error, config);
  for (const secret of [
    config.extensionToken,
    encodeURIComponent(config.extensionToken),
  ]) {
    if (secret) message = message.replaceAll(secret, "[已隐藏]");
  }
  return message.replace(/([?&](?:token|auth|key)=)[^&\s]+/gi, "$1[已隐藏]");
}

function extension(mimeType: string | null): string | undefined {
  return (
    {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "video/mp4": "mp4",
      "video/webm": "webm",
    } as Record<string, string>
  )[mimeType?.toLowerCase() ?? ""];
}

function validIntent(postId: string, work: Work): boolean {
  const ext = extension(work.mimeType);
  return Boolean(
    ext &&
      work.sha256 &&
      /^[0-9a-f]{64}$/.test(work.sha256) &&
      work.relativePath === `${postId}/${work.sha256}.${ext}` &&
      work.tempName &&
      /^\.[a-zA-Z0-9_-]+\.part$/.test(work.tempName) &&
      work.publishBytes !== null &&
      Number.isSafeInteger(Number(work.publishBytes)) &&
      Number(work.publishBytes) >= 0,
  );
}

async function safePostDirectory(
  root: string,
  postId: string,
): Promise<string> {
  const rootPath = await realpath(root);
  const postPath = join(rootPath, postId);
  const details = await lstat(postPath);
  if (!details.isDirectory() || details.isSymbolicLink())
    throw new Error("Post 归档路径不是普通目录。");
  const actual = await realpath(postPath);
  if (actual !== postPath) throw new Error("Post 归档目录指向其他位置。");
  return postPath;
}

async function syncPublished(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function readWork(
  session: ReservedSQL,
  postId: string,
): Promise<Work | undefined> {
  const [work] = await session<Work[]>`
    SELECT status, selected_key AS "selectedKey", quality,
      mime_type AS "mimeType", expected_bytes::text AS "expectedBytes",
      saved_media_version_id::text AS "savedMediaVersionId",
      publish_temp_name AS "tempName",
      publish_relative_path AS "relativePath",
      publish_expected_bytes::text AS "publishBytes",
      publish_sha256 AS sha256
    FROM post_work WHERE post_id = ${postId}
  `;
  return work;
}

async function settleIntent(
  session: ReservedSQL,
  postId: string,
  work: Work,
  runId: string,
): Promise<void> {
  await session.begin(async (tx) => {
    const [version] = await tx<
      {
        id: string;
        byteCount: string;
        mimeType: string;
        relativePath: string;
      }[]
    >`
      SELECT id::text AS id, byte_count::text AS "byteCount",
        mime_type AS "mimeType", relative_path AS "relativePath"
      FROM media_versions WHERE post_id = ${postId} AND sha256 = ${work.sha256}
    `;
    if (
      version &&
      (version.byteCount !== work.publishBytes ||
        version.mimeType !== work.mimeType ||
        version.relativePath !== work.relativePath)
    )
      throw new Error("既有媒体版本与发布意图冲突。");
    const versionId = version?.id ?? crypto.randomUUID();
    if (!version)
      await tx`
        INSERT INTO media_versions
          (id, post_id, sha256, byte_count, mime_type, relative_path, saved_at)
        VALUES (${versionId}::uuid, ${postId}, ${work.sha256},
          ${work.publishBytes}::bigint, ${work.mimeType}, ${work.relativePath}, now())
      `;
    const updated = await tx<{ post_id: string }[]>`
      UPDATE post_work SET status = 'saved', last_run_id = ${runId}::uuid,
        saved_media_version_id = ${versionId}::uuid,
        publish_temp_name = NULL, publish_relative_path = NULL,
        publish_expected_bytes = NULL, publish_sha256 = NULL, last_error = NULL
      WHERE post_id = ${postId} AND status = 'finalizing'
        AND publish_sha256 = ${work.sha256}
      RETURNING post_id
    `;
    if (updated.length !== 1) throw new Error("发布意图在保存事务前发生变化。");
  });
}

async function cleanupOwnedTemp(
  tempPath: string,
  expectedBytes: number,
  sha256: string,
  archiveRoot: string,
  relativePath: string,
): Promise<string | undefined> {
  const checked = await checkArchiveFile(
    archiveRoot,
    relativePath,
    expectedBytes,
    sha256,
  );
  if (checked.status !== "ok") return "正式文件核验已变化，保留临时名称。";
  const tempRelative = `${dirname(relativePath)}/${basename(tempPath)}`;
  const temp = await checkArchiveFile(
    archiveRoot,
    tempRelative,
    expectedBytes,
    sha256,
  );
  if (temp.status === "missing") return undefined;
  if (temp.status !== "ok")
    return `临时文件归属无法确认，已保留（${temp.status === "failed" ? temp.reason : temp.status}）。`;
  try {
    await unlink(tempPath);
    return undefined;
  } catch {
    return "已保存，但临时文件清理失败。";
  }
}

export async function savePost(
  config: SaveConfig,
  postId: string,
  options: SavePostOptions,
): Promise<SavePostResult> {
  const signal = options.signal ?? new AbortController().signal;
  let sql: ReturnType<typeof connectDatabase> | undefined;
  let session: ReservedSQL | undefined;
  let browser: SavePostSession | undefined;
  let lockAcquired = false;
  let runId: string | undefined;
  let runWriteUnknown = false;
  let saved = false;
  const result: SavePostResult = {
    status: "failed",
    message: "Post 保存未完成。",
    cleanupErrors: [],
  };
  try {
    if (signal.aborted)
      return { ...result, status: "cancelled", message: "保存已停止。" };
    sql = connectDatabase(config);
    await verifySchema(sql);
    session = await sql.reserve();
    lockAcquired = await tryAcquireExecutorLock(session);
    if (!lockAcquired) throw new Error("已有保存执行正在运行。");
    await assertExecutorLock(session);
    await session`UPDATE runs SET outcome = 'interrupted' WHERE finished_at IS NULL`;
    runId = crypto.randomUUID();
    runWriteUnknown = true;
    await session`
      INSERT INTO runs (id, command, target_post_id, started_at)
      VALUES (${runId}::uuid, 'save-post', ${postId}, now())
    `;
    runWriteUnknown = false;
    await assertExecutorLock(session);
    if (signal.aborted) throw new Error("保存已停止。");
    let work = await readWork(session, postId);
    if (!work) {
      runWriteUnknown = true;
      await session`
        INSERT INTO post_work (post_id, status, last_run_id)
        VALUES (${postId}, 'pending', ${runId}::uuid)
      `;
      runWriteUnknown = false;
      work = await readWork(session, postId);
    }
    if (work?.status === "finalizing") {
      options.onStage?.("核对发布意图");
      if (signal.aborted) throw new Error("保存已停止；发布意图已保留。");
      if (!validIntent(postId, work))
        throw new Error("发布意图格式或目标路径无效，现场已保留。");
      let postDirectory: string | undefined;
      try {
        postDirectory = await safePostDirectory(config.archiveRoot, postId);
      } catch (error) {
        if (code(error) !== "ENOENT") throw error;
      }
      const finalPath = postDirectory
        ? join(postDirectory, basename(work.relativePath as string))
        : undefined;
      const tempPath = postDirectory
        ? join(postDirectory, work.tempName as string)
        : undefined;
      const bytes = Number(work.publishBytes);
      let publicationStarted = false;
      let final = await checkArchiveFile(
        config.archiveRoot,
        work.relativePath as string,
        bytes,
        work.sha256 as string,
      );
      if (final.status === "missing") {
        const tempRelative = `${postId}/${work.tempName}`;
        const temp = await checkArchiveFile(
          config.archiveRoot,
          tempRelative,
          bytes,
          work.sha256 as string,
        );
        if (temp.status === "missing") {
          runWriteUnknown = true;
          const cleared = await session<{ post_id: string }[]>`
            UPDATE post_work SET status = 'pending', last_run_id = ${runId}::uuid,
              publish_temp_name = NULL,
              publish_relative_path = NULL, publish_expected_bytes = NULL,
              publish_sha256 = NULL
            WHERE post_id = ${postId} AND status = 'finalizing'
              AND publish_sha256 = ${work.sha256}
            RETURNING post_id
          `;
          runWriteUnknown = false;
          if (cleared.length !== 1)
            throw new Error("待核对发布意图在清除前发生变化。");
        } else if (temp.status === "ok") {
          if (signal.aborted) throw new Error("保存已停止；发布意图已保留。");
          options.onStage?.("发布文件");
          publicationStarted = true;
          try {
            await link(tempPath as string, finalPath as string);
          } catch (error) {
            if (code(error) !== "EEXIST") throw error;
          }
          final = await checkArchiveFile(
            config.archiveRoot,
            work.relativePath as string,
            bytes,
            work.sha256 as string,
          );
          if (final.status !== "ok")
            throw new Error("正式文件发布后核验失败，发布意图已保留。");
          options.onStage?.("正式文件已发布");
        } else {
          throw new Error("临时文件与发布意图不符，现场已保留。");
        }
      }
      if (final.status !== "missing") {
        if (final.status !== "ok")
          throw new Error("正式文件与发布意图冲突，现场已保留。");
        if (signal.aborted && !publicationStarted)
          throw new Error("保存已停止；发布意图已保留。");
        options.onStage?.("同步正式文件");
        await syncPublished(finalPath as string);
        await assertExecutorLock(session);
        options.onStage?.("提交保存结果");
        runWriteUnknown = true;
        await settleIntent(session, postId, work, runId);
        runWriteUnknown = false;
        saved = true;
        options.onStage?.("保存结果已提交");
        const cleanup = await cleanupOwnedTemp(
          tempPath as string,
          bytes,
          work.sha256 as string,
          config.archiveRoot,
          work.relativePath as string,
        );
        if (cleanup) result.cleanupErrors.push(cleanup);
      }
      work = await readWork(session, postId);
    }
    if (signal.aborted) {
      result.status = "cancelled";
      result.message = "保存已停止；已开始的发布已完成一致性收尾。";
    } else {
      await assertExecutorLock(session);
      options.onStage?.("读取当前详情");
      browser = await options.connect(signal);
      const detail = await browser.getPostDetail(postId, signal);
      if (detail.kind !== "post") {
        if (work?.status !== "finalizing") {
          runWriteUnknown = true;
          await session`
            UPDATE post_work SET status = 'failed', last_run_id = ${runId}::uuid,
              last_error = '当前 Post 详情不可读取'
            WHERE post_id = ${postId}
          `;
          runWriteUnknown = false;
        }
        result.message = saved
          ? "旧发布意图已结清，但当前 Post 详情不可读取；本次保存未完成。"
          : "当前 Post 详情不可读取；本次保存未完成。";
      } else if (
        work?.status === "saved" &&
        work.selectedKey === detail.selection.key &&
        work.quality === detail.selection.quality &&
        work.mimeType === detail.selection.mimeType &&
        (work.expectedBytes === null ||
          detail.selection.expectedBytes === undefined ||
          Number(work.expectedBytes) === detail.selection.expectedBytes) &&
        work.relativePath === null &&
        work.savedMediaVersionId
      ) {
        const [version] = await session<
          { relativePath: string; byteCount: string; sha256: string }[]
        >`
          SELECT relative_path AS "relativePath", byte_count::text AS "byteCount", sha256
          FROM media_versions WHERE id = ${work.savedMediaVersionId}::uuid AND post_id = ${postId}
        `;
        const check =
          version &&
          (detail.selection.expectedBytes === undefined ||
            Number(version.byteCount) === detail.selection.expectedBytes)
            ? await checkArchiveFile(
                config.archiveRoot,
                version.relativePath,
                Number(version.byteCount),
                version.sha256,
              )
            : { status: "mismatch" as const };
        if (check.status === "ok") {
          result.status = "ok";
          result.message = saved
            ? "发布意图已结清，当前来源匹配；Post 保存完成。"
            : "当前来源匹配，已复用保存文件。";
        } else {
          runWriteUnknown = true;
          await session`
            UPDATE post_work SET status = 'pending', last_run_id = ${runId}::uuid,
              last_error = '当前保存文件无法复用'
            WHERE post_id = ${postId}
          `;
          runWriteUnknown = false;
          result.message =
            "当前保存文件无法复用，需要重新下载；本次保存未完成。";
        }
      } else {
        if (work?.status !== "finalizing") {
          runWriteUnknown = true;
          await session`
            UPDATE post_work SET status = 'pending', last_run_id = ${runId}::uuid,
              selected_key = ${detail.selection.key ?? null},
              quality = ${detail.selection.quality}, mime_type = ${detail.selection.mimeType},
              last_error = '需要下载当前来源'
            WHERE post_id = ${postId}
          `;
          runWriteUnknown = false;
        }
        result.message = "当前来源或元数据变化，需要下载；本次保存未完成。";
      }
    }
    if (runId) {
      await assertExecutorLock(session);
      runWriteUnknown = true;
      await session`
        UPDATE runs SET finished_at = now(),
          outcome = ${result.status === "ok" ? "succeeded" : result.status === "cancelled" ? "stopped" : "failed"},
          summary = ${result.status === "ok" ? JSON.stringify({ saved: 1, failed: 0, unprocessed: 0 }) : null}::jsonb
        WHERE id = ${runId}::uuid
      `;
      runWriteUnknown = false;
    }
  } catch (error) {
    result.status = signal.aborted && !runWriteUnknown ? "cancelled" : "failed";
    result.message = runWriteUnknown
      ? `数据库提交结果未知，已停止：${safeSaveError(error, config)}`
      : `保存失败：${safeSaveError(error, config)}`;
    if (runId && session && !runWriteUnknown) {
      try {
        await assertExecutorLock(session);
        runWriteUnknown = true;
        await session`
          UPDATE runs SET finished_at = now(), outcome = ${signal.aborted ? "stopped" : "failed"}
          WHERE id = ${runId}::uuid AND finished_at IS NULL
        `;
        runWriteUnknown = false;
      } catch {
        result.message = `${result.message} Run 收尾结果未知。`;
      }
    }
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        result.cleanupErrors.push(
          `浏览器清理失败：${safeSaveError(error, config)}`,
        );
      }
      if (browser.cleanupNotices?.length)
        result.cleanupErrors.push(...browser.cleanupNotices);
    }
    if (session) {
      if (lockAcquired) {
        try {
          await releaseExecutorLock(session);
        } catch (error) {
          result.cleanupErrors.push(
            `执行器锁清理失败：${safeSaveError(error, config)}`,
          );
        }
      }
      try {
        session.release();
      } catch (error) {
        result.cleanupErrors.push(
          `执行器连接释放失败：${safeSaveError(error, config)}`,
        );
      }
    }
    if (sql) {
      try {
        await sql.close({ timeout: 5 });
      } catch (error) {
        result.cleanupErrors.push(
          `数据库关闭失败：${safeSaveError(error, config)}`,
        );
      }
    }
    if (result.cleanupErrors.length && result.status === "ok") {
      result.status = "failed";
      result.message = "Post 已保存，但资源清理失败。";
    }
  }
  return result;
}
