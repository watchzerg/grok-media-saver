import { SQL } from "bun";
import type { DatabaseConfig } from "../config";

export function connectDatabase(config: DatabaseConfig): SQL {
  return new SQL({
    adapter: "postgres",
    hostname: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    database: config.database,
    connectionTimeout: 5,
    max: 1,
  });
}

export function safeDatabaseError(
  error: unknown,
  config: DatabaseConfig,
): string {
  let message = error instanceof Error ? error.message : String(error);
  const secrets = [
    config.password,
    encodeURIComponent(config.password),
    `${config.username}:${config.password}`,
  ];
  for (const secret of secrets)
    if (secret) message = message.replaceAll(secret, "[已隐藏]");
  return message.replace(/(?:postgres(?:ql)?:\/\/)[^\s"']+/gi, "[数据库连接]");
}
