import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeProjectDatabase } from "../../src/application-runtime";
import { readDatabaseConfig } from "../../src/config";
import { databaseEnv, testSql, useIsolatedPostgres } from "../helpers/postgres";

useIsolatedPostgres();
const ids = [
  "123e4567-e89b-42d3-a456-426614174000",
  "123e4567-e89b-42d3-a456-426614174001",
];
let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
const page = (...members: string[]) => ({
  kind: "page",
  assets: members.map((assetId) => ({ assetId, mimeType: "image/png" })),
  hasNextPage: false,
});
async function setup() {
  await testSql`DROP TABLE IF EXISTS media_versions, post_work, runs CASCADE`;
  expect(
    (await initializeProjectDatabase(readDatabaseConfig(databaseEnv))).status,
  ).toBe("ok");
  root = await mkdtemp(join(tmpdir(), "gms-batch-process-"));
}
function spawn(
  args = ["archive", "saved"],
  extra: Record<string, string> = {},
  preloads: string[] = [],
) {
  return Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--preload",
      "./tests/helpers/fake-archive-saved-browser.ts",
      ...preloads.flatMap((p) => ["--preload", `./${p}`]),
      "src/cli.ts",
      ...args,
    ],
    {
      env: {
        ...databaseEnv,
        GROK_ARCHIVE_DIR: root,
        PLAYWRIGHT_MCP_EXTENSION_TOKEN: "fixture",
        GROK_API_INTERVAL_MIN_SECONDS: "0",
        GROK_API_INTERVAL_MAX_SECONDS: "0",
        GMS_TEST_REMOTE_FACTS: join(root, "remote.json"),
        GMS_TEST_REQUEST_EVENTS: join(root, "requests"),
        ...extra,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}
async function collect(child: ReturnType<typeof spawn>) {
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}
async function requests() {
  return (await Bun.file(join(root, "requests")).exists())
    ? (await readFile(join(root, "requests"), "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as { kind: string; postId?: string; at: number },
        )
    : [];
}

const pagesEnv = (...pages: ReturnType<typeof page>[]) => ({
  GMS_TEST_BATCH_PAGES: JSON.stringify(pages),
});

test("S2 两轮精确归档、去重与历史摘要和当前遗留分开", async () => {
  await setup();
  const result = await collect(
    spawn(
      undefined,
      pagesEnv(
        page((ids[0] ?? "").toUpperCase(), ids[0] ?? ""),
        page(...ids),
        page(),
      ),
    ),
  );
  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(result.stdout).toContain("归档完成 2");
  expect(result.stdout).toContain("新确认移除 2");
  expect(result.stdout).toContain("已进入 2 轮");
  const events = await requests();
  expect(
    events.filter((r) => r.kind === "delete").map((r) => r.postId),
  ).toEqual(ids);
  expect(events.filter((r) => r.kind === "connect")).toHaveLength(1);
  const [file] =
    await testSql`SELECT relative_path FROM media_versions WHERE post_id=${ids[0]}`;
  expect(await Bun.file(join(root, String(file?.relative_path))).exists()).toBe(
    true,
  );
  await testSql`INSERT INTO post_work(post_id,goal,status) VALUES ('123e4567-e89b-42d3-a456-426614174099','save','failed')`;
  const status = await collect(spawn(["status"]));
  expect(status.exitCode).toBe(0);
  expect(status.stdout).toContain("历史批量摘要：已发现 2");
  expect(status.stdout).toContain("该 Run 收尾时遗留快照：save 0，archive 0");
  expect(status.stdout).toContain("当前数据库遗留：save 1，archive 0");
  expect(await requests()).toEqual(events);
}, 20000);

test("S2 空页遗留及 No Progress 都非零，未开始和恢复提示明确", async () => {
  await setup();
  await testSql`INSERT INTO post_work(post_id,goal,status) VALUES (${ids[0]},'save','failed'),(${ids[1]},'archive','failed')`;
  const empty = await collect(spawn());
  expect(empty.exitCode).toBe(1);
  expect(empty.stdout).toContain("空页但有遗留");
  expect(empty.stdout).toContain("save 1，archive 1");
  expect(empty.stdout).toContain("可能与本次未确认完成重叠");
  const stagnant = await collect(
    spawn(undefined, {
      ...pagesEnv(page(ids[1] ?? "")),
      GMS_TEST_BATCH_UNAVAILABLE: ids[1] ?? "",
    }),
  );
  expect(stagnant.exitCode).toBe(1);
  expect(stagnant.stdout).toContain("No Progress");
  expect(stagnant.stdout).toContain("已结清重现项不会由 retry 清除");
  expect(stagnant.stdout).not.toContain("%");
  const status = await collect(spawn(["status"]));
  expect(status.exitCode).toBe(0);
});
