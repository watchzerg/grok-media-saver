import type { ReservedSQL } from "bun";
export class KnownSaveFailure extends Error {}
export class KnownSaveConflict extends KnownSaveFailure {}
export type Work = {
  goal: "save" | "archive";
  archiveSettled: boolean;
  status: string;
  selectedKey: string | null;
  quality: string | null;
  mimeType: string | null;
  expectedBytes: string | null;
  savedMediaVersionId: string | null;
  tempName: string | null;
  relativePath: string | null;
  publishBytes: string | null;
  sha256: string | null;
};

async function readWork(
  session: ReservedSQL,
  postId: string,
): Promise<Work | undefined> {
  const [work] = await session<Work[]>`
    SELECT goal, archive_settled AS "archiveSettled", status, selected_key AS "selectedKey", quality,
      mime_type AS "mimeType", expected_bytes::text AS "expectedBytes",
      saved_media_version_id::text AS "savedMediaVersionId",
      publish_temp_name AS "tempName",
      publish_relative_path AS "relativePath",
      publish_expected_bytes::text AS "publishBytes",
      publish_sha256 AS sha256
    FROM post_work WHERE post_id = ${postId}
  `;
  return work;
}

async function settleIntent(
  session: ReservedSQL,
  postId: string,
  work: Work,
  runId: string,
): Promise<void> {
  try {
    await session.begin(async (tx) => {
      const [version] = await tx<
        {
          id: string;
          byteCount: string;
          mimeType: string;
          relativePath: string;
        }[]
      >`
      SELECT id::text AS id, byte_count::text AS "byteCount",
        mime_type AS "mimeType", relative_path AS "relativePath"
      FROM media_versions WHERE post_id = ${postId} AND sha256 = ${work.sha256}
    `;
      if (
        version &&
        (version.byteCount !== work.publishBytes ||
          version.mimeType !== work.mimeType ||
          version.relativePath !== work.relativePath)
      )
        throw new KnownSaveConflict("既有媒体版本与发布意图冲突。");
      const versionId = version?.id ?? crypto.randomUUID();
      if (!version)
        await tx`
        INSERT INTO media_versions
          (id, post_id, sha256, byte_count, mime_type, relative_path, saved_at)
        VALUES (${versionId}::uuid, ${postId}, ${work.sha256},
          ${work.publishBytes}::bigint, ${work.mimeType}, ${work.relativePath}, now())
      `;
      const updated = await tx<{ post_id: string }[]>`
      UPDATE post_work SET status = 'saved', last_run_id = ${runId}::uuid,
        saved_media_version_id = ${versionId}::uuid,
        publish_temp_name = NULL, publish_relative_path = NULL,
        publish_expected_bytes = NULL, publish_sha256 = NULL, last_error = NULL
      WHERE post_id = ${postId} AND status = 'finalizing'
        AND publish_sha256 = ${work.sha256}
      RETURNING post_id
    `;
      if (updated.length !== 1)
        throw new KnownSaveFailure("发布意图在保存事务前发生变化。");
    });
  } catch (error) {
    if (error instanceof KnownSaveFailure) throw error;
    const sqlState =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    if (sqlState === "ERR_POSTGRES_SERVER_ERROR")
      throw new KnownSaveFailure(
        error instanceof Error ? error.message : String(error),
      );
    throw error;
  }
}

export { readWork, settleIntent };

export async function startWork(
  session: ReservedSQL,
  postId: string,
  runId: string,
): Promise<void> {
  await session`
    INSERT INTO post_work (post_id, goal, status, last_run_id)
    VALUES (${postId}, 'save', 'pending', ${runId}::uuid)
  `;
}

export async function clearMissingIntent(
  session: ReservedSQL,
  postId: string,
  work: Work,
  runId: string,
): Promise<void> {
  const cleared = await session<{ post_id: string }[]>`
    UPDATE post_work SET status = 'pending', last_run_id = ${runId}::uuid,
      publish_temp_name = NULL, publish_relative_path = NULL,
      publish_expected_bytes = NULL, publish_sha256 = NULL
    WHERE post_id = ${postId} AND status = 'finalizing'
      AND publish_sha256 = ${work.sha256}
    RETURNING post_id
  `;
  if (cleared.length !== 1) throw new Error("待核对发布意图在清除前发生变化。");
}

export async function failUnreadableDetail(
  session: ReservedSQL,
  postId: string,
  runId: string,
): Promise<void> {
  await session`
    UPDATE post_work SET status = 'failed', last_run_id = ${runId}::uuid,
      last_error = '当前 Post 详情不可读取'
    WHERE post_id = ${postId}
  `;
}

export async function readSavedVersion(
  session: ReservedSQL,
  postId: string,
  versionId: string,
) {
  const [version] = await session<
    { relativePath: string; byteCount: string; sha256: string }[]
  >`
    SELECT relative_path AS "relativePath", byte_count::text AS "byteCount", sha256
    FROM media_versions WHERE id = ${versionId}::uuid AND post_id = ${postId}
  `;
  return version;
}

export async function recordReusedVersion(
  session: ReservedSQL,
  postId: string,
  runId: string,
  versionId: string,
): Promise<void> {
  const updated = await session<{ post_id: string }[]>`
    UPDATE post_work SET last_run_id = ${runId}::uuid, last_error = NULL
    WHERE post_id = ${postId} AND status = 'saved'
      AND saved_media_version_id = ${versionId}::uuid
    RETURNING post_id
  `;
  if (updated.length !== 1)
    throw new KnownSaveFailure("Post 工作在复用前发生变化。");
}

export async function markFileNotReusable(
  session: ReservedSQL,
  postId: string,
  runId: string,
): Promise<void> {
  await session`
    UPDATE post_work SET status = 'pending', last_run_id = ${runId}::uuid,
      last_error = '当前保存文件无法复用'
    WHERE post_id = ${postId}
  `;
}

export async function markNeedsDownload(
  session: ReservedSQL,
  postId: string,
  runId: string,
  selection: { key?: string; quality: string; mimeType: string },
): Promise<void> {
  await session`
    UPDATE post_work SET status = 'pending', last_run_id = ${runId}::uuid,
      selected_key = ${selection.key ?? null},
      quality = ${selection.quality}, mime_type = ${selection.mimeType},
      expected_bytes = ${"expectedBytes" in selection ? (selection.expectedBytes ?? null) : null},
      last_error = '需要下载当前来源'
    WHERE post_id = ${postId}
  `;
}

export async function recordPublishIntent(
  session: ReservedSQL,
  postId: string,
  runId: string,
  selection: {
    key?: string;
    quality: string;
    mimeType: string;
    expectedBytes?: number;
  },
  intent: {
    tempName: string;
    relativePath: string;
    publishBytes: string;
    sha256: string;
    mimeType: string;
  },
): Promise<void> {
  const updated = await session<{ post_id: string }[]>`
    UPDATE post_work SET status = 'finalizing', last_run_id = ${runId}::uuid,
      selected_key = ${selection.key ?? null}, quality = ${selection.quality},
      mime_type = ${intent.mimeType}, expected_bytes = ${selection.expectedBytes ?? null},
      publish_temp_name = ${intent.tempName}, publish_relative_path = ${intent.relativePath},
      publish_expected_bytes = ${intent.publishBytes}::bigint, publish_sha256 = ${intent.sha256},
      last_error = NULL
    WHERE post_id = ${postId} AND status IN ('pending', 'failed')
      AND publish_sha256 IS NULL
    RETURNING post_id
  `;
  if (updated.length !== 1)
    throw new KnownSaveFailure("Post 工作在发布意图前发生变化。");
}

export async function failDownload(
  session: ReservedSQL,
  postId: string,
  runId: string,
  reason: string,
): Promise<void> {
  await session`
    UPDATE post_work SET status = 'failed', last_run_id = ${runId}::uuid,
      last_error = ${reason}
    WHERE post_id = ${postId} AND status = 'pending' AND publish_sha256 IS NULL
  `;
}
