import type { SQL } from "bun";

export async function seedSettledArchive(sql: SQL, postId: string) {
  const versionId = crypto.randomUUID();
  const digest = "0".repeat(64);
  await sql.begin(async (tx) => {
    await tx`INSERT INTO media_versions (id, post_id, sha256, byte_count, mime_type, relative_path, saved_at)
      VALUES (${versionId}::uuid, ${postId}, ${digest}, 1, 'image/png', ${`${postId}/${digest}.png`}, now())`;
    await tx`UPDATE post_work SET goal = 'archive', status = 'saved', removal_state = 'removed',
      saved_media_version_id = ${versionId}::uuid, deletion_media_version_id = ${versionId}::uuid,
      archive_settled = true, publish_temp_name = NULL, publish_relative_path = NULL,
      publish_expected_bytes = NULL, publish_sha256 = NULL WHERE post_id = ${postId}`;
  });
}
