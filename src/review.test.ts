import { describe, expect, it } from "vitest";
import { parseReviewVerdict } from "./review.js";

// VA-353: review verdict parser. These tests pin the parsing rule
// (last-marker-wins, line-anchored, missing-distinct-from-rejected)
// against real sandcastle output shapes; the orchestrator's reaction
// to each verdict kind is exercised in the composer integration tests.

describe("parseReviewVerdict (VA-353)", () => {
  // Exact reproducer from .sandcastle/logs/master-review-va-312.log
  // (truncated). Sandcastle's wrapper output ("Agent stopped",
  // "Capturing session", "Run complete: …") trails the marker.
  const va312Tail = [
    "REVIEW: REJECTED — provisionHousehold has a TOCTOU race that creates duplicate households with no DB-level guard (missing unique index on owner role), and withAudit error path can swallow original errors",
    "Agent stopped",
    "Capturing session",
    "Collecting commits",
    "Collecting commits done (0.0s)",
    "Reached max iterations (1).",
    "Run complete: reached 1 iteration(s) without completion signal.",
    "Context window: 58k",
  ].join("\n");

  it("recovers REVIEW: REJECTED with reason when sandcastle wrapper output trails the marker", () => {
    expect(parseReviewVerdict({ stdout: va312Tail })).toEqual({
      kind: "rejected",
      reason:
        "provisionHousehold has a TOCTOU race that creates duplicate households with no DB-level guard (missing unique index on owner role), and withAudit error path can swallow original errors",
    });
  });

  it("recovers REVIEW: APPROVED when sandcastle wrapper output trails the marker", () => {
    const stdout = [
      "Looks good, all tests pass.",
      "REVIEW: APPROVED",
      "Agent stopped",
      "Run complete: reached 1 iteration(s) without completion signal.",
    ].join("\n");
    expect(parseReviewVerdict({ stdout })).toEqual({
      kind: "approved",
      reason: "",
    });
  });

  it("returns kind=missing when the agent never emitted a verdict (VA-360)", () => {
    // VA-360 distinguishes "no marker found" from "agent rejected".
    // Pre-VA-360 this returned `{ kind: "rejected", reason: "…no
    // REVIEW: verdict line" }` and the orchestrator treated a
    // truncated / crashed review the same as a real rejection.
    expect(parseReviewVerdict({ stdout: "i forgot to emit anything useful" }))
      .toEqual({
        kind: "missing",
        reason: "review output did not contain a REVIEW: verdict line",
      });
  });

  it("returns kind=missing for a marker in mid-prose (not at line start)", () => {
    // The reviewer is discussing the contract, not emitting it.
    const stdout =
      "I should remind the agent: the reviewer should output REVIEW: APPROVED when…";
    expect(parseReviewVerdict({ stdout })).toMatchObject({
      kind: "missing",
      reason: "review output did not contain a REVIEW: verdict line",
    });
  });

  it("when multiple markers appear, the LAST one wins", () => {
    const stdout = [
      "Initial pass: REVIEW: APPROVED",
      "On second look I see a bug.",
      "REVIEW: REJECTED — withAudit swallows errors",
    ].join("\n");
    expect(parseReviewVerdict({ stdout })).toEqual({
      kind: "rejected",
      reason: "withAudit swallows errors",
    });
  });
});
