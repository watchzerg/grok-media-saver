import { mock } from "bun:test";

const actual = (await import(
  "../../src/store/save-work.ts?receipt-source" as string
)) as typeof import("../../src/store/save-work");

mock.module("../../src/store/save-work.ts", () => ({
  ...actual,
  settleIntent: async (...args: Parameters<typeof actual.settleIntent>) => {
    await actual.settleIntent(...args);
    throw new Error("模拟保存提交回执丢失");
  },
}));
