import type { PostMediaSelection } from "../grok/adapter";
import type { Work } from "../store/save-work";

export type MediaHeaders = {
  status: number;
  contentType: string;
  contentLength: string | null;
  contentEncoding: string | null;
  retryAfter?: string | null;
  finalUrl?: string;
};

export type MediaSource = (
  selection: PostMediaSelection,
  onResponse: (headers: MediaHeaders) => Promise<void>,
  onChunk: (chunk: Uint8Array) => Promise<void>,
  signal: AbortSignal,
) => Promise<void>;

export class RetryableMediaError extends Error {}
export class BlockedMediaError extends Error {}
export class FatalMediaError extends Error {}
export class MediaCapabilityUnavailableError extends Error {}

export type DownloadIntent = {
  tempName: string;
  relativePath: string;
  publishBytes: string;
  sha256: string;
  mimeType: string;
};

export type ArchiveCheck =
  | { status: "ok" }
  | { status: "missing" }
  | { status: "directory" }
  | { status: "symlink" }
  | { status: "mismatch" }
  | { status: "failed"; reason: string };

export type FileCapabilities = {
  checkArchiveFile(
    relativePath: string,
    expectedBytes: number,
    expectedSha256: string,
  ): Promise<ArchiveCheck>;
  downloadToTemp(
    postId: string,
    selection: PostMediaSelection,
    source: MediaSource,
    signal: AbortSignal,
    onStage?: (stage: string) => void,
    timeouts?: { firstByte: number; noProgress: number; total: number },
  ): Promise<DownloadIntent>;
  discardDownloadedTemp(postId: string, intent: DownloadIntent): Promise<void>;
  publishIntent(
    postId: string,
    work: Work,
    signal: AbortSignal,
    onStage?: (stage: string) => void,
  ): Promise<"missing" | "published">;
  cleanupPublishedTemp(postId: string, work: Work): Promise<string | undefined>;
};
