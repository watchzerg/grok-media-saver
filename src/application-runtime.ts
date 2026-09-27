import type { SQL } from "bun";
import { inspectFirstPage, inspectPost } from "./application";
import { connectBrowserSession } from "./browser/session";
import type { DatabaseConfig, InspectConfig, VerifyConfig } from "./config";
import { checkArchiveFile } from "./files/verify";
import { createRequestScheduler } from "./grok/request-scheduler";
import { connectDatabase, safeDatabaseError } from "./store/database";
import { initializeSchema, verifySchema } from "./store/schema";

export type DatabaseResult = {
  status: "ok" | "failed";
  message: string;
  cleanupErrors: string[];
};

export type ProjectStatusResult = DatabaseResult & {
  latestRun: {
    command: string;
    startedAt: string;
    finishedAt: string | null;
    outcome: string | null;
    summary: Record<string, unknown> | null;
  } | null;
  unfinishedPosts: { postId: string; status: string }[];
};

export type VerifyResult = {
  status: "ok" | "failed";
  message: string;
  cleanupErrors: string[];
};

export type DatabaseCloser = (
  sql: SQL,
  timeoutSeconds: number,
) => Promise<void>;

const closeDatabase: DatabaseCloser = (sql, timeoutSeconds) =>
  sql.close({ timeout: timeoutSeconds });

export function initializeProjectDatabase(
  config: DatabaseConfig,
  close: DatabaseCloser = closeDatabase,
): Promise<DatabaseResult> {
  return withDatabase(
    config,
    async (sql) => {
      await initializeSchema(sql);
      return "数据库结构已初始化。";
    },
    close,
  );
}

export function checkProjectDatabase(
  config: DatabaseConfig,
  close: DatabaseCloser = closeDatabase,
): Promise<DatabaseResult> {
  return withDatabase(
    config,
    async (sql) => {
      await verifySchema(sql);
      return "数据库结构与当前版本一致。";
    },
    close,
  );
}

export function readProjectStatus(
  config: DatabaseConfig,
  close: DatabaseCloser = closeDatabase,
): Promise<ProjectStatusResult> {
  return withStatusDatabase(config, close);
}

export async function verifySavedPost(
  config: VerifyConfig,
  postId: string,
  close: DatabaseCloser = closeDatabase,
): Promise<VerifyResult> {
  let sql: ReturnType<typeof connectDatabase> | undefined;
  let result: VerifyResult = {
    status: "failed",
    message: "文件核验失败。",
    cleanupErrors: [],
  };
  try {
    sql = connectDatabase(config);
    await verifySchema(sql);
    const [saved] = await sql<
      { relativePath: string; byteCount: string; sha256: string }[]
    >`
      SELECT m.relative_path AS "relativePath", m.byte_count::text AS "byteCount",
        m.sha256
      FROM post_work w
      JOIN media_versions m
        ON m.post_id = w.post_id AND m.id = w.saved_media_version_id
      WHERE w.post_id = ${postId}
    `;
    if (!saved) {
      result.message = `Post ${postId} 没有可核验的保存记录。`;
    } else {
      const check = await checkArchiveFile(
        config.archiveRoot,
        saved.relativePath,
        Number(saved.byteCount),
        saved.sha256,
      );
      const detail: Record<string, string> = {
        missing: "保存文件缺失。",
        directory: "保存路径是目录。",
        symlink: "保存路径是符号链接。",
        mismatch: "文件大小或 SHA-256 与保存记录不符。",
      };
      result =
        check.status === "ok"
          ? {
              status: "ok",
              message: `Post ${postId} 文件核验通过。`,
              cleanupErrors: [],
            }
          : {
              status: "failed",
              message: `Post ${postId} 文件核验异常：${check.status === "failed" ? check.reason : detail[check.status]}`,
              cleanupErrors: [],
            };
    }
  } catch (error) {
    result.message = `文件核验失败：${safeDatabaseError(error, config)}.`;
  }
  if (sql) {
    try {
      await close(sql, 5);
    } catch (error) {
      result.cleanupErrors.push(
        `数据库关闭失败：${safeDatabaseError(error, config)}`,
      );
      if (result.status === "ok")
        result.message = "文件核验已完成，但数据库连接关闭失败。";
      result.status = "failed";
    }
  }
  return result;
}

async function withStatusDatabase(
  config: DatabaseConfig,
  close: DatabaseCloser,
): Promise<ProjectStatusResult> {
  let sql: ReturnType<typeof connectDatabase> | undefined;
  let result: ProjectStatusResult = {
    status: "failed",
    message: "状态查询失败。",
    cleanupErrors: [],
    latestRun: null,
    unfinishedPosts: [],
  };
  try {
    sql = connectDatabase(config);
    await verifySchema(sql);
    const [latestRun] = await sql<ProjectStatusResult["latestRun"][]>`
      SELECT command, started_at::text AS "startedAt",
        finished_at::text AS "finishedAt", outcome, summary
      FROM runs
      ORDER BY started_at DESC, id DESC
      LIMIT 1
    `;
    const unfinishedPosts = await sql<ProjectStatusResult["unfinishedPosts"]>`
      SELECT post_id AS "postId", status
      FROM post_work
      WHERE status <> 'saved'
      ORDER BY post_id
    `;
    result = {
      status: "ok",
      message: "状态查询完成。",
      cleanupErrors: [],
      latestRun: latestRun ?? null,
      unfinishedPosts,
    };
  } catch (error) {
    result.message = `状态查询失败：${safeDatabaseError(error, config)}`;
  }
  if (sql) {
    try {
      await close(sql, 5);
    } catch (error) {
      const detail = safeDatabaseError(error, config);
      result.cleanupErrors.push(`数据库关闭失败：${detail}`);
      if (result.status === "ok")
        result.message = "状态查询已完成，但数据库连接关闭失败。";
      result.status = "failed";
    }
  }
  return result;
}

async function withDatabase(
  config: DatabaseConfig,
  operation: (sql: ReturnType<typeof connectDatabase>) => Promise<string>,
  close: DatabaseCloser,
): Promise<DatabaseResult> {
  let sql: ReturnType<typeof connectDatabase> | undefined;
  let result: DatabaseResult = {
    status: "failed",
    message: "数据库操作失败。",
    cleanupErrors: [],
  };
  try {
    sql = connectDatabase(config);
    const message = await operation(sql);
    result = { status: "ok", message, cleanupErrors: [] };
  } catch (error) {
    result = {
      status: "failed",
      message: `数据库操作失败：${safeDatabaseError(error, config)}`,
      cleanupErrors: [],
    };
  }
  if (sql) {
    try {
      await close(sql, 5);
    } catch (error) {
      const detail = safeDatabaseError(error, config);
      result.cleanupErrors.push(`数据库关闭失败：${detail}`);
      if (result.status === "ok")
        result.message = "数据库操作已完成，但连接关闭失败。";
      result.status = "failed";
    }
  }
  return result;
}

export async function inspectSavedFirstPage(
  config: InspectConfig,
  signal: AbortSignal,
) {
  const scheduler = createRequestScheduler({
    minSeconds: config.requestIntervalMinSeconds,
    maxSeconds: config.requestIntervalMaxSeconds,
  });
  return inspectFirstPage({
    signal,
    secrets: [config.extensionToken],
    connect: (connectSignal) =>
      connectBrowserSession(
        config.savedPageUrl,
        scheduler.requestStarted,
        connectSignal,
      ),
    waitBeforeRetry: scheduler.beforeRequest,
  });
}

export async function inspectSavedPost(
  config: InspectConfig,
  assetId: string,
  signal: AbortSignal,
) {
  const scheduler = createRequestScheduler({
    minSeconds: config.requestIntervalMinSeconds,
    maxSeconds: config.requestIntervalMaxSeconds,
  });
  return inspectPost(assetId, {
    signal,
    secrets: [config.extensionToken],
    connect: (connectSignal) =>
      connectBrowserSession(
        config.savedPageUrl,
        scheduler.requestStarted,
        connectSignal,
      ),
    waitBeforeRetry: scheduler.beforeRequest,
  });
}
