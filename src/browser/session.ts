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

  let listRouteInstalled = false;

  return {
    cleanupNotices,
    async getFirstPage(signal) {
      if (closed || disconnected)
        throw new Error("Chrome Extension 连接已断开。");
      if (signal.aborted) throw new Error("检查已停止。");
      if (!page || page.isClosed()) {
        page = await context.newPage();
        closingPage = undefined;
        listRouteInstalled = false;
      }
      let rejectStopped!: (error: Error) => void;
      const stopped = new Promise<never>((_, reject) => {
        rejectStopped = reject;
      });
      void stopped.catch(() => {});
      const onAbort = () => {
        void closeOwnedPage().catch(() => {});
        rejectStopped(new Error("检查已停止。"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      let requestTimer: ReturnType<typeof setTimeout> | undefined;
      let preRequestTimer: ReturnType<typeof setTimeout> | undefined;
      let listRequestStarted = false;
      let requestTimedOut = false;
      let preRequestTimedOut = false;
      let rejectDeadline!: (error: Error) => void;
      const deadline = new Promise<never>((_, reject) => {
        rejectDeadline = reject;
      });
      const routeSavedListRequest = async (route: PageRouteLike) => {
        if (signal.aborted || requestTimedOut || preRequestTimedOut) {
          await route.abort();
          return;
        }
        if (isSavedListResponse(route.request().url())) {
          if (listRequestStarted) {
            await route.abort();
            return;
          }
          listRequestStarted = true;
          if (preRequestTimer) clearTimeout(preRequestTimer);
          preRequestTimer = undefined;
          onRequestStart();
          if (!requestTimer)
            requestTimer = setTimeout(() => {
              requestTimedOut = true;
              const error = new Error("Saved 请求超过 30 秒总期限。");
              error.name = "TimeoutError";
              rejectDeadline(error);
            }, API_TIMEOUT_MS);
        }
        if (signal.aborted) {
          await route.abort();
          return;
        }
        await route.continue();
      };
      try {
        if (signal.aborted) throw new Error("检查已停止。");
        if (!listRouteInstalled) {
          await Promise.race([
            page.route(LIST_REQUEST_PATTERN, routeSavedListRequest),
            stopped,
          ]);
          listRouteInstalled = true;
        }
        if (signal.aborted) throw new Error("检查已停止。");
        const preRequestDeadline = new Promise<never>((_, reject) => {
          preRequestTimer = setTimeout(() => {
            preRequestTimedOut = true;
            const error = new Error("Saved 页面未在 30 秒内发起列表请求。");
            error.name = "TimeoutError";
            reject(error);
          }, API_TIMEOUT_MS);
        });
        const responsePromise = page.waitForResponse(
          (response) => isSavedListResponse(response.url()),
          { timeout: 0 },
        );
        const navigation = page
          .goto(savedPageUrl, {
            waitUntil: "domcontentloaded",
            timeout: 0,
          })
          .then((navigation) => {
            if (
              isAuthenticationPage(page?.url()) ||
              isAuthenticationPage(navigation?.url())
            )
              throw new AuthenticationBlockedError(navigation?.status() ?? 0);
            return responsePromise;
          });
        const response = await Promise.race([
          responsePromise,
          navigation,
          preRequestDeadline,
          deadline,
          stopped,
        ]);
        const responseUrl = new URL(response.url());
        const headers = response.headers();
        const contentType = headers["content-type"] ?? "";
        let body: unknown = null;
        if (contentType.toLowerCase().includes("json")) {
          try {
            body = await Promise.race([response.json(), deadline, stopped]);
          } catch (error) {
            if (
              signal.aborted ||
              requestTimedOut ||
              isRetryableNetworkFailure(error)
            )
              throw error;
            body = null;
          }
        }
        const raw: RawPageResponse = {
          status: response.status(),
          contentType,
          body,
          finalPath:
            authenticationRedirectPath(headers.location, response.url()) ??
            responseUrl.pathname,
          retryAfter: headers["retry-after"] ?? null,
        };
        if (isAuthenticationPage(page?.url()))
          throw new AuthenticationBlockedError(0);
        if (disconnected)
          throw new UnconfirmedStopError(
            "Chrome Extension 连接中断，无法确认请求已停止。",
          );
        const parsed = parseSavedPageResponse(raw);
        if (
          parsed.kind === "temporary" ||
          authenticationRedirectPath(headers.location, response.url())
        ) {
          try {
            await closeOwnedPage();
          } catch (cleanupError) {
            throw new UnconfirmedStopError(
              "Saved 请求停止无法确认，已禁止继续。",
              { cause: cleanupError },
            );
          }
        }
        return parsed;
      } catch (error) {
        if (signal.aborted) throw error;
        if (
          error instanceof AuthenticationBlockedError ||
          isAuthenticationPage(page?.url())
        ) {
          try {
            await closeOwnedPage();
          } catch (cleanupError) {
            throw new UnconfirmedStopError(
              "登录阻挡后 Saved 请求停止无法确认。",
              { cause: cleanupError },
            );
          }
          return {
            kind: "blocked",
            status:
              error instanceof AuthenticationBlockedError ? error.status : 0,
            reason: "authentication",
          };
        }
        if (disconnected)
          throw new UnconfirmedStopError(
            "Chrome Extension 连接中断，无法确认请求已停止。",
            { cause: error },
          );
        if (isRetryableNetworkFailure(error)) {
          try {
            await closeOwnedPage();
          } catch (cleanupError) {
            throw new UnconfirmedStopError(
              "Saved 请求停止无法确认，已禁止重试。",
              { cause: cleanupError },
            );
          }
          throw new RetryableRequestError("Saved 请求发生网络错误或超时。", {
            cause: error,
          });
        }
        throw error;
      } finally {
        if (requestTimer) clearTimeout(requestTimer);
        if (preRequestTimer) clearTimeout(preRequestTimer);
        signal.removeEventListener("abort", onAbort);
      }
    },
    close,
  };
}

class AuthenticationBlockedError extends Error {
  constructor(readonly status: number) {
    super("登录或 challenge 页面阻挡 Saved 检查。");
  }
}

function isAuthenticationPage(value: string | undefined): boolean {
  return (
    value !== undefined &&
    /\/(?:login|signin|challenge|tos-gate)(?:\/|$)/i.test(safePath(value))
  );
}

function authenticationRedirectPath(
  location: string | undefined,
  base: string,
): string | undefined {
  if (!location) return undefined;
  try {
    const path = new URL(location, base).pathname;
    return isAuthenticationPage(`https://grok.com${path}`) ? path : undefined;
  } catch {
    return undefined;
  }
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
