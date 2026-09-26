import {
  type PageResponse,
  RetryableRequestError,
  type SavedAsset,
} from "./grok/adapter";

export type { PageResponse, SavedAsset } from "./grok/adapter";

export type InspectResult = {
  status: "ok" | "blocked" | "failed" | "cancelled";
  assets: SavedAsset[];
  message: string;
  cleanupErrors: string[];
};

export type InspectSession = {
  getFirstPage(signal: AbortSignal): Promise<PageResponse>;
  close(): Promise<void>;
  cleanupNotices?: string[];
};

export type InspectOptions = {
  connect(signal: AbortSignal): Promise<InspectSession>;
  signal?: AbortSignal;
  waitBeforeRetry?: (signal: AbortSignal) => Promise<void>;
  secrets?: string[];
};

export async function inspectFirstPage(
  options: InspectOptions,
): Promise<InspectResult> {
  const signal = options.signal ?? new AbortController().signal;
  let session: InspectSession | undefined;
  let result: InspectResult = {
    status: "failed",
    assets: [],
    message: "无法连接浏览器。",
    cleanupErrors: [],
  };
  try {
    if (signal.aborted)
      return { ...result, status: "cancelled", message: "检查已停止。" };
    session = await options.connect(signal);
    if (signal.aborted) {
      result = { ...result, status: "cancelled", message: "检查已停止。" };
    } else {
      let attempt = 0;
      while (attempt < 2) {
        if (signal.aborted) {
          result = { ...result, status: "cancelled", message: "检查已停止。" };
          break;
        }
        attempt += 1;
        let response: PageResponse;
        try {
          response = await session.getFirstPage(signal);
        } catch (error) {
          if (signal.aborted) {
            result = {
              ...result,
              status: "cancelled",
              message: "检查已停止。",
            };
            break;
          }
          if (error instanceof RetryableRequestError && attempt < 2) {
            try {
              await options.waitBeforeRetry?.(signal);
            } catch (waitError) {
              result = signal.aborted
                ? { ...result, status: "cancelled", message: "检查已停止。" }
                : {
                    ...result,
                    message: `等待下一次请求失败：${safeError(waitError, options.secrets)}`,
                  };
              break;
            }
            continue;
          }
          result = {
            ...result,
            message: `读取 Saved 第一页失败：${safeError(error, options.secrets)}`,
          };
          break;
        }
        if (signal.aborted) {
          result = { ...result, status: "cancelled", message: "检查已停止。" };
          break;
        }
        if (response.kind === "blocked") {
          const wait = response.retryAfter
            ? `；服务端建议等待 ${response.retryAfter}`
            : "";
          result = {
            ...result,
            status: "blocked",
            message: `Saved 请求被阻挡（HTTP ${response.status}）${wait}。`,
          };
          break;
        }
        if (response.kind === "temporary" && attempt < 2) {
          try {
            await options.waitBeforeRetry?.(signal);
          } catch (waitError) {
            result = signal.aborted
              ? { ...result, status: "cancelled", message: "检查已停止。" }
              : {
                  ...result,
                  message: `等待下一次请求失败：${safeError(waitError, options.secrets)}`,
                };
            break;
          }
          continue;
        }
        if (response.kind === "temporary" || response.kind === "unavailable") {
          result = {
            ...result,
            message: `Saved 第一页不可读取（HTTP ${response.status}）。`,
          };
          break;
        }
        if (response.kind !== "page") {
          result = {
            ...result,
            message: "Saved 第一页返回了无法识别的数据结构。",
          };
          break;
        }
        result = {
          status: "ok",
          assets: response.assets,
          message: `Saved 第一页：${response.assets.length} 条${response.hasNextPage ? "，还有后续页面（未请求）" : ""}。`,
          cleanupErrors: [],
        };
        break;
      }
    }
  } catch (error) {
    if (signal.aborted) {
      const detail = safeError(error, options.secrets);
      result = { ...result, status: "cancelled", message: "检查已停止。" };
      if (/清理失败|未能在 5 秒内/.test(detail)) {
        result.cleanupErrors.push(`浏览器清理失败：${detail}`);
        result.message = `${result.message} ${result.cleanupErrors.at(-1)}`;
      }
    } else {
      result = {
        ...result,
        message: `浏览器连接失败：${safeError(error, options.secrets)}`,
      };
    }
  } finally {
    if (session) {
      try {
        await session.close();
      } catch (error) {
        result.cleanupErrors.push(
          `浏览器清理失败：${safeError(error, options.secrets)}`,
        );
        if (result.status !== "cancelled") result.status = "failed";
        result.message = `${result.message} ${result.cleanupErrors.at(-1)}`;
      }
    }
    if (session?.cleanupNotices?.length) {
      result.message = `${result.message} ${session.cleanupNotices.join(" ")}`;
    }
  }
  return result;
}

function safeError(error: unknown, secrets: string[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets)
    if (secret) message = message.replaceAll(secret, "[已隐藏]");
  return message
    .replace(
      /PLAYWRIGHT_MCP_EXTENSION_TOKEN=[^\s&]+/gi,
      "PLAYWRIGHT_MCP_EXTENSION_TOKEN=[已隐藏]",
    )
    .replace(/([?&](?:token|auth|key)=)[^&\s]+/gi, "$1[已隐藏]");
}
