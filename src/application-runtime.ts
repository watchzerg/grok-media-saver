import type { SQL } from "bun";
import { inspectFirstPage, inspectPost } from "./application";
import { connectBrowserSession } from "./browser/session";
import type { DatabaseConfig, InspectConfig, VerifyConfig } from "./config";
import { checkArchiveFile } from "./files/verify";
import { createRequestScheduler } from "./grok/request-scheduler";
import { connectDatabase, safeDatabaseError } from "./store/database";
import {
  assertExecutorLock,
  releaseExecutorLock,
  tryAcquireExecutorLock,
} from "./store/executor";
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

export type RetryResult = Omit<DatabaseResult, "status"> & {
  status: "ok" | "failed" | "cancelled";
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

export async function retryUnfinishedPosts(
  config: DatabaseConfig,
  close: DatabaseCloser = closeDatabase,
  signal?: AbortSignal,
): Promise<RetryResult> {
  let sql: ReturnType<typeof connectDatabase> | undefined;
  let session:
    | Awaited<ReturnType<NonNullable<typeof sql>["reserve"]>>
    | undefined;
  let lockAcquired = false;
  let runId: string | undefined;
  let result: RetryResult = {
    status: "failed",
    message: "重试执行失败。",
    cleanupErrors: [],
  };

  try {
    if (signal?.aborted) {
      result = {
        status: "cancelled",
        message: "重试已停止。",
        cleanupErrors: [],
      };
      return result;
    }
    sql = connectDatabase(config);
    await verifySchema(sql);
    if (signal?.aborted) {
      result = {
        status: "cancelled",
        message: "重试已停止。",
        cleanupErrors: [],
      };
    } else {
      session = await sql.reserve(signal ? { signal } : undefined);
    }
    if (signal?.aborted) {
      result = {
        status: "cancelled",
        message: "重试已停止。",
        cleanupErrors: [],
      };
    }
    if (!session) throw new Error("未能取得执行器数据库会话。");
    lockAcquired = await tryAcquireExecutorLock(session);
    if (signal?.aborted) {
      result = {
        status: "cancelled",
        message: "重试已停止。",
        cleanupErrors: [],
      };
    } else if (!lockAcquired) {
      result.message = "已有保存执行正在运行。";
    } else {
      await assertExecutorLock(session);
      if (signal?.aborted) {
        result = {
          status: "cancelled",
          message: "重试已停止。",
          cleanupErrors: [],
        };
      } else {
        await session`
          UPDATE runs
          SET outcome = 'interrupted'
          WHERE finished_at IS NULL
        `;
        await assertExecutorLock(session);
        if (signal?.aborted) {
          result = {
            status: "cancelled",
            message: "重试已停止。",
            cleanupErrors: [],
          };
        } else {
          runId = crypto.randomUUID();
          await session`
            INSERT INTO runs (id, command, started_at)
            VALUES (${runId}::uuid, 'retry', now())
          `;
          await assertExecutorLock(session);

          if (signal?.aborted) {
            await finishStoppedRun(session, runId);
            result = {
              status: "cancelled",
              message: "重试已停止。Run 已记录停止结果。",
              cleanupErrors: [],
            };
          } else {
            const [pending] = await session<{ count: number }[]>`
              SELECT count(*)::integer AS count FROM post_work WHERE status <> 'saved'
            `;
            await assertExecutorLock(session);
            if (signal?.aborted) {
              await finishStoppedRun(session, runId);
              result = {
                status: "cancelled",
                message: "重试已停止。Run 已记录停止结果。",
                cleanupErrors: [],
              };
            } else if ((pending?.count ?? 0) > 0) {
              result.message = `重试失败：当前有 ${pending?.count ?? 0} 个未完成 Post，尚未实现非空重试。`;
              await session`
                UPDATE runs
                SET finished_at = now(), outcome = 'failed'
                WHERE id = ${runId}::uuid
              `;
              await assertExecutorLock(session);
            } else {
              await session`
                UPDATE runs
                SET finished_at = now(), outcome = 'succeeded',
                  summary = '{"saved":0,"failed":0,"unprocessed":0}'::jsonb
                WHERE id = ${runId}::uuid
              `;
              await assertExecutorLock(session);
              result = signal?.aborted
                ? {
                    status: "cancelled",
                    message: "收到停止信号；Run 已正常收尾。",
                    cleanupErrors: [],
                  }
                : {
                    status: "ok",
                    message: "没有未完成 Post，重试 Run 已正常结束。",
                    cleanupErrors: [],
                  };
            }
          }
        }
      }
    }
  } catch (error) {
    if (signal?.aborted) {
      result = {
        status: "cancelled",
        message: "重试已停止。",
        cleanupErrors: [],
      };
      if (runId && session) {
        try {
          await finishStoppedRun(session, runId);
          result.message = "重试已停止。Run 已记录停止结果。";
        } catch (stopError) {
          result.cleanupErrors.push(
            `停止 Run 收尾失败：${safeDatabaseError(stopError, config)}`,
          );
        }
      }
    } else {
      result.message = `重试执行失败：${safeDatabaseError(error, config)}`;
    }
    if (!signal?.aborted && runId && session) {
      try {
        await assertExecutorLock(session);
        await session`
          UPDATE runs
          SET finished_at = now(), outcome = 'failed'
          WHERE id = ${runId}::uuid AND finished_at IS NULL
        `;
      } catch {
        // A failed or unknown commit must not be reported as accounted.
      }
    }
  }

  if (session) {
    if (lockAcquired) {
      try {
        await releaseExecutorLock(session);
      } catch (error) {
        result.cleanupErrors.push(
          `执行器锁清理失败：${safeDatabaseError(error, config)}`,
        );
        if (result.status === "ok")
          result.message = "重试 Run 已记录，但执行器锁清理失败。";
        if (result.status !== "cancelled") result.status = "failed";
      }
    }
    try {
      session.release();
    } catch (error) {
      result.cleanupErrors.push(
        `执行器连接释放失败：${safeDatabaseError(error, config)}`,
      );
      if (result.status === "ok")
        result.message = "重试 Run 已记录，但执行器连接释放失败。";
      if (result.status !== "cancelled") result.status = "failed";
    }
  }
  if (sql) {
    try {
      await close(sql, 5);
    } catch (error) {
      result.cleanupErrors.push(
        `数据库关闭失败：${safeDatabaseError(error, config)}`,
      );
      if (result.status === "ok")
        result.message = "重试 Run 已记录，但数据库连接关闭失败。";
      if (result.status !== "cancelled") result.status = "failed";
    }
  }
  if (signal?.aborted) {
    result.status = "cancelled";
    if (!result.message.includes("停止"))
      result.message = "收到停止信号；Run 已完成必要收尾。";
  }
  return result;
}

async function finishStoppedRun(
  session: Awaited<
    ReturnType<NonNullable<ReturnType<typeof connectDatabase>>["reserve"]>
  >,
  runId: string,
): Promise<void> {
  await assertExecutorLock(session);
  await session`
    UPDATE runs SET finished_at = now(), outcome = 'stopped', summary = NULL
    WHERE id = ${runId}::uuid AND finished_at IS NULL
  `;
  await assertExecutorLock(session);
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
