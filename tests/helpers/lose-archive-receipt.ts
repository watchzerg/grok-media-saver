import { mock } from "bun:test";

const actual = (await import(
  "../../src/store/archive-work.ts?receipt-source" as string
)) as typeof import("../../src/store/archive-work");
mock.module("../../src/store/archive-work.ts", () => ({
  ...actual,
  recordDeletionIntent: async (
    ...args: Parameters<typeof actual.recordDeletionIntent>
  ) => {
    await actual.recordDeletionIntent(...args);
    if (process.env.GMS_TEST_LOSE_ARCHIVE_RECEIPT === "intent")
      throw new Error("模拟删除意图提交回执丢失");
  },
  settleArchive: async (...args: Parameters<typeof actual.settleArchive>) => {
    await actual.settleArchive(...args);
    if (process.env.GMS_TEST_LOSE_ARCHIVE_RECEIPT === "settle")
      throw new Error("模拟归档结清提交回执丢失");
  },
}));
