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
