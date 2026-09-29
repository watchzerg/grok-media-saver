import { mock } from "bun:test";

const actual = (await import(
  "../../src/store/database.ts?member-lock-source" as string
)) as typeof import("../../src/store/database");
let checksAfterPage = 0;
let pageRead = false;
process.once("gms-test-page-read", () => {
  pageRead = true;
});
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
                const lockCheck =
                  Array.isArray(parts) && parts.join("").includes("AS held");
                return (async () => {
                  const result = await Reflect.apply(query, self, queryArgs);
                  // First check adopts the page; second guards its first member.
                  // Abort while Application still awaits this real SQL receipt.
                  if (pageRead && lockCheck && ++checksAfterPage === 2) {
                    process.emit("gms-test-member-lock");
                    await Bun.sleep(10);
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
