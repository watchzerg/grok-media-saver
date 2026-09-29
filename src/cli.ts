import {
  archiveSaved,
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
  "用法：grok-media-saver db init | status | retry | verify <Post ID> | inspect first-page | inspect post <Post ID> | save first-page | save post <Post ID> | archive post <Post ID> | archive saved";

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
  const isArchiveSaved =
    args.length === 2 && args[0] === "archive" && args[1] === "saved";
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
        console.log(
          "结果：可能仍在运行或已中断；结束时间和数量未知，不能据此判断进程存活。",
        );
      } else {
        console.log(
          `结束于 ${latest.finishedAt}；结果：${latest.outcome ?? "未知"}。`,
        );
        const counts = formatRunCounts(latest.summary);
        console.log(counts ? `摘要：${counts}。` : "Run 摘要数量未知。");
        if (latest.command === "archive-saved")
          printBatchSummary(latest.summary, true);
      }
    } else if (result.status === "ok") {
      console.log("尚无 Run。");
    }
    if (result.status === "ok") {
      const save = result.unfinishedPosts.filter(
        (post) => post.goal === "save",
      ).length;
      const archive = result.unfinishedPosts.filter(
        (post) => post.goal === "archive",
      ).length;
      console.log(`当前数据库遗留：save ${save}，archive ${archive}。`);
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
    if (
      result.latestRun?.command === "archive-saved" &&
      !result.latestRun.summary
    )
      console.log(
        "批量历史数量、轮次、列表观察和当时遗留快照未知；未开始项须重新运行 archive saved 发现。",
      );
    if (result.status === "ok") console.log(result.message);
    else console.error(result.message);
    for (const error of result.cleanupErrors) console.error(error);
    return result.status === "ok" ? 0 : 1;
  }
  if (isArchiveSaved) {
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
      if (++stopCount === 1) controller.abort();
      else {
        console.error("已强制停止；删除意图及 Run 摘要须在重启后核对。");
        process.exit(130);
      }
    };
    process.on("SIGINT", stop);
    try {
      const result = await archiveSaved(config, {
        signal: controller.signal,
        onStage: (stage) => console.log(`阶段：${stage}。`),
      });
      console.log(result.message);
      printBatchSummary(result.summary);
      console.log(
        result.summaryRecorded === true
          ? "Run 摘要已持久记录。"
          : result.summaryRecorded === null
            ? "Run 摘要提交结果未知；请运行 status 读取实际数据库，不假定回滚。"
            : "Run 摘要未记录；请运行 status 核对持久事实。",
      );
      for (const post of result.posts) {
        if (!post.result.archiveRecorded)
          console.log(`${post.postId}：${post.result.message}`);
      }
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

function printBatchSummary(
  summary: Record<string, unknown> | null,
  historical = false,
): void {
  const value = (key: string) =>
    typeof summary?.[key] === "number" ? summary[key] : "未知";
  console.log(
    `${historical ? "历史批量摘要" : "本次批量结果"}：已发现 ${value("discovered")}，归档完成 ${value("archived")}，已结清跳过 ${value("skipped")}，未确认完成 ${value("unconfirmed")}，未处理 ${value("unprocessed")}；新确认移除 ${value("newRemovals")}（不保证数据库已记账）。`,
  );
  const complete =
    summary?.lastRoundComplete === true
      ? "处理完"
      : summary?.lastRoundComplete === false
        ? "未处理完"
        : summary?.rounds === 0
          ? "不适用"
          : "未知";
  const pages: Record<string, string> = {
    "not-read": "尚未读取",
    nonempty: "合法非空页",
    empty: "合法空页",
    failed: "读取失败",
  };
  const reasons: Record<string, string> = {
    completed: "满足完成条件",
    leftovers: "空页但有遗留",
    "no-progress": "No Progress",
    "page-failed": "读页失败",
    stopped: "用户停止",
    blocked: "全局阻挡",
    fault: "基础资源故障",
  };
  console.log(
    `已进入 ${value("rounds")} 轮；最后一轮：${complete}；最后列表观察：${pages[String(summary?.lastPage)] ?? "未知"}；结束原因：${reasons[String(summary?.endReason)] ?? "未知"}。`,
  );
  const leftovers = summary?.leftovers;
  const counts =
    leftovers &&
    typeof leftovers === "object" &&
    "save" in leftovers &&
    "archive" in leftovers
      ? leftovers
      : null;
  console.log(
    `${historical ? "该 Run 收尾时遗留快照" : "本次收尾数据库遗留"}：${counts ? `save ${counts.save}，archive ${counts.archive}` : "未知"}；可能与本次未确认完成重叠，不能相加。`,
  );
  console.log(
    "尚未读到的数量未知，不推断列表为空；未处理项未预建工作，请重新运行 archive saved 发现。已开始未完成工作请查看 status，处理原因后 retry，保持原目标。",
  );
  if (summary?.endReason === "no-progress")
    console.log(
      "第一页未能推进：失败工作可 retry；已结清重现项不会由 retry 清除，不自动翻页或循环。",
    );
  if (summary?.endReason === "leftovers")
    console.log(
      "空页仍有 save/archive 遗留，请处理原因后 retry，尚未全部完成。",
    );
  console.log(
    "删除意图待核对时先核对同一远端目标；已移除但未结清时仅接续绑定版本的文件核验或补救，不盲目重发 DELETE。",
  );
}

function formatRunCounts(
  summary: Record<string, unknown> | null,
): string | null {
  if (!summary) return null;
  const labels: Record<string, string> = {
    saved: "保存完成",
    archived: "归档完成",
    skipped: "已结清跳过",
    unconfirmed: "未确认完成",
    unprocessed: "未处理",
  };
  const parts = Object.entries(labels).flatMap(([key, label]) => {
    const value = summary[key];
    return typeof value === "number" && Number.isFinite(value)
      ? [`${label} ${value}`]
      : [];
  });
  return parts.length === 5 ? parts.join("，") : null;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
