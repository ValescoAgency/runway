import { describe, expect, it } from "vitest";
import {
  computeVerdict,
  parsePredictedEffectFromBody,
  parseSourceMetaReviewIdentifiers,
} from "./attribution.js";
import {
  RUNWAY_META_PREDICTED_EFFECT_MARKER,
  type PredictedEffect,
} from "./templates.js";

// VA-409: attribution loop pure-function tests. Covers the contract
// every shipped promotion runs through before landing in the *What we
// shipped* section:
//
//   1. Body parsing: v1.1.0 marker round-trip, v1.0.0 markdown fallback,
//      and the "no readable shape" → null branch.
//   2. Verdict: each of HELD / PARTIAL / MISSED / PENDING / QUALITATIVE
//      on fixture data, with the AC-named comment phrasing locked.

// ---------------------------------------------------------------------------
// parsePredictedEffectFromBody
// ---------------------------------------------------------------------------

describe("parsePredictedEffectFromBody (VA-409)", () => {
  it("parses the v1.1.0 marker carrying the full predicted_effect JSON", () => {
    const pe: PredictedEffect = {
      claim: "Rejection rate falls below 8%.",
      min_sample_size: 10,
      sample_description: "post-ship VA-prefixed runs",
      attribution: {
        metric: "reviewer_rejection_rate",
        baseline_value: 0.12,
        direction: "decrease",
        threshold_value: 0.08,
      },
    };
    const body = [
      `<!-- ${RUNWAY_META_PREDICTED_EFFECT_MARKER}: ${JSON.stringify(pe)} -->`,
      "",
      "Some markdown narrative here.",
    ].join("\n");
    const parsed = parsePredictedEffectFromBody(body);
    expect(parsed).not.toBeNull();
    expect(parsed?.claim).toBe(pe.claim);
    expect(parsed?.min_sample_size).toBe(10);
    expect(parsed?.attribution?.metric).toBe("reviewer_rejection_rate");
    expect(parsed?.attribution?.direction).toBe("decrease");
    expect(parsed?.attribution?.threshold_value).toBe(0.08);
  });

  it("preferes the marker over the markdown fallback when both are present", () => {
    // Marker says n=10; markdown body says n=20. Marker wins.
    const pe: PredictedEffect = {
      claim: "Marker-supplied claim",
      min_sample_size: 10,
      sample_description: "marker samples",
    };
    const body = [
      `<!-- ${RUNWAY_META_PREDICTED_EFFECT_MARKER}: ${JSON.stringify(pe)} -->`,
      "",
      "## Predicted effect",
      "",
      "> **Claim**: Markdown-supplied claim",
      "> **Minimum sample size**: n ≥ 20 markdown samples",
    ].join("\n");
    const parsed = parsePredictedEffectFromBody(body);
    expect(parsed?.claim).toBe("Marker-supplied claim");
    expect(parsed?.min_sample_size).toBe(10);
  });

  it("falls back to the markdown body when the marker is absent (legacy v1.0.0 promotion)", () => {
    const body = [
      "## Predicted effect",
      "",
      "> **Claim**: Reviewer rejection-to-fix iteration count drops 20% vs baseline",
      "> **Minimum sample size**: n ≥ 10 post-ship runs of refactor-class issues",
    ].join("\n");
    const parsed = parsePredictedEffectFromBody(body);
    expect(parsed).not.toBeNull();
    expect(parsed?.claim).toContain("rejection-to-fix");
    expect(parsed?.min_sample_size).toBe(10);
    expect(parsed?.sample_description).toBe(
      "post-ship runs of refactor-class issues",
    );
    // No attribution block from the markdown fallback — verdict will
    // fall through to QUALITATIVE.
    expect(parsed?.attribution).toBeUndefined();
  });

  it("accepts `n >= N` (ascii) as well as `n ≥ N` (unicode) in the markdown", () => {
    const body = [
      "> **Claim**: ASCII comparator",
      "> **Minimum sample size**: n >= 7 post-ship runs",
    ].join("\n");
    const parsed = parsePredictedEffectFromBody(body);
    expect(parsed?.min_sample_size).toBe(7);
  });

  it("returns null when neither the marker nor the markdown shape is present", () => {
    const body = "Hand-edited body without any predicted-effect surface.";
    expect(parsePredictedEffectFromBody(body)).toBeNull();
  });

  it("returns null on a malformed marker JSON (not crash)", () => {
    const body = [
      `<!-- ${RUNWAY_META_PREDICTED_EFFECT_MARKER}: {not valid json} -->`,
    ].join("\n");
    expect(parsePredictedEffectFromBody(body)).toBeNull();
  });

  it("drops a marker attribution block with an unknown metric (falls back to base shape)", () => {
    const body = [
      `<!-- ${RUNWAY_META_PREDICTED_EFFECT_MARKER}: ${JSON.stringify({
        claim: "x",
        min_sample_size: 5,
        sample_description: "s",
        attribution: {
          metric: "vibes_per_drain",
          baseline_value: 1,
          direction: "increase",
          threshold_value: 5,
        },
      })} -->`,
    ].join("\n");
    const parsed = parsePredictedEffectFromBody(body);
    expect(parsed).not.toBeNull();
    expect(parsed?.attribution).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// computeVerdict
// ---------------------------------------------------------------------------

const heldDecrease: PredictedEffect = {
  claim: "Rejection rate falls below 8%.",
  min_sample_size: 10,
  sample_description: "post-ship VA-prefixed runs",
  attribution: {
    metric: "reviewer_rejection_rate",
    baseline_value: 0.12,
    direction: "decrease",
    threshold_value: 0.08,
  },
};

const heldIncrease: PredictedEffect = {
  claim: "Median iteration count rises above 4.",
  min_sample_size: 5,
  sample_description: "post-ship runs",
  attribution: {
    metric: "median_iteration_count",
    baseline_value: 3,
    direction: "increase",
    threshold_value: 4,
  },
};

const qualitative: PredictedEffect = {
  claim: "Issue bodies cite the new style guide.",
  min_sample_size: 5,
  sample_description: "newly-filed issues",
};

describe("computeVerdict (VA-409)", () => {
  it("HELD when observed meets the decrease threshold at the declared sample size", () => {
    const r = computeVerdict({
      predictedEffect: heldDecrease,
      observedValue: 0.06,
      observedSampleSize: 15,
    });
    expect(r.verdict).toBe("HELD");
    expect(r.observedValue).toBe(0.06);
    expect(r.comment).toContain("HELD");
    expect(r.comment).toContain("reviewer_rejection_rate");
  });

  it("HELD when observed meets the increase threshold", () => {
    const r = computeVerdict({
      predictedEffect: heldIncrease,
      observedValue: 4.5,
      observedSampleSize: 12,
    });
    expect(r.verdict).toBe("HELD");
  });

  it("HELD at exact threshold (`<=` and `>=`, not strict)", () => {
    // decrease branch: observed exactly equals threshold → HELD.
    const exactDecrease = computeVerdict({
      predictedEffect: heldDecrease,
      observedValue: 0.08,
      observedSampleSize: 10,
    });
    expect(exactDecrease.verdict).toBe("HELD");
    // increase branch: observed exactly equals threshold → HELD.
    const exactIncrease = computeVerdict({
      predictedEffect: heldIncrease,
      observedValue: 4,
      observedSampleSize: 5,
    });
    expect(exactIncrease.verdict).toBe("HELD");
  });

  it("PARTIAL when observed moved toward threshold but didn't reach (decrease)", () => {
    const r = computeVerdict({
      predictedEffect: heldDecrease,
      observedValue: 0.1, // 0.12 baseline → 0.1 observed → past baseline, not under 0.08 threshold
      observedSampleSize: 12,
    });
    expect(r.verdict).toBe("PARTIAL");
    expect(r.comment).toContain("PARTIAL");
    expect(r.comment).toContain("baseline");
  });

  it("PARTIAL when observed moved toward threshold but didn't reach (increase)", () => {
    const r = computeVerdict({
      predictedEffect: heldIncrease,
      observedValue: 3.5, // 3 → 3.5 → past baseline, not at 4 threshold
      observedSampleSize: 6,
    });
    expect(r.verdict).toBe("PARTIAL");
  });

  it("MISSED when observed did not move past baseline", () => {
    const noMovement = computeVerdict({
      predictedEffect: heldDecrease,
      observedValue: 0.12, // exactly baseline → no movement
      observedSampleSize: 10,
    });
    expect(noMovement.verdict).toBe("MISSED");
    expect(noMovement.comment).toContain("MISSED");
  });

  it("MISSED when observed moved the wrong way (decrease prediction, value went up)", () => {
    const r = computeVerdict({
      predictedEffect: heldDecrease,
      observedValue: 0.15, // 0.12 → 0.15 → got worse
      observedSampleSize: 10,
    });
    expect(r.verdict).toBe("MISSED");
  });

  it("PENDING when post-ship sample is below min_sample_size", () => {
    const r = computeVerdict({
      predictedEffect: heldDecrease,
      observedValue: 0.04,
      observedSampleSize: 3,
    });
    expect(r.verdict).toBe("PENDING");
    // AC: "PENDING — n=X of Y needed" phrasing locked.
    expect(r.comment).toMatch(/PENDING\s*—\s*n=3\s+of\s+10\s+needed/);
  });

  it("PENDING fires even when observed value is zero or null (insufficient data)", () => {
    const r = computeVerdict({
      predictedEffect: heldDecrease,
      observedValue: null,
      observedSampleSize: 0,
    });
    expect(r.verdict).toBe("PENDING");
  });

  it("QUALITATIVE when predicted_effect has no attribution block", () => {
    const r = computeVerdict({
      predictedEffect: qualitative,
      observedValue: null,
      observedSampleSize: 0,
    });
    expect(r.verdict).toBe("QUALITATIVE");
    // AC: "verdict reads `QUALITATIVE — operator review needed`"
    expect(r.comment).toContain("QUALITATIVE — operator review needed");
    // AC: "with the observable evidence quoted" — the predicted claim
    // is the IRA's pre-ship statement of what should happen, which is
    // what the operator compares observed evidence against.
    expect(r.comment).toContain(qualitative.claim);
  });

  it("MISSED (not PENDING) when sample met the bar but observed value is null (defensive)", () => {
    // Shouldn't happen in practice — the read-model can't report
    // sample_size>=N with a null value — but we lock the conservative
    // mapping so the verdict is never a silent PENDING.
    const r = computeVerdict({
      predictedEffect: heldDecrease,
      observedValue: null,
      observedSampleSize: 15,
    });
    expect(r.verdict).toBe("MISSED");
  });
});

// ---------------------------------------------------------------------------
// parseSourceMetaReviewIdentifiers
// ---------------------------------------------------------------------------

describe("parseSourceMetaReviewIdentifiers (VA-409)", () => {
  it("parses the markdown-link form", () => {
    const body = [
      "**Target taxonomy**: `prompt`",
      "**Source meta-reviews**: [VA-1001](https://linear.app/x/issue/VA-1001), [VA-1002](https://linear.app/x/issue/VA-1002)",
      "",
    ].join("\n");
    expect(parseSourceMetaReviewIdentifiers(body)).toEqual([
      "VA-1001",
      "VA-1002",
    ]);
  });

  it("falls back to bare comma-separated identifiers when no links present", () => {
    const body = "**Source meta-reviews**: VA-1001, VA-1002, VA-1003";
    expect(parseSourceMetaReviewIdentifiers(body)).toEqual([
      "VA-1001",
      "VA-1002",
      "VA-1003",
    ]);
  });

  it("returns empty array when the line is absent", () => {
    expect(parseSourceMetaReviewIdentifiers("no marker here")).toEqual([]);
  });
});
