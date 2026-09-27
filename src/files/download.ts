import { constants, createReadStream } from "node:fs";
import { mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { PostMediaSelection } from "../grok/adapter";
import { UnconfirmedStopError } from "../grok/adapter";
import { checkArchiveFile } from "./verify";

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

const formats: Record<
  string,
  { ext: string; signature: (bytes: Uint8Array) => boolean }
> = {
  "image/png": {
    ext: "png",
    signature: (b) =>
      b.length >= 8 &&
      Buffer.from(b.subarray(0, 8)).equals(
        Buffer.from("89504e470d0a1a0a", "hex"),
      ),
  },
  "image/jpeg": {
    ext: "jpg",
    signature: (b) =>
      b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  "image/webp": {
    ext: "webp",
    signature: (b) =>
      b.length >= 12 &&
      Buffer.from(b.subarray(0, 4)).toString() === "RIFF" &&
      Buffer.from(b.subarray(8, 12)).toString() === "WEBP",
  },
  "video/mp4": {
    ext: "mp4",
    signature: (b) =>
      b.length >= 12 && Buffer.from(b.subarray(4, 8)).toString() === "ftyp",
  },
  "video/webm": {
    ext: "webm",
    signature: (b) =>
      b.length >= 4 &&
      Buffer.from(b.subarray(0, 4)).equals(Buffer.from("1a45dfa3", "hex")),
  },
};

export async function downloadToTemp(
  root: string,
  postId: string,
  selection: PostMediaSelection,
  source: MediaSource,
  signal: AbortSignal,
  onStage?: (stage: string) => void,
  timeouts: { firstByte: number; noProgress: number; total: number } = {
    firstByte: 30_000,
    noProgress: 30_000,
    total: 900_000,
  },
) {
  const format = formats[selection.mimeType.toLowerCase()];
  if (!format || !selection.key)
    throw new Error("所选媒体类型或地址不受支持。");
  const rootPath = await realpath(root);
  const directory = join(rootPath, postId);
  await mkdir(directory, { recursive: true });
  if (
    !(await stat(directory)).isDirectory() ||
    (await realpath(directory)) !== directory
  )
    throw new FatalMediaError("Post 归档目录无效。");
  const tempName = `.${crypto.randomUUID()}.part`;
  const path = join(directory, tempName);
  const file = await open(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  let intentCreated = false;
  let closed = false;
  let count = 0;
  let expected = 0;
  let firstBytes = Buffer.alloc(0);
  let sawHeaders = false;
  let sawChunk = false;
  let timeoutReason: string | undefined;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) controller.abort();
  const timeout = (reason: string) => {
    timeoutReason = reason;
    controller.abort();
  };
  let firstTimer: ReturnType<typeof setTimeout> | undefined;
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  const totalTimer = setTimeout(
    () => timeout("媒体请求超过总时长限制。"),
    timeouts.total,
  );
  const resetProgress = () => {
    if (progressTimer) clearTimeout(progressTimer);
    progressTimer = setTimeout(
      () => timeout("媒体写入 30 秒没有进展。"),
      timeouts.noProgress,
    );
  };
  try {
    onStage?.("等待媒体首字节");
    firstTimer = setTimeout(
      () => timeout("媒体首字节超时。"),
      timeouts.firstByte,
    );
    await source(
      selection,
      async (headers) => {
        if (sawHeaders) throw new FatalMediaError("媒体响应头重复。");
        sawHeaders = true;
        if (
          headers.status === 429 ||
          headers.status === 401 ||
          /\/(?:login|signin|challenge|tos-gate)(?:\/|$)/i.test(
            headers.finalUrl ?? "",
          )
        ) {
          const wait = safeRetryAfter(headers.retryAfter);
          throw new BlockedMediaError(
            `媒体请求被阻挡（HTTP ${headers.status}${wait ? `；建议等待 ${wait}` : ""}）。`,
          );
        }
        if (headers.status === 408 || headers.status >= 500)
          throw new RetryableMediaError(
            `媒体请求暂时失败（HTTP ${headers.status}）。`,
          );
        if (headers.status !== 200)
          throw new Error(`媒体请求失败（HTTP ${headers.status}）。`);
        const type = headers.contentType.split(";", 1)[0]?.trim().toLowerCase();
        const safeType = (value: string | undefined) =>
          value && /^[a-z0-9.+-]{1,40}\/[a-z0-9.+-]{1,40}$/.test(value)
            ? value
            : "不可识别";
        onStage?.(
          `媒体响应摘要：HTTP ${headers.status}，所选 ${safeType(selection.mimeType.toLowerCase())}，实际 ${safeType(type)}，Content-Length ${headers.contentLength && /^\d{1,18}$/.test(headers.contentLength) ? headers.contentLength : "缺失或无效"}，Content-Encoding ${headers.contentEncoding ? "存在" : "未报告"}`,
        );
        if (type !== selection.mimeType.toLowerCase())
          throw new RetryableMediaError("媒体响应类型与所选媒体不符。");
        if (
          headers.contentEncoding &&
          headers.contentEncoding.toLowerCase() !== "identity"
        )
          throw new RetryableMediaError("媒体内容编码使响应长度不可直接核对。");
        if (!headers.contentLength || !/^[1-9]\d*$/.test(headers.contentLength))
          throw new RetryableMediaError("媒体响应缺少可信 Content-Length。");
        expected = Number(headers.contentLength);
        if (!Number.isSafeInteger(expected))
          throw new RetryableMediaError("媒体响应长度无效。");
        if (
          selection.expectedBytes !== undefined &&
          expected !== selection.expectedBytes
        )
          throw new RetryableMediaError("媒体响应长度与详情元数据冲突。");
        onStage?.(
          `媒体响应：HTTP 200，${safeType(type)}，Content-Length ${expected} 字节`,
        );
      },
      async (chunk) => {
        if (!sawHeaders) throw new FatalMediaError("媒体正文先于响应头。");
        if (controller.signal.aborted) throw new Error("媒体传输已停止。");
        if (chunk.length === 0) return;
        if (!sawChunk) {
          sawChunk = true;
          if (firstTimer) clearTimeout(firstTimer);
          onStage?.("写入媒体");
        }
        if (count + chunk.length > expected)
          throw new RetryableMediaError("媒体响应超过 Content-Length。");
        if (firstBytes.length < 16)
          firstBytes = Buffer.concat([
            firstBytes,
            Buffer.from(chunk.subarray(0, 16 - firstBytes.length)),
          ]);
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await file.write(
            chunk,
            offset,
            chunk.length - offset,
          );
          if (bytesWritten <= 0)
            throw new FatalMediaError("媒体文件发生短写。");
          offset += bytesWritten;
          count += bytesWritten;
          resetProgress();
        }
      },
      controller.signal,
    );
    if (controller.signal.aborted)
      throw new Error(timeoutReason ?? "媒体传输已停止。");
    if (!sawHeaders || !sawChunk || count !== expected)
      throw new RetryableMediaError("媒体响应未正常完整结束或长度不符。");
    onStage?.(`媒体响应流 EOF；实写 ${count} 字节`);
    if (!format.signature(firstBytes))
      throw new RetryableMediaError("媒体文件头与所选类型不符。");
    await file.sync();
    await file.close();
    closed = true;
    const hasher = new Bun.CryptoHasher("sha256");
    for await (const chunk of createReadStream(path)) hasher.update(chunk);
    const sha256 = hasher.digest("hex");
    const checked = await checkArchiveFile(
      root,
      `${postId}/${tempName}`,
      count,
      sha256,
    );
    if (checked.status !== "ok")
      throw new FatalMediaError("临时文件落盘核验失败。");
    onStage?.(`媒体临时文件重读核验通过：${count} 字节，SHA-256 ${sha256}`);
    intentCreated = true;
    return {
      tempName,
      relativePath: `${postId}/${sha256}.${format.ext}`,
      publishBytes: String(count),
      sha256,
      mimeType: selection.mimeType,
    };
  } catch (error) {
    if (
      timeoutReason &&
      !signal.aborted &&
      !(error instanceof FatalMediaError) &&
      !(error instanceof UnconfirmedStopError)
    )
      throw new RetryableMediaError(timeoutReason, { cause: error });
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    clearTimeout(totalTimer);
    if (firstTimer) clearTimeout(firstTimer);
    if (progressTimer) clearTimeout(progressTimer);
    if (!closed) await file.close().catch(() => undefined);
    if (!intentCreated)
      await unlink(path).catch((error) => {
        throw new FatalMediaError("未能清理本次下载残片。", { cause: error });
      });
  }
}

export async function discardDownloadedTemp(
  root: string,
  postId: string,
  intent: { tempName: string; publishBytes: string; sha256: string },
): Promise<void> {
  if (!/^\.[a-zA-Z0-9_-]+\.part$/.test(intent.tempName))
    throw new FatalMediaError("本次临时文件名无效，未清理。");
  const relativePath = `${postId}/${intent.tempName}`;
  const checked = await checkArchiveFile(
    root,
    relativePath,
    Number(intent.publishBytes),
    intent.sha256,
  );
  if (checked.status !== "ok")
    throw new FatalMediaError("本次临时文件归属无法确认，已保留。");
  await unlink(join(await realpath(root), relativePath));
}

function safeRetryAfter(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (/^\d{1,8}$/.test(value)) return `${value} 秒`;
  const when = Date.parse(value);
  return Number.isFinite(when) && /^[A-Za-z0-9, :+-]{10,60}$/.test(value)
    ? new Date(when).toUTCString()
    : undefined;
}
