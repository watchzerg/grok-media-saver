import type { SQL } from "bun";
import { inspectFirstPage, inspectPost } from "./application";
import { connectBrowserSession } from "./browser/session";
import type { DatabaseConfig, InspectConfig } from "./config";
import { createRequestScheduler } from "./grok/request-scheduler";
import { connectDatabase, safeDatabaseError } from "./store/database";
import { initializeSchema, verifySchema } from "./store/schema";

export type DatabaseResult = {
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
