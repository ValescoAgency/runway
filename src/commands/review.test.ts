import { describe, expect, it } from "vitest";
import { parseDrainArgs, parseRunArgs } from "./review.js";

// VA-402: argv parser tests for `runway review run`. Lock the
// space-separated form, the `=` form, and the error cases — the
// runner is scheduler-agnostic (local cron / GitHub Actions / Vercel
// cron) so the arg shape is part of the contract.

describe("parseRunArgs (VA-402)", () => {
  it("parses the space-separated form", () => {
    const r = parseRunArgs([
      "--drain",
      "0123456789abcdef0123456789abcdef",
      "--issue",
      "VA-401",
    ]);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.traceId).toBe("0123456789abcdef0123456789abcdef");
    expect(r.issueIdentifier).toBe("VA-401");
  });

  it("parses the equals form", () => {
    const r = parseRunArgs([
      "--drain=0123456789abcdef0123456789abcdef",
      "--issue=VA-401",
    ]);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.traceId).toBe("0123456789abcdef0123456789abcdef");
    expect(r.issueIdentifier).toBe("VA-401");
  });

  it("accepts flags in either order", () => {
    const r = parseRunArgs([
      "--issue",
      "VA-401",
      "--drain",
      "0123456789abcdef0123456789abcdef",
    ]);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.issueIdentifier).toBe("VA-401");
  });

  it("errors when --drain is missing", () => {
    const r = parseRunArgs(["--issue", "VA-401"]);
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.message).toContain("--drain");
  });

  it("errors when --issue is missing", () => {
    const r = parseRunArgs(["--drain", "deadbeef"]);
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.message).toContain("--issue");
  });

  it("errors on an unknown flag", () => {
    const r = parseRunArgs([
      "--drain=deadbeef",
      "--issue=VA-401",
      "--what",
      "huh",
    ]);
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.message).toContain("--what");
  });

  // VA-403: --force boolean flag for delay-gate bypass.

  it("defaults force to false when omitted", () => {
    const r = parseRunArgs(["--drain=deadbeef", "--issue=VA-401"]);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.force).toBe(false);
  });

  it("parses bare --force as true", () => {
    const r = parseRunArgs([
      "--drain=deadbeef",
      "--issue=VA-401",
      "--force",
    ]);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.force).toBe(true);
  });

  it("parses --force=true as true", () => {
    const r = parseRunArgs([
      "--drain=deadbeef",
      "--issue=VA-401",
      "--force=true",
    ]);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.force).toBe(true);
  });

  it("accepts --force in any position relative to other flags", () => {
    const r = parseRunArgs([
      "--force",
      "--issue=VA-401",
      "--drain=deadbeef",
    ]);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.force).toBe(true);
    expect(r.traceId).toBe("deadbeef");
  });
});

// VA-406: parseDrainArgs tests for `runway review drain --id <trace-id>`.
// Locks the space-separated form, the equals form, and the error
// branches — operators and schedulers (cron / Actions) both depend on
// the shape staying stable.

describe("parseDrainArgs (VA-406)", () => {
  it("parses the space-separated form", () => {
    const r = parseDrainArgs([
      "--id",
      "0123456789abcdef0123456789abcdef",
    ]);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.traceId).toBe("0123456789abcdef0123456789abcdef");
  });

  it("parses the equals form", () => {
    const r = parseDrainArgs(["--id=0123456789abcdef0123456789abcdef"]);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.traceId).toBe("0123456789abcdef0123456789abcdef");
  });

  it("errors when --id is missing", () => {
    const r = parseDrainArgs([]);
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.message).toContain("--id");
  });

  it("errors on an unknown flag", () => {
    const r = parseDrainArgs(["--id=deadbeef", "--what", "huh"]);
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.message).toContain("--what");
  });
});
