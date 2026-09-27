import {
  initializeProjectDatabase,
  inspectSavedFirstPage,
  inspectSavedPost,
} from "./application-runtime";
import {
  type DatabaseConfig,
  type InspectConfig,
  readDatabaseConfig,
  readInspectConfig,
} from "./config";
import { normalizePostId } from "./grok/adapter";

const usage =
  "用法：grok-media-saver db init | inspect first-page | inspect post <Post ID>";

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
  const isPost =
    args.length === 3 && args[0] === "inspect" && args[1] === "post";
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
  if (!isFirstPage && !isPost) {
    console.error(usage);
    return 2;
  }

  const assetId = isPost ? normalizePostId(args[2]) : undefined;
  if (isPost && !assetId) {
    console.error("Post ID 必须是带连字符的 UUID。");
    return 2;
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

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
