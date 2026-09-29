import { archiveSaved } from "../../src/application-runtime";
import { readSaveConfig } from "../../src/config";
import type { PageResponse } from "../../src/grok/adapter";
import { statefulArchiveBrowser } from "./stateful-archive-browser";

const members: string[] = JSON.parse(process.env.GMS_TEST_BATCH_IDS ?? "[]");
const first: PageResponse = {
  kind: "page",
  assets: members.map((assetId) => ({ assetId, mimeType: "image/png" })),
  hasNextPage: false,
};
const fake = statefulArchiveBrowser([
  first,
  { kind: "page", assets: [], hasNextPage: false },
]);
const controller = new AbortController();
// Direct Application observation; the process only isolates existing fault preloads.
const result = await archiveSaved(readSaveConfig(process.env), {
  connect: fake.connect,
  signal: controller.signal,
  onStage: (stage) => {
    if (
      process.env.GMS_TEST_BATCH_STOP_WAIT === "1" &&
      stage === "等待下一轮（5 秒）"
    )
      controller.abort();
  },
});
console.log(JSON.stringify({ result, requests: fake.requests }));
