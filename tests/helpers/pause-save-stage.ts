import { writeFileSync } from "node:fs";

const stage = process.env.GMS_TEST_STOP_STAGE;
const marker = process.env.GMS_TEST_STAGE_MARKER;
if (stage && marker) {
  const original = console.log;
  console.log = (...args: unknown[]) => {
    original(...args);
    if (args.join(" ").includes(`阶段：${stage}。`)) {
      writeFileSync(marker, stage);
      process.kill(process.pid, "SIGSTOP");
    }
  };
}
