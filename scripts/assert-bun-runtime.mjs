import { readFileSync } from "node:fs";

const mise = readFileSync(new URL("../mise.toml", import.meta.url), "utf8");
const line = /^bun = "(\d+\.\d+)"$/m.exec(mise)?.[1];

if (!line) {
  throw new Error("mise.toml must declare a Bun major.minor version line");
}

if (!Bun.version.startsWith(`${line}.`)) {
  throw new Error(`requires Bun ${line}.x; received ${Bun.version}`);
}
