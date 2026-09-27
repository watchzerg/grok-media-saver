import { constants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { checkArchiveFile } from "./verify";

export class PublishConflictError extends Error {}

type PublishIntent = {
  mimeType: string | null;
  sha256: string | null;
  relativePath: string | null;
  tempName: string | null;
  publishBytes: string | null;
};

function code(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

function extension(mimeType: string | null): string | undefined {
  return (
    {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "video/mp4": "mp4",
      "video/webm": "webm",
    } as Record<string, string>
  )[mimeType?.toLowerCase() ?? ""];
}

function validIntent(postId: string, work: PublishIntent): boolean {
  const ext = extension(work.mimeType);
  return Boolean(
    ext &&
      work.sha256 &&
      /^[0-9a-f]{64}$/.test(work.sha256) &&
      work.relativePath === `${postId}/${work.sha256}.${ext}` &&
      work.tempName &&
      /^\.[a-zA-Z0-9_-]+\.part$/.test(work.tempName) &&
      work.publishBytes !== null &&
      Number.isSafeInteger(Number(work.publishBytes)) &&
      Number(work.publishBytes) >= 0,
  );
}

async function safePostDirectory(
  root: string,
  postId: string,
): Promise<string> {
  const rootPath = await realpath(root);
  const postPath = join(rootPath, postId);
  const details = await lstat(postPath);
  if (!details.isDirectory() || details.isSymbolicLink())
    throw new Error("Post 归档路径不是普通目录。");
  const actual = await realpath(postPath);
  if (actual !== postPath) throw new Error("Post 归档目录指向其他位置。");
  return postPath;
}

async function syncPublished(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function cleanupOwnedTemp(
  tempPath: string,
  expectedBytes: number,
  sha256: string,
  archiveRoot: string,
  relativePath: string,
): Promise<string | undefined> {
  const checked = await checkArchiveFile(
    archiveRoot,
    relativePath,
    expectedBytes,
    sha256,
  );
  if (checked.status !== "ok") return "正式文件核验已变化，保留临时名称。";
  const tempRelative = `${dirname(relativePath)}/${basename(tempPath)}`;
  const temp = await checkArchiveFile(
    archiveRoot,
    tempRelative,
    expectedBytes,
    sha256,
  );
  if (temp.status === "missing") return undefined;
  if (temp.status !== "ok")
    return `临时文件归属无法确认，已保留（${temp.status === "failed" ? temp.reason : temp.status}）。`;
  try {
    await unlink(tempPath);
    return undefined;
  } catch {
    return "已保存，但临时文件清理失败。";
  }
}

export async function publishIntent(
  archiveRoot: string,
  postId: string,
  work: PublishIntent,
  signal: AbortSignal,
  onStage?: (stage: string) => void,
): Promise<"missing" | "published"> {
  if (!validIntent(postId, work))
    throw new Error("发布意图格式或目标路径无效，现场已保留。");
  let postDirectory: string | undefined;
  try {
    postDirectory = await safePostDirectory(archiveRoot, postId);
  } catch (error) {
    if (code(error) !== "ENOENT") throw error;
  }
  const finalPath = postDirectory
    ? join(postDirectory, basename(work.relativePath as string))
    : undefined;
  const tempPath = postDirectory
    ? join(postDirectory, work.tempName as string)
    : undefined;
  const bytes = Number(work.publishBytes);
  let publicationStarted = false;
  let final = await checkArchiveFile(
    archiveRoot,
    work.relativePath as string,
    bytes,
    work.sha256 as string,
  );
  if (final.status === "missing") {
    const temp = await checkArchiveFile(
      archiveRoot,
      `${postId}/${work.tempName}`,
      bytes,
      work.sha256 as string,
    );
    if (temp.status === "missing") return "missing";
    if (temp.status !== "ok")
      throw new Error("临时文件与发布意图不符，现场已保留。");
    if (signal.aborted) throw new Error("保存已停止；发布意图已保留。");
    onStage?.("发布文件");
    publicationStarted = true;
    try {
      await link(tempPath as string, finalPath as string);
    } catch (error) {
      if (code(error) !== "EEXIST") throw error;
    }
    final = await checkArchiveFile(
      archiveRoot,
      work.relativePath as string,
      bytes,
      work.sha256 as string,
    );
    if (final.status !== "ok")
      throw new Error("正式文件发布后核验失败，发布意图已保留。");
    onStage?.("正式文件已发布");
  }
  if (final.status !== "ok")
    throw new PublishConflictError("正式文件与发布意图冲突，现场已保留。");
  if (signal.aborted && !publicationStarted)
    throw new Error("保存已停止；发布意图已保留。");
  onStage?.("同步正式文件");
  await syncPublished(finalPath as string);
  return "published";
}

export async function cleanupPublishedTemp(
  archiveRoot: string,
  postId: string,
  work: PublishIntent,
): Promise<string | undefined> {
  const postDirectory = await safePostDirectory(archiveRoot, postId);
  return cleanupOwnedTemp(
    join(postDirectory, work.tempName as string),
    Number(work.publishBytes),
    work.sha256 as string,
    archiveRoot,
    work.relativePath as string,
  );
}
