import { mock } from "bun:test";

const actual = (await import(
  "../../src/store/database.ts?summary-source" as string
)) as typeof import("../../src/store/database");
mock.module("../../src/store/database.ts", () => ({
  ...actual,
  connectDatabase: (...args: Parameters<typeof actual.connectDatabase>) => {
    const sql = actual.connectDatabase(...args);
    return new Proxy(sql, {
      get(target, key) {
        if (key === "reserve")
          return async (...reserveArgs: Parameters<typeof sql.reserve>) => {
            const session = await sql.reserve(...reserveArgs);
            return new Proxy(session, {
              apply(query, self, queryArgs) {
                const parts = queryArgs[0];
                const summaryWrite =
                  Array.isArray(parts) &&
                  parts.join("").includes("UPDATE runs") &&
                  parts.join("").includes("summary =");
                return (async () => {
                  const result = await Reflect.apply(query, self, queryArgs);
                  if (summaryWrite) {
                    if (process.env.GMS_TEST_SUMMARY_STOP === "1") {
                      process.kill(process.pid, "SIGINT");
                      await Bun.sleep(20);
                    }
                    throw new Error("模拟 Run 摘要实际提交后回执丢失");
                  }
                  return result;
                })();
              },
              get(query, member) {
                const value = Reflect.get(query, member);
                return typeof value === "function" ? value.bind(query) : value;
              },
            });
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  },
}));
