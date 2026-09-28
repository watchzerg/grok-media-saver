import { mock } from "bun:test";

const saves = (await import(
  "../../src/store/save-work.ts?bound-source" as string
)) as typeof import("../../src/store/save-work");
const archives = (await import(
  "../../src/store/archive-work.ts?bound-source" as string
)) as typeof import("../../src/store/archive-work");
mock.module("../../src/store/save-work.ts", () => ({
  ...saves,
  recordPublishIntent: async (
    ...args: Parameters<typeof saves.recordPublishIntent>
  ) => {
    await saves.recordPublishIntent(...args);
    if (process.env.GMS_TEST_LOSE_BOUND_RECEIPT === "发布意图")
      throw new Error("模拟绑定发布意图回执丢失");
  },
  settleIntent: async (...args: Parameters<typeof saves.settleIntent>) => {
    await saves.settleIntent(...args);
    if (process.env.GMS_TEST_LOSE_BOUND_RECEIPT === "保存结果")
      throw new Error("模拟绑定保存结果回执丢失");
  },
}));
mock.module("../../src/store/archive-work.ts", () => ({
  ...archives,
  settleRecoveredArchive: async (
    ...args: Parameters<typeof archives.settleRecoveredArchive>
  ) => {
    await archives.settleRecoveredArchive(...args);
    if (process.env.GMS_TEST_LOSE_BOUND_RECEIPT === "结清")
      throw new Error("模拟绑定结清回执丢失");
  },
}));
