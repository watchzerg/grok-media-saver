import { afterAll, beforeAll } from "bun:test";
import { SQL } from "bun";

// 一次 bun test 运行共用一个 PostgreSQL 容器，每个测试文件使用自己新建的数据库。
// 本模块经 bunfig.toml 预加载，底部的 afterAll 因此在全部测试文件结束后执行一次，负责停止容器。
const password = "isolated-test-password";
const username = "postgres";
const host = "127.0.0.1";
// 容器启动与就绪等待可能超过 bun 默认 5 秒 hook 超时；须高于下方 30 秒就绪期限。
const hookTimeoutMs = 45_000;

type Server = { containerId: string; port: number; admin: SQL };
let server: Promise<Server> | undefined;

export let testSql: SQL;
export let databaseEnv: Record<string, string>;

export function useIsolatedPostgres() {
  let database: string | undefined;

  beforeAll(async () => {
    server ??= startServer();
    const { port, admin } = await server;
    database = `gms_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(`CREATE DATABASE ${database}`);
    testSql = connect(port, database);
    databaseEnv = {
      PATH: process.env.PATH ?? "",
      GROK_DB_HOST: host,
      GROK_DB_PORT: String(port),
      GROK_DB_USER: username,
      GROK_DB_PASSWORD: password,
      GROK_DB_NAME: database,
    };
  }, hookTimeoutMs);

  afterAll(async () => {
    await testSql?.close({ timeout: 5 });
    if (database && server)
      await (await server).admin.unsafe(
        `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
      );
  }, hookTimeoutMs);
}

afterAll(async () => {
  if (!server) return;
  const started = await server.catch(() => undefined);
  if (!started) return;
  try {
    await started.admin.close({ timeout: 5 });
  } finally {
    await runDocker(["stop", started.containerId]);
  }
}, hookTimeoutMs);

async function startServer(): Promise<Server> {
  const started = await runDocker([
    "run",
    "--detach",
    "--rm",
    "--name",
    `gms-db-test-${crypto.randomUUID().slice(0, 8)}`,
    "--env",
    `POSTGRES_PASSWORD=${password}`,
    "--publish",
    "127.0.0.1::5432",
    "postgres:18-alpine",
  ]);
  const containerId = started.stdout.trim();
  const portResult = await runDocker(["port", containerId, "5432/tcp"]);
  const mapped = portResult.stdout.trim().match(/:(\d+)$/);
  if (!mapped) throw new Error("Docker 未返回隔离 PostgreSQL 端口。");
  const port = Number(mapped[1]);

  const deadline = Date.now() + 30_000;
  while (true) {
    const admin = connect(port, "postgres");
    try {
      await admin`SELECT 1`;
      return { containerId, port, admin };
    } catch {
      await admin.close({ timeout: 0 }).catch(() => undefined);
      if (Date.now() > deadline)
        throw new Error("隔离 PostgreSQL 在 30 秒内未就绪。");
      await Bun.sleep(250);
    }
  }
}

function connect(port: number, database: string) {
  return new SQL({
    adapter: "postgres",
    hostname: host,
    port,
    username,
    password,
    database,
    connectionTimeout: 1,
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
