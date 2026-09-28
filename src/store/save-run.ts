import type { ReservedSQL } from "bun";
import type { RunSummary } from "../core/run-summary";

export async function interruptOrphanedRuns(
  session: ReservedSQL,
): Promise<void> {
  await session`UPDATE runs SET outcome = 'interrupted' WHERE finished_at IS NULL`;
}

export async function startSaveRun(
  session: ReservedSQL,
  runId: string,
  postId: string,
  goal: "save" | "archive" = "save",
): Promise<void> {
  await session`
    INSERT INTO runs (id, command, target_post_id, started_at)
    VALUES (${runId}::uuid, ${goal === "archive" ? "archive-post" : "save-post"}, ${postId}, now())
  `;
}

export async function finishSaveRun(
  session: ReservedSQL,
  runId: string,
  status: "ok" | "blocked" | "failed" | "cancelled",
  summary: RunSummary,
): Promise<void> {
  await session`
    UPDATE runs SET finished_at = now(),
      outcome = ${status === "ok" ? "succeeded" : status === "cancelled" ? "stopped" : "failed"},
      summary = ${summary}::jsonb
    WHERE id = ${runId}::uuid
  `;
}

export async function failSaveRun(
  session: ReservedSQL,
  runId: string,
  stopped: boolean,
  summary: RunSummary,
): Promise<void> {
  await session`
    UPDATE runs SET finished_at = now(), outcome = ${stopped ? "stopped" : "failed"}, summary = ${summary}::jsonb
    WHERE id = ${runId}::uuid AND finished_at IS NULL
  `;
}
