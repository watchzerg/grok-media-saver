import {
  archiveSelectedPost,
  initializeProjectDatabase,
  inspectSavedFirstPage,
  inspectSavedPost,
  readProjectStatus,
  retryUnfinishedPosts,
  saveFirstPage,
  saveSelectedPost,
  verifySavedPost,
} from "./application-runtime";
import {
  type DatabaseConfig,
  type InspectConfig,
  readDatabaseConfig,
  readInspectConfig,
  readSaveConfig,
  readVerifyConfig,
} from "./config";
import { normalizePostId } from "./grok/adapter";

const usage =
  "用法：grok-media-saver db init | status | retry | verify <Post ID> | inspect first-page | inspect post <Post ID> | save first-page | save post <Post ID> | archive post <Post ID>";

type CliDependencies = {
  initializeProjectDatabase: typeof initializeProjectDatabase;
};

export async function main(
  args: string[],
  env: Record<string, string | undefined> = process.env,
  dependencies: CliDependencies = { initializeProjectDatabase },
): Promise<number> {
  const isFirstPage =
    args.length === 2 && args[0] === "inspect" && args[1] === "first-page";
  const isDatabaseInit =
    args.length === 2 && args[0] === "db" && args[1] === "init";
  const isStatus = args.length === 1 && args[0] === "status";
  const isRetry = args.length === 1 && args[0] === "retry";
  const isSaveFirstPage =
    args.length === 2 && args[0] === "save" && args[1] === "first-page";
  const isVerify = args.length === 2 && args[0] === "verify";
  const isPost =
    args.length === 3 && args[0] === "inspect" && args[1] === "post";
  const isSavePost =
    args.length === 3 && args[0] === "save" && args[1] === "post";
  const isArchivePost =
    args.length === 3 && args[0] === "archive" && args[1] === "post";
  if (isDatabaseInit) {
    let config: DatabaseConfig;
    try {
      config = readDatabaseConfig(env);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "配置无效。");
      return 2;
    }
    const result = await dependencies.initializeProjectDatabase(config);
    console.log(result.status === "ok" ? result.message : "数据库初始化失败。");
    for (const error of result.cleanupErrors) console.error(error);
    if (result.status === "failed") console.error(result.message);
    return result.status === "ok" ? 0 : 1;
  }
  if (isStatus) {
    let config: DatabaseConfig;
    try {
      config = readDatabaseConfig(env);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "配置无效。");
      return 2;
    }
    const result = await readProjectStatus(config);
    if (result.latestRun) {
      const latest = result.latestRun;
      console.log(`最近 Run：${latest.command}，开始于 ${latest.startedAt}。`);
      if (!latest.finishedAt) {
        console.log("结果：可能仍在运行或已中断；结束时间和数量未知。");
      } else {
        console.log(
          `结束于 ${latest.finishedAt}；结果：${latest.outcome ?? "未知"}。`,
        );
        const counts = formatRunCounts(latest.summary);
        console.log(counts ? `摘要：${counts}。` : "Run 摘要数量未知。");
      }
    } else if (result.status === "ok") {
      console.log("尚无 Run。");
    }
    if (result.unfinishedPosts.length === 0) {
      if (result.status === "ok") console.log("没有未完成 Post。");
    } else {
      console.log(`当前未完成 Post（${result.unfinishedPosts.length}）：`);
      for (const post of result.unfinishedPosts) {
        const settled =
          post.goal === "archive"
            ? post.archiveSettled
              ? "已结清"
              : "未结清"
            : "不适用";
        console.log(
          `  ${post.postId}  目标：${post.goal}  保存：${post.status}  移除：${post.removalState}  结清：${settled}  最近错误：${post.lastError ?? "无"}`,
        );
        if (post.removalState === "pending") {
          console.log(
            `    恢复提示：运行 archive post ${post.postId} 或 retry；恢复流程会先核对同一远端目标。`,
          );
        } else if (post.removalState === "removed" && !post.archiveSettled) {
          console.log(
            `    恢复提示：运行 archive post ${post.postId} 或 retry，接续绑定版本的本地核验或补救。`,
          );
        } else {
          const command =
            post.goal === "archive" ? "archive post" : "save post";
          console.log(
            `    恢复提示：运行 ${command} ${post.postId} 或 retry。`,
          );
        }
      }
    }
    if (result.status === "ok") console.log(result.message);
    else console.error(result.message);
    for (const error of result.cleanupErrors) console.error(error);
    return result.status === "ok" ? 0 : 1;
  }
  if (isRetry || isSaveFirstPage) {
    let config: DatabaseConfig;
    try {
      config = readDatabaseConfig(env);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "配置无效。");
      return 2;
    }
    const controller = new AbortController();
    let stopCount = 0;
    const stop = () => {
      stopCount += 1;
      if (stopCount === 1) controller.abort();
      else {
        console.error("已强制停止；Run 或数据库会话可能仍在收尾。");
        process.exit(130);
      }
    };
    process.on("SIGINT", stop);
    try {
      const result = await (isRetry ? retryUnfinishedPosts : saveFirstPage)(
        config,
        undefined,
        controller.signal,
        () => readSaveConfig(env),
        undefined,
        (stage) => console.log(`阶段：${stage}。`),
      );
      if (result.status === "ok") console.log(result.message);
      else console.error(result.message);
      for (const error of result.cleanupErrors) console.error(error);
      if (result.status === "cancelled") return 130;
      if (result.status === "invalid") return 2;
      return result.status === "ok" ? 0 : 1;
    } finally {
      process.off("SIGINT", stop);
    }
  }
  if (!isFirstPage && !isPost && !isVerify && !isSavePost && !isArchivePost) {
    console.error(usage);
    return 2;
  }

  const assetId =
    isPost || isSavePost || isArchivePost
      ? normalizePostId(args[2])
      : isVerify
        ? normalizePostId(args[1])
        : undefined;
  if ((isPost || isSavePost || isArchivePost || isVerify) && !assetId) {
    console.error("Post ID 必须是带连字符的 UUID。");
    return 2;
  }

  if (isVerify) {
    let config: ReturnType<typeof readVerifyConfig>;
    try {
      config = readVerifyConfig(env);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "配置无效。");
      return 2;
    }
    const result = await verifySavedPost(config, assetId as string);
    console.log(result.message);
    for (const error of result.cleanupErrors) console.error(error);
    return result.status === "ok" ? 0 : 1;
  }

  if (isSavePost || isArchivePost) {
    let config: ReturnType<typeof readSaveConfig>;
    try {
      config = readSaveConfig(env);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "配置无效。");
      return 2;
    }
    const controller = new AbortController();
    let stopCount = 0;
    const stop = () => {
      stopCount += 1;
      if (stopCount === 1) controller.abort();
      else {
        console.error("已强制停止；Run 或发布文件可能仍待核对。");
        process.exit(130);
      }
    };
    process.on("SIGINT", stop);
    try {
      const result = await (isArchivePost
        ? archiveSelectedPost
        : saveSelectedPost)(
        config,
        assetId as string,
        controller.signal,
        (stage) => console.log(`阶段：${stage}。`),
      );
      if (result.status === "ok") console.log(result.message);
      else console.error(result.message);
      for (const error of result.cleanupErrors) console.error(error);
      return result.status === "cancelled"
        ? 130
        : result.status === "ok"
          ? 0
          : 1;
    } finally {
      process.off("SIGINT", stop);
    }
  }

  let config: InspectConfig;
  try {
    config = readInspectConfig(env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "配置无效。");
    return 2;
  }

  const controller = new AbortController();
  let stopCount = 0;
  const stop = () => {
    stopCount += 1;
    if (stopCount === 1) controller.abort();
    else {
      console.error("已强制停止；浏览器或请求可能仍在收尾。");
      process.exit(130);
    }
  };
  process.on("SIGINT", stop);
  let exitCode = 1;
  try {
    const result = isPost
      ? await inspectSavedPost(config, assetId as string, controller.signal)
      : await inspectSavedFirstPage(config, controller.signal);
    console.log(result.message);
    if ("assets" in result)
      for (const asset of result.assets)
        console.log(`${asset.assetId}  ${asset.mimeType}`);
    if ("selection" in result && result.selection)
      console.log(`${result.selection.mimeType}  ${result.selection.quality}`);
    for (const error of result.cleanupErrors) console.error(error);
    if (result.status === "ok") exitCode = 0;
    else if (result.status === "cancelled") exitCode = 130;
    else exitCode = 1;
  } finally {
    process.off("SIGINT", stop);
  }
  return exitCode;
}

function formatRunCounts(
  summary: Record<string, unknown> | null,
): string | null {
  if (!summary) return null;
  const labels: Record<string, string> = {
    saved: "已保存",
    failed: "失败",
    unprocessed: "未处理",
  };
  const parts = Object.entries(labels).flatMap(([key, label]) => {
    const value = summary[key];
    return typeof value === "number" && Number.isFinite(value)
      ? [`${label} ${value}`]
      : [];
  });
  return parts.length > 0 ? parts.join("，") : null;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
