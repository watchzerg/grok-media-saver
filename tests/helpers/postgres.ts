import { afterAll, beforeAll } from "bun:test";
import { SQL } from "bun";

const password = "isolated-test-password";
const database = "grok_media_saver_test";
const username = "postgres";
let containerId: string | undefined;
const host = "127.0.0.1";
let port: number;

export let testSql: SQL;
export let databaseEnv: Record<string, string>;

export function useIsolatedPostgres() {
  beforeAll(async () => {
    const started = await runDocker([
      "run",
      "--detach",
      "--rm",
      "--name",
      `gms-db-test-${crypto.randomUUID().slice(0, 8)}`,
      "--env",
      `POSTGRES_PASSWORD=${password}`,
      "--env",
      `POSTGRES_DB=${database}`,
      "--publish",
      "127.0.0.1::5432",
      "postgres:18-alpine",
    ]);
    containerId = started.stdout.trim();
    const portResult = await runDocker(["port", containerId, "5432/tcp"]);
    const mapped = portResult.stdout.trim().match(/:(\d+)$/);
    if (!mapped) throw new Error("Docker 未返回隔离 PostgreSQL 端口。");
    port = Number(mapped[1]);

    const deadline = Date.now() + 30_000;
    while (true) {
      testSql = new SQL({
        adapter: "postgres",
        hostname: host,
        port,
        username,
        password,
        database,
        connectionTimeout: 1,
      });
      try {
        await testSql`SELECT 1`;
        break;
      } catch {
        await testSql.close({ timeout: 0 }).catch(() => undefined);
        if (Date.now() > deadline)
          throw new Error("隔离 PostgreSQL 在 30 秒内未就绪。");
        await Bun.sleep(250);
      }
    }

    databaseEnv = {
      PATH: process.env.PATH ?? "",
      GROK_DB_HOST: host,
      GROK_DB_PORT: String(port),
      GROK_DB_USER: username,
      GROK_DB_PASSWORD: password,
      GROK_DB_NAME: database,
    };
  });

  afterAll(async () => {
    try {
      await testSql?.close({ timeout: 5 });
    } finally {
      if (containerId) await runDocker(["stop", containerId]);
    }
  });
}

async function runDocker(args: string[]) {
  const child = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(`Docker 命令失败：${stderr.trim() || stdout.trim()}`);
  return { stdout, stderr };
}
