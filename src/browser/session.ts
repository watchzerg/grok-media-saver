import bundle from "playwright-core/lib/coreBundle";
import {
  type MediaSource,
  RetryableMediaError,
} from "../core/file-capabilities";
import type {
  PageResponse,
  PostResponse,
  RawPageResponse,
} from "../grok/adapter";
import {
  isRetryableNetworkFailure,
  parsePostDetailResponse,
  parseSavedPageResponse,
  RetryableRequestError,
  UnconfirmedStopError,
} from "../grok/adapter";

const API_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const LIST_REQUEST_PATTERN = "**/rest/assets?*";
const PLAYWRIGHT_EXTENSION_ID = "mmlmfjhmonkocbjadbfplnigmagldckm";

export type BrowserSession = {
  getFirstPage(signal: AbortSignal): Promise<PageResponse>;
  getPostDetail(assetId: string, signal: AbortSignal): Promise<PostResponse>;
  downloadMedia: MediaSource;
  isConnected(): boolean;
  closePage(): Promise<void>;
  close(): Promise<void>;
  cleanupNotices: string[];
};

export async function connectBrowserSession(
  savedPageUrl: string,
  onRequestStart: () => void,
  signal: AbortSignal,
): Promise<BrowserSession> {
  if (signal.aborted) throw new Error("检查已停止。");
  const clientName = `Grok Media Saver ${crypto.randomUUID()}`;
  const { browser } = await bundle.tools.createBrowserWithInfo(
    {
      extension: true,
      browser: {
        browserName: "chromium",
        launchOptions: {},
        contextOptions: {},
      },
    },
    { clientName, cwd: process.cwd() },
    { browser: "chrome" },
  );
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
  const cleanupNotices: string[] = [];
  const connectPages = context.pages().filter((existingPage) => {
    try {
      const url = new URL(existingPage.url());
      if (
        url.protocol !== "chrome-extension:" ||
        url.hostname !== PLAYWRIGHT_EXTENSION_ID ||
        url.pathname !== "/connect.html"
      )
        return false;
      return (
        JSON.parse(url.searchParams.get("client") ?? "null")?.name ===
        clientName
      );
    } catch {
      return false;
    }
  });
  const connectPage = connectPages.length === 1 ? connectPages[0] : undefined;
  if (!connectPage)
    cleanupNotices.push(
      "Extension connect.html 的归属无法确认，已保留；请在 Chrome 中人工核对。",
    );

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
    if (connectPage && !connectPage.isClosed()) {
      try {
        await withTimeout(connectPage.close(), CLEANUP_TIMEOUT_MS);
      } catch {
        failures.push("本次 Extension connect.html 未能在 5 秒内关闭");
      }
    }
    try {
      await withTimeout(browser.close(), CLEANUP_TIMEOUT_MS);
    } catch {
      failures.push("Chrome Extension 连接未能在 5 秒内断开");
    }
    if (failures.length) throw new Error(failures.join("；"));
  };
  if (signal.aborted) {
    try {
      await close();
    } catch (error) {
      throw new Error(
        `检查已停止；浏览器连接清理失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw new Error("检查已停止。");
  }

  let listRouteInstalled = false;

  return {
    cleanupNotices,
    isConnected: () => !closed && !disconnected,
    closePage: closeOwnedPage,
    async downloadMedia(selection, onResponse, onChunk, signal) {
      if (closed || disconnected)
        throw new UnconfirmedStopError("Chrome Extension 连接已断开。");
      if (!page || page.isClosed())
        throw new Error("媒体请求需要已确认的 Post 页面。");
      if (!selection.key) throw new Error("所选媒体缺少地址。");
      const mediaPage = page;
      const binding = `gmsMedia${crypto.randomUUID().replaceAll("-", "")}`;
      let sinkError: unknown;
      let rejectStopped!: (error: Error) => void;
      const stopped = new Promise<never>((_, reject) => {
        rejectStopped = reject;
      });
      void stopped.catch(() => {});
      const onAbort = () => {
        void closeOwnedPage().then(
          () => rejectStopped(new Error("媒体请求已停止。")),
          (error) =>
            rejectStopped(
              new UnconfirmedStopError("媒体请求停止无法确认。", {
                cause: error,
              }),
            ),
        );
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      try {
        await Promise.race([
          mediaPage.exposeBinding(binding, async (_source, payload) => {
            try {
              if (!payload || typeof payload !== "object")
                throw new Error("媒体流消息无效。");
              const message = payload as {
                kind: string;
                status?: number;
                contentType?: string;
                contentLength?: string | null;
                contentEncoding?: string | null;
                retryAfter?: string | null;
                finalUrl?: string;
                bytes?: number[];
              };
              if (message.kind === "response") {
                await onResponse({
                  status: message.status ?? 0,
                  contentType: message.contentType ?? "",
                  contentLength: message.contentLength ?? null,
                  contentEncoding: message.contentEncoding ?? null,
                  retryAfter: message.retryAfter,
                  finalUrl: message.finalUrl,
                });
              } else if (
                message.kind === "chunk" &&
                Array.isArray(message.bytes)
              ) {
                await onChunk(Uint8Array.from(message.bytes));
              } else throw new Error("媒体流消息无效。");
            } catch (error) {
              sinkError = error;
              throw error;
            }
          }),
          stopped,
        ]);
        if (signal.aborted) {
          await closeOwnedPage();
          throw new Error("媒体请求已停止。");
        }
        onRequestStart();
        await Promise.race([
          mediaPage.evaluate(
            async ({ url, binding }) => {
              const send = (globalThis as Record<string, unknown>)[binding] as (
                value: unknown,
              ) => Promise<void>;
              const response = await fetch(url, {
                credentials: "include",
                redirect: "follow",
              });
              await send({
                kind: "response",
                status: response.status,
                contentType: response.headers.get("content-type") ?? "",
                contentLength: response.headers.get("content-length"),
                contentEncoding: response.headers.get("content-encoding"),
                retryAfter: response.headers.get("retry-after"),
                finalUrl: response.url,
              });
              if (!response.body) throw new Error("媒体响应没有可读正文。");
              const reader = response.body.getReader();
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  await send({ kind: "chunk", bytes: Array.from(value) });
                }
              } finally {
                reader.releaseLock();
              }
            },
            { url: selection.key, binding },
          ),
          stopped,
        ]);
        if (signal.aborted) {
          await closeOwnedPage();
          throw new Error("媒体请求已停止。");
        }
        if (disconnected)
          throw new UnconfirmedStopError(
            "Chrome Extension 连接中断，无法确认媒体请求已停止。",
          );
      } catch (error) {
        if (error instanceof UnconfirmedStopError) throw error;
        try {
          await closeOwnedPage();
        } catch (closeError) {
          throw new UnconfirmedStopError("媒体请求停止无法确认。", {
            cause: closeError,
          });
        }
        if (sinkError) throw sinkError;
        if (signal.aborted) throw error;
        throw new RetryableMediaError("媒体请求中断或响应流失败。", {
          cause: error,
        });
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
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
    async getPostDetail(assetId, signal) {
      if (closed || disconnected)
        throw new Error("Chrome Extension 连接已断开。");
      if (signal.aborted) throw new Error("检查已停止。");
      if (!page || page.isClosed()) {
        page = await context.newPage();
        closingPage = undefined;
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
      let detailRequestStarted = false;
      let requestTimedOut = false;
      let preRequestTimedOut = false;
      let rejectDeadline!: (error: Error) => void;
      const deadline = new Promise<never>((_, reject) => {
        rejectDeadline = reject;
      });
      const routePostDetail = async (route: PageRouteLike) => {
        if (signal.aborted || requestTimedOut || preRequestTimedOut) {
          await route.abort();
          return;
        }
        if (isPostDetailResponse(route.request().url(), assetId)) {
          if (detailRequestStarted) {
            await route.abort();
            return;
          }
          detailRequestStarted = true;
          if (preRequestTimer) clearTimeout(preRequestTimer);
          preRequestTimer = undefined;
          onRequestStart();
          requestTimer = setTimeout(() => {
            requestTimedOut = true;
            const error = new Error("Post 详情请求超过 30 秒总期限。");
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
        const detailPattern = `**/rest/assets/${assetId}**`;
        await Promise.race([
          page.route(detailPattern, routePostDetail),
          stopped,
        ]);
        const preRequestDeadline = new Promise<never>((_, reject) => {
          preRequestTimer = setTimeout(() => {
            preRequestTimedOut = true;
            const error = new Error("Post 页面未在 30 秒内发起详情请求。");
            error.name = "TimeoutError";
            reject(error);
          }, API_TIMEOUT_MS);
        });
        const responsePromise = page.waitForResponse(
          (response) => isPostDetailResponse(response.url(), assetId),
          { timeout: 0 },
        );
        const postUrl = `https://grok.com/imagine/post/${assetId}`;
        const navigation = page
          .goto(postUrl, { waitUntil: "domcontentloaded", timeout: 0 })
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
          throw new AuthenticationBlockedError(response.status());
        if (disconnected)
          throw new UnconfirmedStopError(
            "Chrome Extension 连接中断，无法确认请求已停止。",
          );
        const parsed = parsePostDetailResponse(assetId, raw);
        if (
          parsed.kind === "temporary" ||
          parsed.kind === "blocked" ||
          authenticationRedirectPath(headers.location, response.url())
        ) {
          try {
            await closeOwnedPage();
          } catch (cleanupError) {
            throw new UnconfirmedStopError(
              "Post 详情请求停止无法确认，已禁止继续。",
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
              "登录阻挡后 Post 请求停止无法确认。",
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
              "Post 详情请求停止无法确认，已禁止重试。",
              { cause: cleanupError },
            );
          }
          throw new RetryableRequestError("Post 详情请求发生网络错误或超时。", {
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

function isPostDetailResponse(value: string, assetId: string): boolean {
  try {
    const url = new URL(value);
    return url.pathname === `/rest/assets/${assetId}`;
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
