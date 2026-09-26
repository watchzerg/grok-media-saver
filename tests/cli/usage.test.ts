import { expect, test } from "bun:test";

test("CLI runs in a real child process and returns configuration errors with exit code 2", async () => {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "src/cli.ts", "inspect", "first-page"],
    {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stdout).toBe("");
  expect(stderr).toContain("PLAYWRIGHT_MCP_EXTENSION_TOKEN");
  expect(exitCode).toBe(2);
});

test("inspect post rejects a URL as an invalid ID before configuration or browser startup", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "src/cli.ts",
      "inspect",
      "post",
      "https://grok.com/imagine/post/123",
    ],
    {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stdout).toBe("");
  expect(stderr).toContain("Post ID");
  expect(exitCode).toBe(2);
});

test("inspect post accepts a UUID-shaped ID before reporting missing configuration", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "src/cli.ts",
      "inspect",
      "post",
      "123e4567-e89b-42d3-a456-426614174000",
    ],
    {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stdout).toBe("");
  expect(stderr).toContain("PLAYWRIGHT_MCP_EXTENSION_TOKEN");
  expect(stderr).not.toContain("Post ID");
  expect(exitCode).toBe(2);
});
