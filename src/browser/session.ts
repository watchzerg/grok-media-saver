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
const LIST_ENDPOINT =
  "/rest/assets?pageSize=40&orderBy=ORDER_BY_CREATE_TIME&workspaceKind=WORKSPACE_KIND_IMAGINE_ALL";

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
    await withTimeout(browser.close(), CLEANUP_TIMEOUT_MS);
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
  const cleanupNotices = context
    .pages()
    .some((existingPage) =>
      safePath(existingPage.url()).endsWith("/connect.html"),
    )
    ? [
        "Extension connect.html 的归属无法确认，已保留；请在 Chrome 中人工核对。",
      ]
    : [];

  const close = async () => {
    if (closed) return;
    closed = true;
    const failures: string[] = [];
    if (page && !page.isClosed()) {
      try {
        await withTimeout(page.close(), CLEANUP_TIMEOUT_MS);
      } catch {
        failures.push("应用创建的 Saved 页面未能在 5 秒内关闭");
      }
    }
    try {
      await withTimeout(browser.close(), CLEANUP_TIMEOUT_MS);
    } catch {
      failures.push("Chrome Extension 连接未能在 5 秒内断开");
    }
    if (failures.length) throw new Error(failures.join("；"));
  };

  const abortOwnedPage = () => {
    if (page && !page.isClosed())
      void withTimeout(page.close(), CLEANUP_TIMEOUT_MS).catch(() => {});
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
        if (page.url() === "about:blank") {
          await page.goto(savedPageUrl, {
            waitUntil: "domcontentloaded",
            timeout: API_TIMEOUT_MS,
          });
        }
        onRequestStart();
        let raw: RawPageResponse;
        try {
          raw = await page.evaluate(async (path) => {
            const response = await fetch(path, {
              credentials: "include",
              signal: AbortSignal.timeout(30_000),
            });
            const contentType = response.headers.get("content-type") ?? "";
            const retryAfter = response.headers.get("retry-after");
            const finalUrl = new URL(response.url);
            let body: unknown = null;
            if (contentType.toLowerCase().includes("json")) {
              try {
                body = await response.json();
              } catch {
                body = null;
              }
            }
            return {
              status: response.status,
              contentType,
              body,
              finalPath: finalUrl.pathname,
              retryAfter,
            };
          }, LIST_ENDPOINT);
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
        }
        return parseSavedPageResponse(raw);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
    close,
  };
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
