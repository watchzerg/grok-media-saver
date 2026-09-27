export type InspectConfig = {
  extensionToken: string;
  savedPageUrl: string;
  requestIntervalMinSeconds: number;
  requestIntervalMaxSeconds: number;
};

export type DatabaseConfig = {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
};

export function readDatabaseConfig(
  env: Record<string, string | undefined>,
): DatabaseConfig {
  const host = requiredValue(env.GROK_DB_HOST, "GROK_DB_HOST");
  const username = requiredValue(env.GROK_DB_USER, "GROK_DB_USER");
  const password = requiredValue(env.GROK_DB_PASSWORD, "GROK_DB_PASSWORD");
  const database = requiredValue(env.GROK_DB_NAME, "GROK_DB_NAME");
  const rawPort = env.GROK_DB_PORT?.trim() || "5432";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("GROK_DB_PORT 必须是 1 到 65535 之间的整数。");
  return { host, port, username, password, database };
}

function requiredValue(value: string | undefined, key: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`缺少配置 ${key}。`);
  return normalized;
}

export function readInspectConfig(
  env: Record<string, string | undefined>,
): InspectConfig {
  const token = env.PLAYWRIGHT_MCP_EXTENSION_TOKEN?.trim();
  if (!token) throw new Error("缺少配置 PLAYWRIGHT_MCP_EXTENSION_TOKEN。");
  const savedPageUrl =
    env.GROK_SAVED_LIST_URL?.trim() || "https://grok.com/imagine/saved";
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(savedPageUrl);
  } catch {
    throw new Error("GROK_SAVED_LIST_URL 必须是有效 URL。");
  }
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.hostname !== "grok.com" ||
    parsedUrl.port ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.pathname !== "/imagine/saved" ||
    parsedUrl.search ||
    parsedUrl.hash
  ) {
    throw new Error(
      "GROK_SAVED_LIST_URL 必须指向 https://grok.com/imagine/saved。",
    );
  }
  const requestIntervalMinSeconds = readSeconds(
    env.GROK_API_INTERVAL_MIN_SECONDS,
    5,
    "GROK_API_INTERVAL_MIN_SECONDS",
  );
  const requestIntervalMaxSeconds = readSeconds(
    env.GROK_API_INTERVAL_MAX_SECONDS,
    8,
    "GROK_API_INTERVAL_MAX_SECONDS",
  );
  if (requestIntervalMinSeconds > requestIntervalMaxSeconds) {
    throw new Error(
      "GROK_API_INTERVAL_MIN_SECONDS 不能大于 GROK_API_INTERVAL_MAX_SECONDS。",
    );
  }
  return {
    extensionToken: token,
    savedPageUrl,
    requestIntervalMinSeconds,
    requestIntervalMaxSeconds,
  };
}

function readSeconds(
  raw: string | undefined,
  fallback: number,
  key: string,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${key} 必须是非负有限秒数。`);
  return value;
}
