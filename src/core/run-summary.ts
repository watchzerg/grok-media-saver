export type RunSummary = {
  saved: number;
  archived: number;
  skipped: number;
  unconfirmed: number;
  unprocessed: number;
};

export function emptyRunSummary(unprocessed = 0): RunSummary {
  return { saved: 0, archived: 0, skipped: 0, unconfirmed: 0, unprocessed };
}

export function classifyPostResult(
  goal: "save" | "archive",
  result: {
    status: string;
    alreadySettled?: boolean;
    unprocessed?: boolean;
    archiveRecorded?: boolean | null;
    settledIntent?: boolean;
    fatalExecution?: boolean;
    cleanupErrors?: string[];
  },
): keyof RunSummary {
  if (result.unprocessed) return "unprocessed";
  if (result.alreadySettled) return "skipped";
  if (goal === "archive")
    return result.archiveRecorded === true ? "archived" : "unconfirmed";
  return result.status === "ok" ||
    (result.settledIntent &&
      (result.status === "cancelled" ||
        (result.fatalExecution && Boolean(result.cleanupErrors?.length))))
    ? "saved"
    : "unconfirmed";
}

export function formatRunSummary(summary: RunSummary): string {
  return `保存完成 ${summary.saved}，归档完成 ${summary.archived}，已结清跳过 ${summary.skipped}，未确认完成 ${summary.unconfirmed}，未处理 ${summary.unprocessed}`;
}
