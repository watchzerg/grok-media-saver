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
  settlePresentIntent: async (
    ...args: Parameters<typeof actual.settlePresentIntent>
  ) => {
    await actual.settlePresentIntent(...args);
    if (process.env.GMS_TEST_LOSE_ARCHIVE_RECEIPT === "present")
      throw new Error("模拟旧删除意图结清提交回执丢失");
  },
  confirmRemoval: async (...args: Parameters<typeof actual.confirmRemoval>) => {
    await actual.confirmRemoval(...args);
    if (process.env.GMS_TEST_LOSE_ARCHIVE_RECEIPT === "confirm")
      throw new Error("模拟移除确认提交回执丢失");
  },
  settleRecoveredArchive: async (
    ...args: Parameters<typeof actual.settleRecoveredArchive>
  ) => {
    await actual.settleRecoveredArchive(...args);
    if (process.env.GMS_TEST_LOSE_ARCHIVE_RECEIPT === "recovered")
      throw new Error("模拟恢复归档结清提交回执丢失");
  },
  settleArchive: async (...args: Parameters<typeof actual.settleArchive>) => {
    await actual.settleArchive(...args);
    if (process.env.GMS_TEST_LOSE_ARCHIVE_RECEIPT === "settle")
      throw new Error("模拟归档结清提交回执丢失");
  },
}));
