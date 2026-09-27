import { expect, test } from "bun:test";
import { readInspectConfig, readSaveConfig } from "../../src/config";

test("inspect config defaults to the sole Saved entry and approved request spacing", () => {
  const config = readInspectConfig({
    PLAYWRIGHT_MCP_EXTENSION_TOKEN: "test-token",
  });
  expect(config).toEqual({
    extensionToken: "test-token",
    savedPageUrl: "https://grok.com/imagine/saved",
    requestIntervalMinSeconds: 5,
    requestIntervalMaxSeconds: 8,
  });
});

test("inspect config rejects non-Saved URLs and invalid interval bounds", () => {
  expect(() =>
    readInspectConfig({
      PLAYWRIGHT_MCP_EXTENSION_TOKEN: "x",
      GROK_SAVED_LIST_URL: "https://grok.com/imagine/all",
    }),
  ).toThrow("必须指向");
  expect(() =>
    readInspectConfig({
      PLAYWRIGHT_MCP_EXTENSION_TOKEN: "x",
      GROK_SAVED_LIST_URL: "https://grok.com/imagine/saved?token=private",
    }),
  ).toThrow("必须指向");
  expect(() =>
    readInspectConfig({
      PLAYWRIGHT_MCP_EXTENSION_TOKEN: "x",
      GROK_API_INTERVAL_MIN_SECONDS: "9",
      GROK_API_INTERVAL_MAX_SECONDS: "8",
    }),
  ).toThrow("不能大于");
});

test("inspect config reports a missing token without revealing it", () => {
  expect(() => readInspectConfig({})).toThrow("PLAYWRIGHT_MCP_EXTENSION_TOKEN");
});

test("save config validates positive finite media timeouts", () => {
  const env = {
    GROK_DB_HOST: "127.0.0.1",
    GROK_DB_USER: "test",
    GROK_DB_PASSWORD: "test",
    GROK_DB_NAME: "test",
    GROK_ARCHIVE_DIR: "/tmp/archive",
    PLAYWRIGHT_MCP_EXTENSION_TOKEN: "test",
  };
  expect(readSaveConfig(env)).toMatchObject({
    mediaFirstByteTimeoutSeconds: 30,
    mediaNoProgressTimeoutSeconds: 30,
    mediaTotalTimeoutSeconds: 900,
  });
  expect(() =>
    readSaveConfig({ ...env, GROK_MEDIA_FIRST_BYTE_TIMEOUT_SECONDS: "0" }),
  ).toThrow("GROK_MEDIA_FIRST_BYTE_TIMEOUT_SECONDS");
  expect(() =>
    readSaveConfig({ ...env, GROK_MEDIA_NO_PROGRESS_TIMEOUT_SECONDS: "NaN" }),
  ).toThrow("GROK_MEDIA_NO_PROGRESS_TIMEOUT_SECONDS");
  expect(() =>
    readSaveConfig({ ...env, GROK_MEDIA_TOTAL_TIMEOUT_SECONDS: "Infinity" }),
  ).toThrow("GROK_MEDIA_TOTAL_TIMEOUT_SECONDS");
});
