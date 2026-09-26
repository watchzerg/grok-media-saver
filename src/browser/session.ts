import bundle from "playwright-core/lib/coreBundle";
import type { PageResponse, RawPageResponse } from "../grok/adapter";
import {
  isRetryableNetworkFailure,
  parseSavedPageResponse,
  RetryableRequestError,
  UnconfirmedStopError,
} from "../grok/adapter";

const API_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const LIST_REQUEST_PATTERN = "**/rest/assets?*";

export type BrowserSession = {
  getFirstPage(signal: AbortSignal): Promise<PageResponse>;
  close(): Promise<void>;
  cleanupNotices: string[];
};

export async function connectBrowserSession(
  savedPageUrl: string,
  onRequestStart: () => void,
  signal: AbortSignal,
): Promise<BrowserSession> {
  if (signal.aborted) throw new Error("检查已停止。");
  const { browser } = await bundle.tools.createBrowserWithInfo(
    {
      extension: true,
      browser: {
        browserName: "chromium",
        launchOptions: {},
        contextOptions: {},
      },
    },
    { clientName: "Grok Media Saver", cwd: process.cwd() },
    { browser: "chrome" },
  );
  if (signal.aborted) {
    try {
      await withTimeout(browser.close(), CLEANUP_TIMEOUT_MS);
    } catch (error) {
      throw new Error(
        `检查已停止；浏览器连接清理失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw new Error("检查已停止。");
  }
  let closed = false;
  let disconnected = false;
  browser.on("disconnected", () => {
    disconnected = true;
  });
  const context = browser.contexts()[0];
  if (!context) {
    try {
      await withTimeout(browser.close(), CLEANUP_TIMEOUT_MS);
    } catch (error) {
      throw new Error(
        `Extension 未提供可用的 Chrome 登录态；连接清理失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw new Error("Extension 未提供可用的 Chrome 登录态。");
  }
  let page: Awaited<ReturnType<typeof context.newPage>> | undefined;
  let closingPage: Promise<void> | undefined;
  const cleanupNotices = context
    .pages()
    .some((existingPage) =>
      safePath(existingPage.url()).endsWith("/connect.html"),
    )
    ? [
        "Extension connect.html 的归属无法确认，已保留；请在 Chrome 中人工核对。",
      ]
    : [];

  const closeOwnedPage = () => {
    if (!page || page.isClosed()) return Promise.resolve();
    closingPage ??= withTimeout(page.close(), CLEANUP_TIMEOUT_MS);
    return closingPage;
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    const failures: string[] = [];
    try {
      await closeOwnedPage();
    } catch {
      failures.push("应用创建的 Saved 页面未能在 5 秒内关闭");
    }
    try {
      await withTimeout(browser.close(), CLEANUP_TIMEOUT_MS);
    } catch {
      failures.push("Chrome Extension 连接未能在 5 秒内断开");
    }
    if (failures.length) throw new Error(failures.join("；"));
  };

  const abortOwnedPage = () => {
    void closeOwnedPage().catch(() => {});
  };
  let listRouteInstalled = false;
  const routeSavedListRequest = async (route: PageRouteLike) => {
    if (isSavedListResponse(route.request().url())) onRequestStart();
    await route.continue();
  };

  return {
    cleanupNotices,
    async getFirstPage(signal) {
      if (closed || disconnected)
        throw new Error("Chrome Extension 连接已断开。");
      if (signal.aborted) throw new Error("检查已停止。");
      page ??= await context.newPage();
      const onAbort = () => abortOwnedPage();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        if (signal.aborted) throw new Error("检查已停止。");
        if (!listRouteInstalled) {
          await page.route(LIST_REQUEST_PATTERN, routeSavedListRequest);
          listRouteInstalled = true;
        }
        const responsePromise = page.waitForResponse(
          (response) => isSavedListResponse(response.url()),
          { timeout: API_TIMEOUT_MS },
        );
        const [, response] = await Promise.all([
          page.goto(savedPageUrl, {
            waitUntil: "domcontentloaded",
            timeout: API_TIMEOUT_MS,
          }),
          responsePromise,
        ]);
        const responseUrl = new URL(response.url());
        const headers = response.headers();
        const contentType = headers["content-type"] ?? "";
        let body: unknown = null;
        if (contentType.toLowerCase().includes("json")) {
          try {
            body = await response.json();
          } catch {
            body = null;
          }
        }
        const raw: RawPageResponse = {
          status: response.status(),
          contentType,
          body,
          finalPath: responseUrl.pathname,
          retryAfter: headers["retry-after"] ?? null,
        };
        if (disconnected)
          throw new UnconfirmedStopError(
            "Chrome Extension 连接中断，无法确认请求已停止。",
          );
        return parseSavedPageResponse(raw);
      } catch (error) {
        if (signal.aborted) throw error;
        if (disconnected)
          throw new UnconfirmedStopError(
            "Chrome Extension 连接中断，无法确认请求已停止。",
            { cause: error },
          );
        if (isRetryableNetworkFailure(error))
          throw new RetryableRequestError("Saved 请求发生网络错误或超时。", {
            cause: error,
          });
        throw error;
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
    close,
  };
}

function isSavedListResponse(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.pathname === "/rest/assets" &&
      url.searchParams.get("pageSize") === "40" &&
      url.searchParams.get("orderBy") === "ORDER_BY_CREATE_TIME" &&
      url.searchParams.get("workspaceKind") === "WORKSPACE_KIND_IMAGINE_ALL"
    );
  } catch {
    return false;
  }
}

function safePath(value: string): string {
  try {
    return new URL(value).pathname;
  } catch {
    return "";
  }
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("cleanup timeout")),
      milliseconds,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
