import { describe, expect, it } from "vitest";
import { parseReviewVerdict } from "./review.js";

// VA-353 / VA-418: review verdict parser. These tests pin the parsing
// rule (last-marker-wins, line-anchored, missing-distinct-from-rejected,
// rejected split into retry vs hitl) against real sandcastle output
// shapes; the orchestrator's reaction to each verdict kind is exercised
// in the composer integration tests.

describe("parseReviewVerdict (VA-353 / VA-418)", () => {
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

  it("legacy bare REVIEW: REJECTED maps to rejected-retry (VA-418 back-compat)", () => {
    // Pre-VA-418 prompts emit `REVIEW: REJECTED — <reason>` without
    // the -RETRY / -HITL suffix. Parsing maps that to rejected-retry
    // so existing review behavior degrades gracefully into the new
    // retry flow without a prompt update being required. The retry
    // budget caps the blast radius.
    expect(parseReviewVerdict({ stdout: va312Tail })).toEqual({
      kind: "rejected-retry",
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
      "REVIEW: REJECTED-RETRY — withAudit swallows errors",
    ].join("\n");
    expect(parseReviewVerdict({ stdout })).toEqual({
      kind: "rejected-retry",
      reason: "withAudit swallows errors",
    });
  });

  it("REVIEW: REJECTED-RETRY parses as kind=rejected-retry (VA-418)", () => {
    const stdout = [
      "The diff fixes the lookup, but lex-compares ISO-8601 against SQLite datetimes.",
      "REVIEW: REJECTED-RETRY — normalize both timestamps to one format before the freshness comparison",
      "Run complete.",
    ].join("\n");
    expect(parseReviewVerdict({ stdout })).toEqual({
      kind: "rejected-retry",
      reason:
        "normalize both timestamps to one format before the freshness comparison",
    });
  });

  it("REVIEW: REJECTED-HITL parses as kind=rejected-hitl (VA-418)", () => {
    const stdout = [
      "The diff replaces the LinearGateway with a REST shim; that's outside scope and contradicts the SDK-only direction.",
      "REVIEW: REJECTED-HITL — diff implements a different feature than the issue describes; needs a product call",
    ].join("\n");
    expect(parseReviewVerdict({ stdout })).toEqual({
      kind: "rejected-hitl",
      reason:
        "diff implements a different feature than the issue describes; needs a product call",
    });
  });

  it("provides a fallback reason for REJECTED-RETRY with no `— reason` suffix", () => {
    expect(parseReviewVerdict({ stdout: "REVIEW: REJECTED-RETRY" })).toEqual({
      kind: "rejected-retry",
      reason: "no reason given",
    });
  });

  it("provides a fallback reason for REJECTED-HITL with no `— reason` suffix", () => {
    expect(parseReviewVerdict({ stdout: "REVIEW: REJECTED-HITL" })).toEqual({
      kind: "rejected-hitl",
      reason: "no reason given",
    });
  });

  it("the most recent of mixed RETRY / HITL markers wins (last-marker rule)", () => {
    const stdout = [
      "Initially I thought this needed a human.",
      "REVIEW: REJECTED-HITL — wrong direction",
      "On a closer look the fix is mechanical.",
      "REVIEW: REJECTED-RETRY — add the missing guard",
    ].join("\n");
    expect(parseReviewVerdict({ stdout })).toEqual({
      kind: "rejected-retry",
      reason: "add the missing guard",
    });
  });
});
