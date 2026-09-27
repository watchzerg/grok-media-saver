import { initializeProjectDatabase } from "../../src/application-runtime";
import { main } from "../../src/cli";

const exitCode = await main(["db", "init"], process.env, {
  initializeProjectDatabase: (config) =>
    initializeProjectDatabase(config, async (_sql, timeoutSeconds) => {
      if (timeoutSeconds !== 5)
        throw new Error(`关闭期限为 ${timeoutSeconds} 秒，应为 5 秒`);
      throw new Error("受控关闭超时");
    }),
});
process.exitCode = exitCode;
