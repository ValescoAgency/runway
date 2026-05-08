#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

// Thin shim — runway is shipped as TS source for v1; tsx runs it directly.
// When we publish a compiled build, this entry will swap to import("../dist/cli.js").

const __dirname = dirname(fileURLToPath(import.meta.url));
const cli = join(__dirname, "..", "src", "cli.ts");

const child = spawn("npx", ["tsx", cli, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code) => process.exit(code ?? 1));
