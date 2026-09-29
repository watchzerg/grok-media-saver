import type { BrowserSession } from "../../src/browser/session";
import {
  type PageResponse,
  parsePostDetailResponse,
  RetryableRequestError,
} from "../../src/grok/adapter";

export const fixtureMedia = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
  "hex",
);

// Target existence and visible pages are deliberately independent.
export function statefulArchiveBrowser(pages: PageResponse[]) {
  const removed = new Set<string>();
  const requests: { kind: string; postId?: string; at: number }[] = [];
  let pageIndex = 0;
  let connected = true;
  let connections = 0;
  let closes = 0;
  const unavailable = new Set<string>();
  const blocked = new Set<string>();
  const lostDeleteReceipt = new Set<string>();
  const record = (kind: string, postId?: string) =>
    requests.push({ kind, postId, at: Date.now() });
  const fixture = {
    removed,
    requests,
    unavailable,
    blocked,
    lostDeleteReceipt,
    get connections() {
      return connections;
    },
    get closes() {
      return closes;
    },
    disconnect() {
      connected = false;
    },
    closePageError: false,
    closeError: false,
    onRequest: undefined as
      | ((kind: string, postId?: string) => Promise<void> | void)
      | undefined,
    async connect(
      _signal: AbortSignal,
      requestStarted: () => void,
    ): Promise<BrowserSession> {
      connections += 1;
      const request = async (kind: string, postId?: string) => {
        requestStarted();
        record(kind, postId);
        await fixture.onRequest?.(kind, postId);
      };
      return {
        getFirstPage: async () => {
          await request("page");
          return (
            pages[pageIndex++] ?? {
              kind: "page",
              assets: [],
              hasNextPage: false,
            }
          );
        },
        getPostDetail: async (id) => {
          await request("detail", id);
          if (blocked.has(id)) return { kind: "blocked", status: 429 };
          if (unavailable.has(id) || removed.has(id))
            return { kind: "unavailable", status: 404 };
          return parsePostDetailResponse(id, {
            status: 200,
            contentType: "application/json",
            finalPath: `/rest/assets/${id}`,
            body: {
              assetId: id,
              key: `https://assets.grok.com/${id}.png`,
              mimeType: "image/png",
            },
          });
        },
        prepareMediaPage: async () => {},
        downloadMedia: async (selection, onResponse, onChunk) => {
          await request("media", selection.assetId);
          await onResponse({
            status: 200,
            contentType: "image/png",
            contentLength: String(fixtureMedia.length),
            contentEncoding: null,
          });
          await onChunk(fixtureMedia);
        },
        deletePost: async (id) => {
          await request("delete", id);
          removed.add(id);
          if (lostDeleteReceipt.has(id))
            throw new RetryableRequestError("fixture lost DELETE receipt");
          return {
            status: 200,
            contentType: "application/json",
            finalUrl: `https://grok.com/rest/assets/${id}`,
            method: "DELETE",
            redirected: false,
            body: {},
          };
        },
        checkPost: async (id, _signal, beforeRequest) => {
          await beforeRequest();
          await request("check", id);
          return {
            status: removed.has(id) ? 404 : 200,
            contentType: "application/json",
            finalUrl: `https://grok.com/rest/assets/${id}`,
            method: "GET",
            redirected: false,
            body: removed.has(id)
              ? { code: 5, message: "Asset not found" }
              : { assetId: id, isDeleted: false },
          };
        },
        isConnected: () => connected,
        closePage: async () => {
          record("close-page");
          if (fixture.closePageError)
            throw new Error("fixture page cleanup failed");
        },
        close: async () => {
          closes += 1;
          connected = false;
          if (fixture.closeError)
            throw new Error("fixture final cleanup failed");
        },
        cleanupNotices: [],
        cleanupBounded: true,
      };
    },
  };
  return fixture;
}
