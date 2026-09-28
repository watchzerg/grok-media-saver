import type { ReservedSQL } from "bun";
import { KnownSaveFailure } from "./save-work";

export async function promoteArchiveWork(
  session: ReservedSQL,
  postId: string,
  runId: string,
): Promise<void> {
  await session.begin(async (tx) => {
    await tx`INSERT INTO post_work (post_id, goal, status, last_run_id)
      VALUES (${postId}, 'archive', 'pending', ${runId}::uuid)
      ON CONFLICT (post_id) DO UPDATE SET goal = 'archive'`;
  });
}

export async function recordDeletionIntent(
  session: ReservedSQL,
  postId: string,
  versionId: string,
  runId: string,
): Promise<void> {
  await session.begin(async (tx) => {
    const changed = await tx`UPDATE post_work SET removal_state = 'pending',
      deletion_media_version_id = ${versionId}::uuid, last_run_id = ${runId}::uuid, last_error = NULL
      WHERE post_id = ${postId} AND goal = 'archive' AND status = 'saved'
        AND NOT archive_settled AND removal_state = 'none' AND publish_sha256 IS NULL
        AND saved_media_version_id = ${versionId}::uuid
        AND EXISTS (SELECT 1 FROM media_versions WHERE post_id = ${postId} AND id = ${versionId}::uuid)
      RETURNING post_id`;
    if (changed.length !== 1)
      throw new KnownSaveFailure(
        "删除意图提交前的精确版本或保存状态发生变化。",
      );
  });
}

export async function settleArchive(
  session: ReservedSQL,
  postId: string,
  versionId: string,
  runId: string,
): Promise<void> {
  await session.begin(async (tx) => {
    const changed =
      await tx`UPDATE post_work SET removal_state = 'removed', archive_settled = true,
      last_run_id = ${runId}::uuid, last_error = NULL
      WHERE post_id = ${postId} AND goal = 'archive' AND status = 'saved'
        AND removal_state = 'pending' AND NOT archive_settled
        AND deletion_media_version_id = ${versionId}::uuid AND publish_sha256 IS NULL
      RETURNING post_id`;
    if (changed.length !== 1)
      throw new KnownSaveFailure("归档结清前的删除意图或绑定发生变化。");
  });
}

export async function confirmRemoval(
  session: ReservedSQL,
  postId: string,
  versionId: string,
  runId: string,
): Promise<void> {
  await session.begin(async (tx) => {
    const changed =
      await tx`UPDATE post_work SET removal_state = 'removed', last_run_id = ${runId}::uuid, last_error = NULL
      WHERE post_id = ${postId} AND goal = 'archive' AND removal_state = 'pending'
        AND NOT archive_settled AND deletion_media_version_id = ${versionId}::uuid
        AND EXISTS (SELECT 1 FROM media_versions WHERE post_id = ${postId} AND id = ${versionId}::uuid)
      RETURNING post_id`;
    if (changed.length !== 1)
      throw new KnownSaveFailure("移除确认前的删除意图或绑定发生变化。");
  });
}

export async function settleRecoveredArchive(
  session: ReservedSQL,
  postId: string,
  versionId: string,
  runId: string,
): Promise<void> {
  await session.begin(async (tx) => {
    const changed =
      await tx`UPDATE post_work SET archive_settled = true, last_run_id = ${runId}::uuid, last_error = NULL
      WHERE post_id = ${postId} AND goal = 'archive' AND status = 'saved' AND removal_state = 'removed'
        AND NOT archive_settled AND deletion_media_version_id = ${versionId}::uuid
        AND saved_media_version_id = ${versionId}::uuid AND publish_sha256 IS NULL
        AND EXISTS (SELECT 1 FROM media_versions WHERE post_id = ${postId} AND id = ${versionId}::uuid)
      RETURNING post_id`;
    if (changed.length !== 1)
      throw new KnownSaveFailure("恢复归档结清前的移除事实或绑定发生变化。");
  });
}
