import { describe, expect, it } from "vitest";
import { parseImplVerdict } from "./implement.js";

// VA-350: IMPL: marker contract for the implement loop. These tests
// pin the parser's behaviour directly, rather than driving it from
// the orchestrator's drainQueue — what we actually care about is the
// parsing rule, and the loop's reaction to each kind is exercised
// elsewhere (orchestrator.test.ts composer integration).

describe("parseImplVerdict (VA-350)", () => {
  it("returns DONE on a trailing IMPL: DONE marker", () => {
    expect(
      parseImplVerdict({ stdout: "all green\n\nIMPL: DONE\n" }),
    ).toEqual({ kind: "done" });
  });

  it("returns BLOCKED with the trailing reason after `—`", () => {
    expect(
      parseImplVerdict({
        stdout:
          "I can't modify .github/workflows under policy.\n\nIMPL: BLOCKED — issue requires CI workflow changes that policy forbids\n",
      }),
    ).toEqual({
      kind: "blocked",
      reason: "issue requires CI workflow changes that policy forbids",
    });
  });

  it("returns BLOCKED with a fallback reason when none is given", () => {
    expect(parseImplVerdict({ stdout: "IMPL: BLOCKED\n" })).toEqual({
      kind: "blocked",
      reason: "no reason given",
    });
  });

  it("returns CONTINUE on a trailing CONTINUE marker", () => {
    expect(parseImplVerdict({ stdout: "still working\nIMPL: CONTINUE\n" }))
      .toEqual({ kind: "continue" });
  });

  it("treats output with no IMPL: marker as missing", () => {
    expect(parseImplVerdict({ stdout: "no marker here" })).toEqual({
      kind: "missing",
    });
  });

  it("uses the LAST marker when several appear across iterations", () => {
    expect(
      parseImplVerdict({
        stdout: "IMPL: CONTINUE\n...next iteration...\nIMPL: DONE\n",
      }),
    ).toEqual({ kind: "done" });
  });
});
