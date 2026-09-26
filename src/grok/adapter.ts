export type SavedAsset = { assetId: string; mimeType: string };

export type PageResponse =
  | { kind: "page"; assets: SavedAsset[]; hasNextPage: boolean }
  | { kind: "blocked"; status: number; retryAfter?: string | null }
  | { kind: "temporary"; status: number }
  | { kind: "unavailable"; status: number }
  | { kind: "unknown" };

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
  if (
    response.status === 401 ||
    response.status === 429 ||
    /\/(?:login|signin|challenge)(?:\/|$)/i.test(response.finalPath)
  ) {
    return {
      kind: "blocked",
      status: response.status,
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

export function isRetryableNetworkFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TypeError" || error.name === "TimeoutError";
}
