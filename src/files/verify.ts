import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type ArchiveCheck =
  | { status: "ok" }
  | { status: "missing" }
  | { status: "directory" }
  | { status: "symlink" }
  | { status: "mismatch" }
  | { status: "failed"; reason: string };

export async function checkArchiveFile(
  archiveRoot: string,
  relativePath: string,
  expectedBytes: number,
  expectedSha256: string,
): Promise<ArchiveCheck> {
  if (isAbsolute(relativePath))
    return { status: "failed", reason: "保存路径不是相对路径。" };
  const root = resolve(archiveRoot);
  const target = resolve(root, relativePath);
  const relativeTarget = relative(root, target);
  if (
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget)
  )
    return { status: "failed", reason: "保存路径超出当前归档目录。" };

  let rootRealPath: string;
  try {
    rootRealPath = await realpath(root);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { status: "missing" };
    return { status: "failed", reason: "无法访问当前归档路径。" };
  }
  let targetRealPath: string;
  try {
    targetRealPath = await realpath(target);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { status: "missing" };
    return { status: "failed", reason: "无法访问归档文件。" };
  }
  const physicalRelative = relative(rootRealPath, targetRealPath);
  if (
    physicalRelative === ".." ||
    physicalRelative.startsWith(`..${sep}`) ||
    isAbsolute(physicalRelative)
  )
    return { status: "failed", reason: "保存路径超出当前归档目录。" };

  let details: Awaited<ReturnType<typeof lstat>>;
  try {
    details = await lstat(target);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { status: "missing" };
    return { status: "failed", reason: "无法访问归档文件。" };
  }
  if (details.isSymbolicLink()) return { status: "symlink" };
  if (details.isDirectory()) return { status: "directory" };
  if (!details.isFile())
    return { status: "failed", reason: "归档路径不是普通文件。" };

  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { status: "missing" };
    if (errorCode(error) === "ELOOP") return { status: "symlink" };
    return { status: "failed", reason: "无法读取归档文件。" };
  }
  try {
    const opened = await file.stat();
    if (!opened.isFile()) return { status: "directory" };
    if (opened.size !== expectedBytes) return { status: "mismatch" };
    const hash = createHash("sha256");
    let byteCount = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      byteCount += chunk.length;
    }
    return byteCount === expectedBytes && hash.digest("hex") === expectedSha256
      ? { status: "ok" }
      : { status: "mismatch" };
  } catch {
    return { status: "failed", reason: "读取归档文件失败。" };
  } finally {
    await file.close().catch(() => undefined);
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}
