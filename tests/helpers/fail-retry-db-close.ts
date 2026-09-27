import { mock } from "bun:test";
import { connectDatabase, safeDatabaseError } from "../../src/store/database";

const originalConnectDatabase = connectDatabase;
const originalSafeDatabaseError = safeDatabaseError;

mock.module("../../src/store/database.ts", () => ({
  connectDatabase: (config: Parameters<typeof connectDatabase>[0]) => {
    const sql = originalConnectDatabase(config);
    const close = sql.close;
    sql.close = async (options) => {
      await close(options);
      throw new Error("simulated database close failure");
    };
    return sql;
  },
  safeDatabaseError: originalSafeDatabaseError,
}));
