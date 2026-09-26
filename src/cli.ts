import { inspectFirstPage } from "./application";
import { connectBrowserSession } from "./browser/session";
import { type InspectConfig, readInspectConfig } from "./config";
import { createRequestScheduler } from "./grok/request-scheduler";

const usage = "用法：grok-media-saver inspect first-page";

export async function main(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  if (args.length !== 2 || args[0] !== "inspect" || args[1] !== "first-page") {
    console.error(usage);
    return 2;
  }

  let config: InspectConfig;
  try {
    config = readInspectConfig(env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "配置无效。");
    return 2;
  }

  const scheduler = createRequestScheduler({
    minSeconds: config.requestIntervalMinSeconds,
    maxSeconds: config.requestIntervalMaxSeconds,
  });
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
    const result = await inspectFirstPage({
      signal: controller.signal,
      secrets: [config.extensionToken],
      connect: async () =>
        connectBrowserSession(config.savedPageUrl, scheduler.requestStarted),
      waitBeforeRetry: scheduler.beforeRequest,
    });
    console.log(result.message);
    for (const asset of result.assets)
      console.log(`${asset.assetId}  ${asset.mimeType}`);
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
