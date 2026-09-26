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
};

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

  if (typeof key !== "string" || !isSupportedMediaUrl(key))
    return { kind: "unknown" };
  return {
    kind: "post",
    selection: { assetId: requestedId, mimeType: body.mimeType, quality },
  };
}

export function normalizePostId(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  return uuid.test(normalized) ? normalized : undefined;
}

function isSupportedMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      ["assets.grok.com", "videos.grok.com"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

export function isRetryableNetworkFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TypeError" || error.name === "TimeoutError";
}
