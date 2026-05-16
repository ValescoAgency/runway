import { describe, expect, it } from "vitest";
import {
  MIN_CORROBORATION,
  PROMOTION_BUDGET,
  runPromoter,
  themeKeyOf,
  type OpenPromotedIssue,
  type RecommendationSource,
} from "./promoter.js";
import type { OutOfScopeEntry } from "./out-of-scope.js";
import type { Recommendation } from "./templates.js";

/**
 * VA-408 promoter tests. The PRD's promoter is the load-bearing
 * deterministic surface — these cases nail down the contracts the
 * Weekly Review pass relies on (corroboration threshold, budget cap,
 * tiebreaking, .out-of-scope filter, queue defer).
 */

const rec = (
  target: Recommendation["target"],
  change: string,
  confidence: Recommendation["confidence"] = "MEDIUM",
): Recommendation => ({ target, change, confidence });

const src = (
  identifier: string,
  r: Recommendation,
): RecommendationSource => ({
  sourceMetaReviewIdentifier: identifier,
  recommendation: r,
});

describe("runPromoter — grouping + corroboration", () => {
  it("groups identical changes from different reviews into one theme", () => {
    const out = runPromoter({
      recommendations: [
        src("VA-501", rec("prompt", "tighten reviewer rejection guidance")),
        src("VA-502", rec("prompt", "tighten reviewer rejection guidance")),
        src("VA-503", rec("prompt", "tighten reviewer rejection guidance")),
      ],
      openPromotedQueue: [],
      outOfScopeEntries: [],
    });

    expect(out.candidatePromotions).toHaveLength(1);
    expect(out.candidatePromotions[0]?.corroborationCount).toBe(3);
    expect(out.candidatePromotions[0]?.sourceMetaReviewIdentifiers).toEqual([
      "VA-501",
      "VA-502",
      "VA-503",
    ]);
  });

  it("dedupes corroboration by source identifier — one review can't double-vote", () => {
    const out = runPromoter({
      recommendations: [
        src("VA-501", rec("prompt", "tighten reviewer rejection guidance")),
        src("VA-501", rec("prompt", "tighten reviewer rejection guidance")),
      ],
      openPromotedQueue: [],
      outOfScopeEntries: [],
    });

    expect(out.candidatePromotions).toHaveLength(0);
    expect(out.recurringObservations).toHaveLength(1);
    expect(out.recurringObservations[0]?.corroborationCount).toBe(1);
  });

  it(`buckets themes with < ${MIN_CORROBORATION} corroborations into recurringObservations`, () => {
    const out = runPromoter({
      recommendations: [
        src("VA-501", rec("prompt", "add explicit retry budget guidance")),
      ],
      openPromotedQueue: [],
      outOfScopeEntries: [],
    });

    expect(out.candidatePromotions).toHaveLength(0);
    expect(out.notedButNotPromoted).toHaveLength(0);
    expect(out.recurringObservations).toHaveLength(1);
    expect(out.recurringObservations[0]?.corroborationCount).toBe(1);
  });

  it("escalates max confidence to HIGH if any corroborating recommendation is HIGH", () => {
    const out = runPromoter({
      recommendations: [
        src("VA-501", rec("workflow", "split impl + review into separate spans", "LOW")),
        src("VA-502", rec("workflow", "split impl + review into separate spans", "HIGH")),
        src("VA-503", rec("workflow", "split impl + review into separate spans", "MEDIUM")),
      ],
      openPromotedQueue: [],
      outOfScopeEntries: [],
    });

    expect(out.candidatePromotions[0]?.maxConfidence).toBe("HIGH");
  });
});

describe("runPromoter — ranking + budget cap", () => {
  it(`caps promotions at ${PROMOTION_BUDGET} and overflows the rest with reason="budget-cap"`, () => {
    const recs: RecommendationSource[] = [];
    // 7 distinct themes each with 2 corroborations → 7 > 5 budget
    for (let i = 0; i < 7; i += 1) {
      const change = `change number ${String.fromCharCode(65 + i)} for the system in a meaningful way`;
      recs.push(src(`VA-${500 + i * 2}`, rec("prompt", change, "MEDIUM")));
      recs.push(src(`VA-${500 + i * 2 + 1}`, rec("prompt", change, "MEDIUM")));
    }

    const out = runPromoter({
      recommendations: recs,
      openPromotedQueue: [],
      outOfScopeEntries: [],
    });

    expect(out.candidatePromotions).toHaveLength(PROMOTION_BUDGET);
    const overflowCap = out.notedButNotPromoted.filter(
      (n) => n.reason === "budget-cap",
    );
    expect(overflowCap).toHaveLength(7 - PROMOTION_BUDGET);
  });

  it("ranks descending by confidence × corroboration", () => {
    const out = runPromoter({
      recommendations: [
        // theme A: LOW × 2 = 2
        src("VA-501", rec("prompt", "alpha alpha alpha alpha alpha", "LOW")),
        src("VA-502", rec("prompt", "alpha alpha alpha alpha alpha", "LOW")),
        // theme B: HIGH × 2 = 6
        src("VA-503", rec("workflow", "bravo bravo bravo bravo bravo", "HIGH")),
        src("VA-504", rec("workflow", "bravo bravo bravo bravo bravo", "HIGH")),
        // theme C: MEDIUM × 3 = 6
        src("VA-505", rec("sandcastle", "charlie charlie charlie charlie", "MEDIUM")),
        src("VA-506", rec("sandcastle", "charlie charlie charlie charlie", "MEDIUM")),
        src("VA-507", rec("sandcastle", "charlie charlie charlie charlie", "MEDIUM")),
      ],
      openPromotedQueue: [],
      outOfScopeEntries: [],
    });

    expect(out.candidatePromotions).toHaveLength(3);
    // B and C tie at score 6 — break by alphabetic theme_key.
    // A is below with score 2.
    expect(out.candidatePromotions[2]?.rankingScore).toBe(2);
    expect(out.candidatePromotions[0]?.rankingScore).toBe(6);
    expect(out.candidatePromotions[1]?.rankingScore).toBe(6);
  });

  it("breaks ties deterministically on theme_key alphabetic order", () => {
    // Run twice — output must be byte-identical.
    const input = {
      recommendations: [
        src("VA-501", rec("prompt", "zzz zzz zzz zzz zzz zzz zzz", "MEDIUM")),
        src("VA-502", rec("prompt", "zzz zzz zzz zzz zzz zzz zzz", "MEDIUM")),
        src("VA-503", rec("workflow", "aaa aaa aaa aaa aaa aaa aaa", "MEDIUM")),
        src("VA-504", rec("workflow", "aaa aaa aaa aaa aaa aaa aaa", "MEDIUM")),
      ],
      openPromotedQueue: [],
      outOfScopeEntries: [],
    };
    const a = runPromoter(input);
    const b = runPromoter(input);
    expect(a.candidatePromotions.map((c) => c.themeKey)).toEqual(
      b.candidatePromotions.map((c) => c.themeKey),
    );
    // "prompt:..." sorts before "workflow:..." alphabetically.
    expect(a.candidatePromotions[0]?.themeKey.startsWith("prompt:")).toBe(true);
  });
});

describe("runPromoter — out-of-scope filter", () => {
  it("filters themes whose fragment matches an .out-of-scope/ rationale", () => {
    const entries: OutOfScopeEntry[] = [
      {
        filename: "rejected-retry-budget.md",
        normalizedBody: "add explicit retry budget guidance to coding agent",
      },
    ];

    const out = runPromoter({
      recommendations: [
        src("VA-501", rec("prompt", "add explicit retry budget guidance to coding agent")),
        src("VA-502", rec("prompt", "add explicit retry budget guidance to coding agent")),
        src("VA-503", rec("workflow", "split impl plus review into separate spans")),
        src("VA-504", rec("workflow", "split impl plus review into separate spans")),
      ],
      openPromotedQueue: [],
      outOfScopeEntries: entries,
    });

    // Out-of-scope theme is filtered (becomes a noted entry); the
    // other theme promotes cleanly.
    expect(out.candidatePromotions).toHaveLength(1);
    expect(out.candidatePromotions[0]?.target).toBe("workflow");
    const oosFiltered = out.notedButNotPromoted.filter(
      (n) => n.reason === "out-of-scope",
    );
    expect(oosFiltered).toHaveLength(1);
    expect(oosFiltered[0]?.outOfScopeFilename).toBe("rejected-retry-budget.md");
  });
});

describe("runPromoter — queue defer", () => {
  it("defers themes whose theme_key matches an open promoted-queue entry", () => {
    const themeRec = rec(
      "prompt",
      "tighten reviewer rejection guidance for refactor-class issues",
    );
    const openIssue: OpenPromotedIssue = {
      identifier: "VA-700",
      themeKey: themeKeyOf(themeRec),
    };

    const out = runPromoter({
      recommendations: [
        src("VA-501", themeRec),
        src("VA-502", themeRec),
      ],
      openPromotedQueue: [openIssue],
      outOfScopeEntries: [],
    });

    expect(out.candidatePromotions).toHaveLength(0);
    const deferred = out.notedButNotPromoted.filter(
      (n) => n.reason === "deferred-open-promotion",
    );
    expect(deferred).toHaveLength(1);
    expect(deferred[0]?.deferredBehind).toBe("VA-700");
  });

  it("doesn't defer themes whose key doesn't match the open queue", () => {
    const openIssue: OpenPromotedIssue = {
      identifier: "VA-700",
      themeKey: "prompt:some other unrelated theme:abcd1234",
    };

    const out = runPromoter({
      recommendations: [
        src("VA-501", rec("prompt", "tighten reviewer rejection guidance for refactor issues")),
        src("VA-502", rec("prompt", "tighten reviewer rejection guidance for refactor issues")),
      ],
      openPromotedQueue: [openIssue],
      outOfScopeEntries: [],
    });

    expect(out.candidatePromotions).toHaveLength(1);
  });
});

describe("themeKeyOf — stability across runs", () => {
  it("produces stable keys for identical recommendations", () => {
    const r = rec("prompt", "tighten reviewer rejection guidance");
    expect(themeKeyOf(r)).toBe(themeKeyOf(r));
  });

  it("produces distinct keys for different targets even with same change text", () => {
    expect(themeKeyOf(rec("prompt", "improve X"))).not.toBe(
      themeKeyOf(rec("workflow", "improve X")),
    );
  });

  it("produces distinct keys for different change text (full hash separation)", () => {
    expect(themeKeyOf(rec("prompt", "improve X"))).not.toBe(
      themeKeyOf(rec("prompt", "improve Y")),
    );
  });

  it("normalizes whitespace + case so trivial drift doesn't fork keys", () => {
    expect(themeKeyOf(rec("prompt", "Improve   X "))).toBe(
      themeKeyOf(rec("prompt", "improve x")),
    );
  });
});
