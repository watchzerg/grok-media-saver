import { mock } from "bun:test";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import type { PageResponse } from "../../src/grok/adapter";
import { statefulArchiveBrowser } from "./stateful-archive-browser";

// Only the browser capability is replaced. Target facts survive CLI restarts;
// visible pages remain independent so stale listings cannot prove removal.
mock.module("../../src/browser/session.ts", () => ({
  connectBrowserSession: async (_token: string, requestStarted: () => void) => {
    const pages: PageResponse[] = JSON.parse(
      process.env.GMS_TEST_BATCH_PAGES ?? "[]",
    );
    const fake = statefulArchiveBrowser(pages);
    const facts = process.env.GMS_TEST_REMOTE_FACTS;
    if (facts && existsSync(facts))
      for (const id of JSON.parse(readFileSync(facts, "utf8")))
        fake.removed.add(id);
    for (const id of (process.env.GMS_TEST_BATCH_UNAVAILABLE ?? "").split(","))
      fake.unavailable.add(id);
    for (const id of (process.env.GMS_TEST_BATCH_BLOCKED ?? "").split(","))
      fake.blocked.add(id);
    fake.closeError = process.env.GMS_TEST_FINAL_CLOSE_FAILURE === "1";
    const record = (kind: string, postId?: string) => {
      if (process.env.GMS_TEST_REQUEST_EVENTS)
        appendFileSync(
          process.env.GMS_TEST_REQUEST_EVENTS,
          `${JSON.stringify({ kind, postId, at: Date.now() })}\n`,
        );
    };
    record("connect");
    fake.onRequest = record;
    const browser = await fake.connect(
      new AbortController().signal,
      requestStarted,
    );
    const deletePost = browser.deletePost;
    return {
      ...browser,
      deletePost: async (
        ...args: Parameters<NonNullable<typeof deletePost>>
      ) => {
        if (!deletePost) throw new Error("Missing fixture DELETE capability");
        const response = await deletePost(...args);
        if (facts) writeFileSync(facts, JSON.stringify([...fake.removed]));
        if (process.env.GMS_TEST_DELETE_MARKER)
          writeFileSync(process.env.GMS_TEST_DELETE_MARKER, "removed");
        if (process.env.GMS_TEST_PAUSE_DELETE === "1")
          process.kill(process.pid, "SIGSTOP");
        if (process.env.GMS_TEST_DELETE_DELAY_MS)
          await new Promise<void>((resolve) => {
            const signal = args[1];
            const finish = () => {
              clearTimeout(timer);
              signal.removeEventListener("abort", finish);
              resolve();
            };
            const timer = setTimeout(
              finish,
              Number(process.env.GMS_TEST_DELETE_DELAY_MS),
            );
            signal.addEventListener("abort", finish, { once: true });
          });
        return response;
      },
      close: async () => {
        record("close");
        await browser.close();
      },
    };
  },
}));
