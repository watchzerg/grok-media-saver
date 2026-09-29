export type SavedAsset = { assetId: string; mimeType: string };

export type PageResponse =
  | { kind: "page"; assets: SavedAsset[]; hasNextPage: boolean }
  | {
      kind: "blocked";
      status: number;
      reason?: "authentication";
      retryAfter?: string | null;
    }
  | { kind: "temporary"; status: number }
  | { kind: "unavailable"; status: number }
  | { kind: "unknown" };

export type PostMediaSelection = {
  assetId: string;
  mimeType: string;
  quality: "image" | "1080p" | "720p" | "original";
  key?: string;
  expectedBytes?: number;
};

// 部分原始 MP4 的 sizeBytes 实际记录了含前缀的 Base64 Data URL 长度。
// 仅解释详情元数据；响应完整性和绑定版本仍须按真实字节数核验。
export function matchesMediaDetailSize(
  selection: PostMediaSelection,
  byteCount: number,
): boolean {
  if (
    selection.expectedBytes === undefined ||
    selection.expectedBytes === byteCount
  )
    return true;
  if (
    selection.quality !== "original" ||
    selection.mimeType.toLowerCase() !== "video/mp4"
  )
    return false;
  const encodedLength = 4 * Math.ceil(byteCount / 3) + 22;
  return (
    Number.isSafeInteger(encodedLength) &&
    selection.expectedBytes === encodedLength
  );
}

export type PostResponse =
  | { kind: "post"; selection: PostMediaSelection }
  | Exclude<PageResponse, { kind: "page" }>;

export type RawPageResponse = {
  status: number;
  contentType: string;
  body: unknown;
  finalPath: string;
  retryAfter?: string | null;
};

export class RetryableRequestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RetryableRequestError";
  }
}

export class UnconfirmedStopError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UnconfirmedStopError";
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseSavedPageResponse(
  response: RawPageResponse,
): PageResponse {
  const authenticationPage =
    /\/(?:login|signin|challenge|tos-gate)(?:\/|$)/i.test(response.finalPath);
  if (
    response.status === 401 ||
    response.status === 429 ||
    authenticationPage
  ) {
    return {
      kind: "blocked",
      status: response.status,
      ...(response.status === 401 || authenticationPage
        ? { reason: "authentication" as const }
        : {}),
      retryAfter: response.retryAfter,
    };
  }
  if (response.status === 408 || response.status >= 500)
    return { kind: "temporary", status: response.status };
  if (
    response.status !== 200 ||
    !response.contentType.toLowerCase().includes("json") ||
    !response.body ||
    typeof response.body !== "object" ||
    Array.isArray(response.body)
  ) {
    return { kind: "unavailable", status: response.status };
  }

  const body = response.body as Record<string, unknown>;
  if (!Array.isArray(body.assets)) return { kind: "unknown" };
  const assets: SavedAsset[] = [];
  for (const value of body.assets) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return { kind: "unknown" };
    const item = value as Record<string, unknown>;
    const mimeType = item.mimeType ?? item.mediaType;
    if (
      typeof item.assetId !== "string" ||
      !uuid.test(item.assetId) ||
      typeof mimeType !== "string" ||
      !mimeType.includes("/")
    ) {
      return { kind: "unknown" };
    }
    assets.push({ assetId: item.assetId, mimeType });
  }
  return {
    kind: "page",
    assets,
    hasNextPage: Boolean(body.nextPageToken),
  };
}

export function parsePostDetailResponse(
  requestedId: string,
  response: RawPageResponse,
): PostResponse {
  const authenticationPage =
    /\/(?:login|signin|challenge|tos-gate)(?:\/|$)/i.test(response.finalPath);
  if (response.status === 401 || response.status === 429 || authenticationPage)
    return {
      kind: "blocked",
      status: response.status,
      ...(response.status === 401 || authenticationPage
        ? { reason: "authentication" as const }
        : {}),
      retryAfter: response.retryAfter,
    };
  if (response.status === 408 || response.status >= 500)
    return { kind: "temporary", status: response.status };
  if (
    response.status !== 200 ||
    !response.contentType.toLowerCase().includes("json") ||
    !response.body ||
    typeof response.body !== "object" ||
    Array.isArray(response.body)
  )
    return { kind: "unavailable", status: response.status };

  const body = response.body as Record<string, unknown>;
  if (
    typeof body.assetId !== "string" ||
    body.assetId.toLowerCase() !== requestedId ||
    typeof body.mimeType !== "string" ||
    !body.mimeType.includes("/") ||
    ["assets", "media", "mediaItems"].some((field) => field in body)
  )
    return { kind: "unknown" };

  let quality: PostMediaSelection["quality"];
  let key: unknown;
  const mediaType = body.mimeType.toLowerCase();
  if (mediaType.startsWith("image/")) {
    quality = "image";
    key = body.key;
  } else if (mediaType.startsWith("video/")) {
    if (Object.hasOwn(body, "hd1080Key")) {
      quality = "1080p";
      key = body.hd1080Key;
    } else if (Object.hasOwn(body, "hdKey")) {
      quality = "720p";
      key = body.hdKey;
    } else {
      quality = "original";
      key = body.key;
    }
  } else {
    return { kind: "unknown" };
  }

  const mediaUrl = typeof key === "string" ? normalizeMediaUrl(key) : undefined;
  if (!mediaUrl) return { kind: "unknown" };
  let expectedBytes: number | undefined;
  if (quality === "image" || quality === "original") {
    const rawBytes = body.sizeBytes;
    if (rawBytes !== undefined && rawBytes !== null) {
      const parsedBytes = Number(rawBytes);
      if (!Number.isSafeInteger(parsedBytes) || parsedBytes < 0)
        return { kind: "unknown" };
      expectedBytes = parsedBytes;
    }
  }
  return {
    kind: "post",
    selection: {
      assetId: requestedId,
      mimeType: body.mimeType,
      quality,
      key: mediaUrl,
      ...(expectedBytes === undefined ? {} : { expectedBytes }),
    },
  };
}

export function normalizePostId(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  return uuid.test(normalized) ? normalized : undefined;
}

function normalizeMediaUrl(value: string): string | undefined {
  if (!value.trim()) return undefined;
  try {
    const url = new URL(value, "https://assets.grok.com/");
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      ["assets.grok.com", "videos.grok.com"].includes(url.hostname)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function isRetryableNetworkFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TypeError" || error.name === "TimeoutError";
}

export type RawDeleteResponse = {
  status: number;
  contentType: string;
  body: unknown;
  finalUrl: string;
  method: string;
  redirected: boolean;
  retryAfter?: string | null;
};

export function postAssetUrl(postId: string): string {
  const id = normalizePostId(postId);
  if (!id) throw new Error("Post ID 必须是带连字符的 UUID。");
  return `https://grok.com/rest/assets/${id}`;
}

export type DeleteResponse =
  | { kind: "removed" }
  | { kind: "unknown" }
  | { kind: "blocked"; status: number; retryAfter?: string | null };
export function parseDeleteResponse(
  postId: string,
  response: RawDeleteResponse,
): DeleteResponse {
  if (
    response.status === 401 ||
    response.status === 429 ||
    /\/(?:login|signin|challenge|tos-gate)(?:\/|$)/i.test(response.finalUrl)
  )
    return {
      kind: "blocked",
      status: response.status,
      retryAfter: response.retryAfter,
    };
  if (
    response.method !== "DELETE" ||
    response.redirected ||
    response.finalUrl !== postAssetUrl(postId) ||
    response.status !== 200 ||
    response.contentType.split(";")[0]?.trim().toLowerCase() !==
      "application/json" ||
    response.body === null ||
    typeof response.body !== "object" ||
    Array.isArray(response.body) ||
    Object.keys(response.body).length !== 0
  )
    return { kind: "unknown" };
  return { kind: "removed" };
}

export type RawCheckResponse = RawDeleteResponse & {
  authenticationUnreliable?: boolean;
};
export type CheckResponse =
  | DeleteResponse
  | { kind: "present" }
  | { kind: "temporary"; status: number };

export function parseCheckResponse(
  postId: string,
  response: RawCheckResponse,
): CheckResponse {
  if (
    response.status === 401 ||
    response.status === 429 ||
    /\/(?:login|signin|challenge|tos-gate)(?:\/|$)/i.test(response.finalUrl)
  )
    return {
      kind: "blocked",
      status: response.status,
      retryAfter: response.retryAfter,
    };
  if (
    !response.authenticationUnreliable &&
    response.method === "GET" &&
    !response.redirected &&
    response.finalUrl === postAssetUrl(postId) &&
    (response.status === 408 ||
      (response.status >= 500 && response.status <= 599))
  )
    return { kind: "temporary", status: response.status };
  if (
    response.authenticationUnreliable ||
    response.method !== "GET" ||
    response.redirected ||
    response.finalUrl !== postAssetUrl(postId) ||
    response.contentType.split(";")[0]?.trim().toLowerCase() !==
      "application/json" ||
    !response.body ||
    typeof response.body !== "object" ||
    Array.isArray(response.body)
  )
    return { kind: "unknown" };
  const body = response.body as Record<string, unknown>;
  if (
    response.status === 404 &&
    body.code === 5 &&
    body.message === "Asset not found"
  )
    return { kind: "removed" };
  if (
    response.status === 200 &&
    body.assetId === postId &&
    body.isDeleted === false
  )
    return { kind: "present" };
  return { kind: "unknown" };
}
