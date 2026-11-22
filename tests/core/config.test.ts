import { expect, test } from "bun:test";
import { readInspectConfig } from "../../src/config";

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
