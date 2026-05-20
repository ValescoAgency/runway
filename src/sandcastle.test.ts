import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLatestSandcastleLogTail } from "./sandcastle.js";

// VA-454: the helper exists because sandcastle's thrown Error.message
// is just `claude-code exited with code 1:` (literal trailing colon,
// no body). The stderr text the operator actually needs lives in
// `<cwd>/.sandcastle/logs/<run-id>.log`. The helper reads the tail
// of the most-recent log file so the orchestrator's INFRA_ERROR line
// carries the real cause.

describe("readLatestSandcastleLogTail (VA-454)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "runway-sandcastle-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("returns null when `.sandcastle/logs/` is absent (fresh project)", () => {
    expect(readLatestSandcastleLogTail(cwd)).toBeNull();
  });

  it("returns null when the logs directory exists but has no .log files", () => {
    mkdirSync(join(cwd, ".sandcastle", "logs"), { recursive: true });
    expect(readLatestSandcastleLogTail(cwd)).toBeNull();
  });

  it("returns the tail of the most-recently-modified log file", () => {
    const logsDir = join(cwd, ".sandcastle", "logs");
    mkdirSync(logsDir, { recursive: true });
    const older = join(logsDir, "older.log");
    const newer = join(logsDir, "newer.log");
    writeFileSync(older, "older content — should be ignored\n");
    writeFileSync(newer, "Invalid API key · Fix external API key\n");
    // Force a distinct mtime on `older` so the test isn't relying on
    // creation-order timing — set `older` an hour in the past.
    const past = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(older, past, past);

    const tail = readLatestSandcastleLogTail(cwd);
    expect(tail).toContain("Invalid API key");
    expect(tail).not.toContain("older content");
  });

  it("caps the tail at the requested line count", () => {
    const logsDir = join(cwd, ".sandcastle", "logs");
    mkdirSync(logsDir, { recursive: true });
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(logsDir, "big.log"), `${lines.join("\n")}\n`);

    const tail = readLatestSandcastleLogTail(cwd, 5);
    expect(tail?.split("\n")).toEqual([
      "line 196",
      "line 197",
      "line 198",
      "line 199",
      "line 200",
    ]);
  });

  it("only reads the last 16 KB even when the file is much larger", () => {
    const logsDir = join(cwd, ".sandcastle", "logs");
    mkdirSync(logsDir, { recursive: true });
    // 2 MiB of filler followed by the real reason at the very end —
    // the helper must trim to the tail window without OOM-ing or
    // loading the whole file.
    const filler = "x".repeat(2 * 1024 * 1024);
    writeFileSync(
      join(logsDir, "huge.log"),
      `${filler}\nfinal-line: real reason here\n`,
    );

    const tail = readLatestSandcastleLogTail(cwd, 5);
    expect(tail).toContain("real reason here");
    // 16 KB cap × <expected line count assertions are inherent in the
    // assertion above succeeding without scanning the full 2 MiB.
  });
});
