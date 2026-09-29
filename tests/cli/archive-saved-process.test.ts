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

test("S2 archive saved 空页正式接入且输出轮次、观察与遗留", async () => {
  await setup();
  const result = await collect(spawn());
  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(result.stdout).toContain("已发现 0");
  expect(result.stdout).toContain("已进入 0 轮");
  expect(result.stdout).toContain("合法空页");
  expect(result.stdout).toContain("save 0，archive 0");
  expect((await testSql`SELECT command,outcome FROM runs`)[0]).toEqual({
    command: "archive-saved",
    outcome: "succeeded",
  });
});

const pagesEnv = (...pages: ReturnType<typeof page>[]) => ({
  GMS_TEST_BATCH_PAGES: JSON.stringify(pages),
});
async function marker(path: string) {
  const deadline = Date.now() + 6000;
  while (!(await Bun.file(path).exists()) && Date.now() < deadline)
    await Bun.sleep(10);
  expect(await Bun.file(path).exists()).toBe(true);
}
async function stopChild(child: ReturnType<typeof spawn>) {
  if (child.exitCode === null && child.signalCode === null) {
    process.kill(child.pid, "SIGCONT");
    process.kill(child.pid, "SIGKILL");
    await child.exited;
  }
}

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

for (const scenario of [
  {
    name: "轮内",
    stage: "删除意图已提交",
    interval: "0",
    expected: ["page", "detail", "media"],
  },
  {
    name: "轮间",
    stage: "等待下一轮（5 秒）",
    interval: "0",
    expected: ["page", "detail", "media", "delete"],
  },
  {
    name: "许可等待",
    stage: "读取当前详情",
    interval: "30",
    expected: ["page"],
  },
]) {
  test(`S2 ${scenario.name}真实 SIGINT 停止禁止后续请求及预建成员`, async () => {
    await setup();
    const mark = join(root, "stage");
    const child = spawn(
      undefined,
      {
        ...pagesEnv(
          page(...(scenario.name === "轮间" ? ids.slice(0, 1) : ids)),
          page(),
        ),
        GMS_TEST_STOP_STAGE: scenario.stage,
        GMS_TEST_STAGE_MARKER: mark,
        GROK_API_INTERVAL_MIN_SECONDS: scenario.interval,
        GROK_API_INTERVAL_MAX_SECONDS: scenario.interval,
      },
      ["tests/helpers/pause-save-stage.ts"],
    );
    const output = collect(child);
    try {
      await marker(mark);
      if (scenario.name === "许可等待" || scenario.name === "轮间") {
        process.kill(child.pid, "SIGCONT");
        await Bun.sleep(80);
        process.kill(child.pid, "SIGINT");
      } else {
        process.kill(child.pid, "SIGINT");
        process.kill(child.pid, "SIGCONT");
      }
      const result = await output;
      expect(result.exitCode, JSON.stringify(result)).toBe(130);
      expect(result.stdout).toContain("用户停止");
      expect(
        (await requests())
          .filter((r) => !["connect", "close"].includes(r.kind))
          .map((r) => r.kind),
      ).toEqual(scenario.expected);
      // Round-wait starts after the fixed page has completed.
      if (scenario.name !== "轮间")
        expect(
          await testSql`SELECT * FROM post_work WHERE post_id=${ids[1]}`,
        ).toHaveLength(0);
    } finally {
      await stopChild(child);
      await output;
    }
  }, 15000);
}

for (const window of ["intent", "removed"] as const) {
  test(`S2 ${window}窗口真实终止后保留同一模拟事实，retry先核对且重新发现未开始项`, async () => {
    await setup();
    const mark = join(root, "window");
    const child = spawn(
      undefined,
      {
        ...pagesEnv(page(...ids)),
        ...(window === "intent"
          ? {
              GMS_TEST_STOP_STAGE: "删除意图已提交",
              GMS_TEST_STAGE_MARKER: mark,
            }
          : { GMS_TEST_DELETE_MARKER: mark, GMS_TEST_PAUSE_DELETE: "1" }),
      },
      window === "intent" ? ["tests/helpers/pause-save-stage.ts"] : [],
    );
    const output = collect(child);
    try {
      await marker(mark);
      const [before] =
        await testSql`SELECT removal_state,archive_settled FROM post_work WHERE post_id=${ids[0]}`;
      expect(before).toEqual({
        removal_state: "pending",
        archive_settled: false,
      });
      expect(
        await testSql`SELECT * FROM post_work WHERE post_id=${ids[1]}`,
      ).toHaveLength(0);
      process.kill(child.pid, "SIGKILL");
      await output;
      const status = await collect(spawn(["status"]));
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain("数量未知");
      expect(status.stdout).toContain("轮次、列表观察和当时遗留快照未知");
      expect(status.stdout).toContain("先核对同一远端目标");
      const start = (await requests()).length;
      const retry = await collect(spawn(["retry"]));
      expect(retry.exitCode, JSON.stringify(retry)).toBe(0);
      expect(
        (await requests())
          .slice(start)
          .filter((r) => !["connect", "close"].includes(r.kind))
          .map((r) => r.kind),
      ).toEqual(
        window === "intent" ? ["check", "detail", "delete"] : ["check"],
      );
      const restarted = await collect(
        spawn(undefined, pagesEnv(page(ids[1] ?? ""), page())),
      );
      expect(restarted.exitCode, JSON.stringify(restarted)).toBe(0);
      expect(
        (await requests()).filter(
          (r) => r.kind === "delete" && r.postId === ids[0],
        ),
      ).toHaveLength(1);
      expect(
        await testSql`SELECT * FROM post_work WHERE NOT archive_settled`,
      ).toHaveLength(0);
      expect(
        JSON.parse(await readFile(join(root, "remote.json"), "utf8")),
      ).toEqual(ids);
      const runs = await testSql`SELECT outcome FROM runs ORDER BY started_at`;
      expect(runs[0]?.outcome).toBe("interrupted");
    } finally {
      await stopChild(child);
      await output;
    }
  }, 20000);
}

test("S2 争锁不创建 Run 或浏览器；真实丢锁不重取或越界写 Post", async () => {
  await setup();
  const session = await testSql.reserve();
  await session`SELECT pg_advisory_lock(1297043787,1)`;
  try {
    const contested = await collect(spawn());
    expect(contested.exitCode).toBe(1);
    expect(await testSql`SELECT * FROM runs`).toHaveLength(0);
    expect(await requests()).toHaveLength(0);
  } finally {
    await session`SELECT pg_advisory_unlock(1297043787,1)`;
    session.release();
  }
  const mark = join(root, "lock");
  const child = spawn(
    undefined,
    {
      ...pagesEnv(page(...ids)),
      GMS_TEST_STOP_STAGE: "删除意图已提交",
      GMS_TEST_STAGE_MARKER: mark,
    },
    ["tests/helpers/pause-save-stage.ts"],
  );
  const output = collect(child);
  try {
    await marker(mark);
    const before = await testSql`SELECT * FROM post_work`;
    await testSql`SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory' AND granted AND classid=1297043787::oid AND objid=1::oid`;
    process.kill(child.pid, "SIGCONT");
    expect((await output).exitCode).toBe(1);
    expect(await testSql`SELECT * FROM post_work`).toEqual(before);
    expect((await requests()).filter((r) => r.kind === "delete")).toHaveLength(
      0,
    );
    expect((await requests()).filter((r) => r.kind === "connect")).toHaveLength(
      1,
    );
    expect(await testSql`SELECT * FROM runs`).toHaveLength(1);
  } finally {
    await stopChild(child);
    await output;
  }
}, 15000);

for (const force of [false, true]) {
  test(`S2 在途 DELETE ${force ? "第二次强退" : "首次信号收集响应"}保留远端事实且禁止后续请求`, async () => {
    await setup();
    const mark = join(root, "delete");
    const child = spawn(undefined, {
      ...pagesEnv(page(...ids)),
      GMS_TEST_DELETE_MARKER: mark,
      GMS_TEST_DELETE_DELAY_MS: force ? "30000" : "800",
    });
    const output = collect(child);
    try {
      await marker(mark);
      process.kill(child.pid, "SIGINT");
      if (force) {
        await Bun.sleep(80);
        process.kill(child.pid, "SIGINT");
      }
      const result = await output;
      expect(result.exitCode, JSON.stringify(result)).toBe(130);
      expect(
        (await requests())
          .filter((r) => !["connect", "close"].includes(r.kind))
          .map((r) => r.kind),
      ).toEqual(["page", "detail", "media", "delete"]);
      const [work] =
        await testSql`SELECT removal_state,archive_settled FROM post_work WHERE post_id=${ids[0]}`;
      expect(work).toEqual(
        force
          ? { removal_state: "pending", archive_settled: false }
          : { removal_state: "removed", archive_settled: true },
      );
      expect(
        await testSql`SELECT * FROM post_work WHERE post_id=${ids[1]}`,
      ).toHaveLength(0);
      if (force) {
        expect(result.stderr).toContain("已强制停止");
        expect((await collect(spawn(["retry"]))).exitCode).toBe(0);
        expect(
          (await requests()).filter((r) => r.kind === "delete"),
        ).toHaveLength(1);
      }
    } finally {
      await stopChild(child);
      await output;
    }
  }, 10000);
}

for (const committed of [true, false]) {
  test(`S2 摘要${committed ? "真实提交失回执" : "真实拒绝"}展示已知观察，status读取实际DB`, async () => {
    await setup();
    if (!committed) {
      await testSql`CREATE OR REPLACE FUNCTION reject_s2_summary() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture reject summary'; END $$`;
      await testSql`CREATE TRIGGER reject_s2_summary BEFORE UPDATE OF summary ON runs FOR EACH ROW EXECUTE FUNCTION reject_s2_summary()`;
    }
    const result = await collect(
      spawn(
        undefined,
        {},
        committed ? ["tests/helpers/lose-run-summary-receipt.ts"] : [],
      ),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("摘要提交结果未知");
    expect(result.stdout).toContain("已发现 0");
    const status = await collect(spawn(["status"]));
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain(
      committed ? "历史批量摘要：已发现 0" : "数量未知",
    );
    if (!committed) {
      expect(status.stdout).not.toContain("归档完成 0");
      await testSql`DROP FUNCTION reject_s2_summary() CASCADE`;
    }
  });
}

test("S2 独立清理失败保留已提交成功摘要而命令非零，配置错误退出2不接资源", async () => {
  await setup();
  const invalid = await collect(spawn(undefined, { GROK_ARCHIVE_DIR: "" }));
  expect(invalid.exitCode).toBe(2);
  expect(await requests()).toHaveLength(0);
  const cleanup = await collect(
    spawn(undefined, { GMS_TEST_FINAL_CLOSE_FAILURE: "1" }),
  );
  expect(cleanup.exitCode).toBe(1);
  expect(cleanup.stderr).toContain("cleanup failed");
  const [run] = await testSql`SELECT outcome,summary FROM runs`;
  expect(run?.outcome).toBe("succeeded");
  expect(run?.summary.endReason).toBe("completed");
  expect((await collect(spawn(["status"]))).exitCode).toBe(0);
});

test("S2 在途 DELETE 首次停止不重置原30秒期限，到期保留待核对事实", async () => {
  await setup();
  const mark = join(root, "deadline");
  const child = spawn(undefined, {
    ...pagesEnv(page(...ids)),
    GMS_TEST_DELETE_MARKER: mark,
    GMS_TEST_DELETE_DELAY_MS: "40000",
  });
  const output = collect(child);
  try {
    await marker(mark);
    const sentAt = (await requests()).find((r) => r.kind === "delete")?.at ?? 0;
    await Bun.sleep(8000);
    process.kill(child.pid, "SIGINT");
    const result = await output;
    const elapsed = Date.now() - sentAt;
    expect(result.exitCode).toBe(130);
    expect(elapsed).toBeGreaterThanOrEqual(29000);
    expect(elapsed).toBeLessThan(34000);
    expect(result.stdout).toContain("30 秒总期限");
    expect(result.stderr).toContain("停止无法确认");
    expect(
      (await requests())
        .filter((r) => !["connect", "close"].includes(r.kind))
        .map((r) => r.kind),
    ).toEqual(["page", "detail", "media", "delete"]);
    const [work] =
      await testSql`SELECT removal_state,archive_settled FROM post_work WHERE post_id=${ids[0]}`;
    expect(work).toEqual({ removal_state: "pending", archive_settled: false });
    expect(
      await testSql`SELECT * FROM post_work WHERE post_id=${ids[1]}`,
    ).toHaveLength(0);
    expect((await collect(spawn(["retry"]))).exitCode).toBe(0);
    expect((await requests()).filter((r) => r.kind === "delete")).toHaveLength(
      1,
    );
  } finally {
    await stopChild(child);
    await output;
  }
}, 40000);

test("S2 非法第一页和阻挡准确退出，发现零不推断空页，未开始不预建", async () => {
  await setup();
  const invalid = await collect(
    spawn(undefined, {
      GMS_TEST_BATCH_PAGES: JSON.stringify([{ kind: "unknown" }]),
    }),
  );
  expect(invalid.exitCode).toBe(1);
  expect(invalid.stdout).toContain("最后列表观察：读取失败");
  expect(invalid.stdout).toContain("结束原因：读页失败");
  expect(invalid.stdout).toContain("已发现 0");
  expect(invalid.stdout).not.toContain("合法空页");
  const blocked = await collect(
    spawn(undefined, {
      ...pagesEnv(page(...ids)),
      GMS_TEST_BATCH_BLOCKED: ids[0] ?? "",
    }),
  );
  expect(blocked.exitCode).toBe(1);
  expect(blocked.stdout).toContain("全局阻挡");
  expect(blocked.stdout).toContain("未确认完成 1，未处理 1");
  expect(
    await testSql`SELECT * FROM post_work WHERE post_id=${ids[1]}`,
  ).toHaveLength(0);
  expect((await requests()).filter((r) => r.kind === "delete")).toHaveLength(0);
});

test("S2 删除结清提交失回执保留新观察、未知摘要及绑定事实，status不倒推", async () => {
  await setup();
  const result = await collect(
    spawn(
      undefined,
      { ...pagesEnv(page(...ids)), GMS_TEST_LOSE_ARCHIVE_RECEIPT: "settle" },
      ["tests/helpers/lose-archive-receipt.ts"],
    ),
  );
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toContain("新确认移除 1");
  expect(result.stdout).toContain("未确认完成 1，未处理 1");
  expect(result.stdout).toContain("提交结果未知");
  expect(result.stdout).toContain("数据库遗留：未知");
  const [work] =
    await testSql`SELECT archive_settled FROM post_work WHERE post_id=${ids[0]}`;
  expect(work?.archive_settled).toBe(true);
  const status = await collect(spawn(["status"]));
  expect(status.exitCode).toBe(0);
  expect(status.stdout).toContain("数量未知");
  expect(status.stdout).not.toContain("归档完成 1");
});

test("S2 已移除未结清status只提示绑定文件补救，retry不重新DELETE", async () => {
  await setup();
  const first = await collect(spawn(["archive", "post", ids[0] ?? ""]));
  expect(first.exitCode).toBe(0);
  await testSql`UPDATE post_work SET archive_settled=false WHERE post_id=${ids[0]}`;
  const [version] =
    await testSql`SELECT relative_path FROM media_versions WHERE post_id=${ids[0]}`;
  await rm(join(root, String(version?.relative_path)));
  const before = await requests();
  const status = await collect(spawn(["status"]));
  expect(status.stdout).toContain("接续绑定版本的本地核验或补救");
  expect(await requests()).toEqual(before);
  expect((await collect(spawn(["retry"]))).exitCode).toBe(0);
  expect(
    (await requests())
      .slice(before.length)
      .filter((r) => !["connect", "close"].includes(r.kind))
      .map((r) => r.kind),
  ).toEqual(["media"]);
  expect(
    await Bun.file(join(root, String(version?.relative_path))).exists(),
  ).toBe(true);
});
