import { describe, expect, it } from "vitest";
import { parseRunArgs } from "./review.js";

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
});
