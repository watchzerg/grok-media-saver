export type SavedAsset = { assetId: string; mimeType: string };
export type PageResponse = {
  status: number;
  contentType: string;
  body: unknown;
  finalPath: string;
  retryAfter?: string | null;
};

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

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseAssets(body: unknown): SavedAsset[] | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const assets = (body as Record<string, unknown>).assets;
  if (!Array.isArray(assets)) return null;
  const parsed: SavedAsset[] = [];
  for (const value of assets) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const item = value as Record<string, unknown>;
    const mimeType = item.mimeType ?? item.mediaType;
    if (
      typeof item.assetId !== "string" ||
      !uuid.test(item.assetId) ||
      typeof mimeType !== "string" ||
      !mimeType.includes("/")
    )
      return null;
    parsed.push({ assetId: item.assetId, mimeType });
  }
  return parsed;
}

function isBlocked(response: PageResponse): boolean {
  return (
    response.status === 401 ||
    response.status === 429 ||
    /\/(?:login|signin|challenge)(?:\/|$)/i.test(response.finalPath)
  );
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status >= 500;
}

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
          result = { ...result, status: "cancelled", message: "检查已停止。" };
          break;
        }
        if (attempt < 2) {
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
      if (isBlocked(response)) {
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
      if (isRetryableStatus(response.status) && attempt < 2) {
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
      if (
        response.status !== 200 ||
        !response.contentType.toLowerCase().includes("json")
      ) {
        result = {
          ...result,
          message: `Saved 第一页不可读取（HTTP ${response.status}）。`,
        };
        break;
      }
      const assets = parseAssets(response.body);
      if (!assets) {
        result = {
          ...result,
          message: "Saved 第一页返回了无法识别的数据结构。",
        };
        break;
      }
      const hasNextPage = Boolean(
        (response.body as Record<string, unknown>).nextPageToken,
      );
      result = {
        status: "ok",
        assets,
        message: `Saved 第一页：${assets.length} 条${hasNextPage ? "，还有后续页面（未请求）" : ""}。${session.cleanupNotices?.length ? ` ${session.cleanupNotices.join(" ")}` : ""}`,
        cleanupErrors: [],
      };
      break;
    }
  } catch (error) {
    result = signal.aborted
      ? { ...result, status: "cancelled", message: "检查已停止。" }
      : {
          ...result,
          message: `浏览器连接失败：${safeError(error, options.secrets)}`,
        };
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
