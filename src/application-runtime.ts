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

export function initializeProjectDatabase(
  config: DatabaseConfig,
): Promise<DatabaseResult> {
  return withDatabase(config, async (sql) => {
    await initializeSchema(sql);
    return "数据库结构已初始化。";
  });
}

export function checkProjectDatabase(
  config: DatabaseConfig,
): Promise<DatabaseResult> {
  return withDatabase(config, async (sql) => {
    await verifySchema(sql);
    return "数据库结构与当前版本一致。";
  });
}

async function withDatabase(
  config: DatabaseConfig,
  operation: (sql: ReturnType<typeof connectDatabase>) => Promise<string>,
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
      await sql.close({ timeout: 5 });
    } catch (error) {
      const detail = safeDatabaseError(error, config);
      result.cleanupErrors.push(`数据库关闭失败：${detail}`);
      result.status = "failed";
      result.message = `${result.message} ${result.cleanupErrors.at(-1)}`;
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
