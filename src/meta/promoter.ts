import { createHash } from "node:crypto";
import {
  findMatchingOutOfScope,
  normalize,
  type OutOfScopeEntry,
} from "./out-of-scope.js";
import type {
  Recommendation,
  RecommendationTarget,
} from "./templates.js";

/**
 * VA-408: pattern detection + budget logic for the Weekly Review.
 *
 * Runs BEFORE the LLM. The flow:
 *
 *   1. Pull every Recommendation row from the week's Run + Drain
 *      Reviews (input: `RecommendationSource[]`).
 *   2. Group by structural pattern key: `target + ":" + first-N-chars-
 *      of-change`. The PRD's "deterministic tiebreak on theme
 *      identifier" hinges on this key being stable across runs.
 *   3. For each theme, count corroborating Reviews. Themes with
 *      < MIN_CORROBORATION (2) get bucketed into the recurring-themes
 *      observation set but DON'T get promoted.
 *   4. Filter themes whose fragments overlap with any `.out-of-scope/`
 *      rationale.
 *   5. Filter themes whose target + theme-key matches an open
 *      `runway-meta-promoted` issue (defer-don't-pile-on).
 *   6. Rank the remaining themes by `confidence × corroboration`
 *      (deterministic tiebreak: theme_key alphabetic).
 *   7. Top BUDGET (5) become candidate promotions; the rest become
 *      `noted_but_not_promoted` with reason `budget-cap`.
 *
 * The LLM then receives the candidate promotion set + overflow +
 * deferred + out-of-scope filtered set and writes the qualitative
 * surfaces (predicted-effect, acceptance criteria, narrative prose).
 *
 * Module is pure: takes data, returns data. Testable in isolation.
 */

// ---------------------------------------------------------------------------
// Tunable constants — load-bearing for the AC's spec
// ---------------------------------------------------------------------------

/** VA-408 AC: "requires ≥ 2 corroborating Run Reviews per theme". */
export const MIN_CORROBORATION = 2;

/** VA-408 AC: "emits top 5 to the *Promotions* block". */
export const PROMOTION_BUDGET = 5;

/**
 * Length of the normalized change fragment used as the theme-key
 * suffix. 60 chars is a balance between "enough text to disambiguate
 * different prompt changes" and "short enough that minor LLM phrasing
 * drift doesn't fork the key across weeks". This is the load-bearing
 * stability knob for the AC's "deterministic tiebreak on theme
 * identifier" — bumping it after release would re-cluster themes.
 */
const THEME_KEY_FRAGMENT_LEN = 60;

const CONFIDENCE_SCORE: Record<Recommendation["confidence"], number> = {
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * One recommendation as the promoter sees it. Wraps the raw
 * `Recommendation` shape (target / change / confidence) with the
 * source-review identifier so the promoter can list which Reviews
 * corroborated each theme in the output.
 */
export interface RecommendationSource {
  /** Linear identifier of the source Run / Drain Review (e.g. `VA-501`). */
  readonly sourceMetaReviewIdentifier: string;
  readonly recommendation: Recommendation;
}

/**
 * VA-408: representation of one open `runway-meta-promoted` issue the
 * promoter checks against when deciding whether to defer a theme. The
 * `themeKey` field is parsed by the Weekly Review pass from the
 * issue's `runway-meta-theme-key:` HTML-comment marker (stamped on
 * the prior week's promotion).
 */
export interface OpenPromotedIssue {
  readonly identifier: string;
  readonly themeKey: string;
}

export interface PromoterInput {
  readonly recommendations: readonly RecommendationSource[];
  readonly openPromotedQueue: readonly OpenPromotedIssue[];
  readonly outOfScopeEntries: readonly OutOfScopeEntry[];
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/**
 * VA-408: a theme that survived corroboration + filters + ranking and
 * is offered to the LLM as a promotion candidate. The LLM may choose
 * to keep it (in which case it appears in the parsed
 * `WeeklyReview.promotions`) or downgrade it to "noted but not
 * promoted" with a `low-confidence` reason on qualitative grounds.
 */
export interface CandidatePromotion {
  readonly themeKey: string;
  readonly target: RecommendationTarget;
  readonly representativeChange: string;
  readonly corroborationCount: number;
  /** Highest confidence observed across the corroborating recommendations. */
  readonly maxConfidence: Recommendation["confidence"];
  readonly rankingScore: number;
  readonly sourceMetaReviewIdentifiers: readonly string[];
}

/**
 * VA-408: a theme that was eligible but got bumped — either by the
 * budget cap, deferred behind an open promotion, or filtered by
 * `.out-of-scope/`. Passed to the LLM as an input so the
 * `noted_but_not_promoted` block in the Weekly Review can render with
 * the reason annotation.
 */
export interface FilteredTheme {
  readonly themeKey: string;
  readonly target: RecommendationTarget;
  readonly representativeChange: string;
  readonly corroborationCount: number;
  readonly reason:
    | "budget-cap"
    | "deferred-open-promotion"
    | "out-of-scope";
  readonly deferredBehind: string | null;
  readonly outOfScopeFilename: string | null;
}

/**
 * VA-408: theme that didn't meet the >= 2 corroboration threshold.
 * Appears in the Weekly Review's recurring-themes prose surface so
 * the operator sees pre-emergent patterns but does NOT get promoted
 * or noted as a rejected candidate.
 */
export interface RecurringObservation {
  readonly themeKey: string;
  readonly target: RecommendationTarget;
  readonly representativeChange: string;
  readonly corroborationCount: number;
}

export interface PromoterOutput {
  readonly candidatePromotions: readonly CandidatePromotion[];
  readonly notedButNotPromoted: readonly FilteredTheme[];
  readonly recurringObservations: readonly RecurringObservation[];
}

// ---------------------------------------------------------------------------
// Core algorithm
// ---------------------------------------------------------------------------

interface InternalTheme {
  readonly themeKey: string;
  readonly target: RecommendationTarget;
  readonly representativeChange: string;
  readonly corroborationCount: number;
  readonly maxConfidence: Recommendation["confidence"];
  readonly sourceMetaReviewIdentifiers: readonly string[];
}

export function runPromoter(input: PromoterInput): PromoterOutput {
  const themes = groupIntoThemes(input.recommendations);

  // Recurring observations: themes with < MIN_CORROBORATION. These
  // never make it to the candidate / filtered buckets — they're a
  // narrative-only surface so the operator can spot emergent patterns.
  const recurringObservations: RecurringObservation[] = [];
  const corroborated: InternalTheme[] = [];
  for (const theme of themes) {
    if (theme.corroborationCount < MIN_CORROBORATION) {
      recurringObservations.push({
        themeKey: theme.themeKey,
        target: theme.target,
        representativeChange: theme.representativeChange,
        corroborationCount: theme.corroborationCount,
      });
    } else {
      corroborated.push(theme);
    }
  }

  // Out-of-scope filter — themes overlapping a prior rejection
  // rationale get bucketed before ranking. PRD: "themes that match a
  // prior rejection rationale are filtered out before ranking".
  const oosFiltered: FilteredTheme[] = [];
  const afterOos: InternalTheme[] = [];
  for (const theme of corroborated) {
    const fragment = normalize(theme.representativeChange);
    const match = findMatchingOutOfScope(fragment, input.outOfScopeEntries);
    if (match) {
      oosFiltered.push({
        themeKey: theme.themeKey,
        target: theme.target,
        representativeChange: theme.representativeChange,
        corroborationCount: theme.corroborationCount,
        reason: "out-of-scope",
        deferredBehind: null,
        outOfScopeFilename: match.filename,
      });
    } else {
      afterOos.push(theme);
    }
  }

  // Defer-behind-open-promotion: a theme whose key matches an open
  // promoted-queue item gets noted as deferred. PRD: "doesn't pile on
  // duplicates while previous promotions are still pending".
  const openByKey = new Map<string, OpenPromotedIssue>();
  for (const open of input.openPromotedQueue) {
    openByKey.set(open.themeKey, open);
  }
  const deferred: FilteredTheme[] = [];
  const afterDefer: InternalTheme[] = [];
  for (const theme of afterOos) {
    const open = openByKey.get(theme.themeKey);
    if (open) {
      deferred.push({
        themeKey: theme.themeKey,
        target: theme.target,
        representativeChange: theme.representativeChange,
        corroborationCount: theme.corroborationCount,
        reason: "deferred-open-promotion",
        deferredBehind: open.identifier,
        outOfScopeFilename: null,
      });
    } else {
      afterDefer.push(theme);
    }
  }

  // Rank by score, deterministic tiebreak on theme key (alphabetic).
  const ranked = [...afterDefer].sort((a, b) => {
    const scoreA = rankingScore(a);
    const scoreB = rankingScore(b);
    if (scoreA !== scoreB) return scoreB - scoreA; // descending score
    return a.themeKey < b.themeKey ? -1 : a.themeKey > b.themeKey ? 1 : 0;
  });

  // Top BUDGET become candidates; the rest become budget-cap overflow.
  const candidatePromotions: CandidatePromotion[] = ranked
    .slice(0, PROMOTION_BUDGET)
    .map((t) => ({
      themeKey: t.themeKey,
      target: t.target,
      representativeChange: t.representativeChange,
      corroborationCount: t.corroborationCount,
      maxConfidence: t.maxConfidence,
      rankingScore: rankingScore(t),
      sourceMetaReviewIdentifiers: t.sourceMetaReviewIdentifiers,
    }));
  const overflow: FilteredTheme[] = ranked.slice(PROMOTION_BUDGET).map((t) => ({
    themeKey: t.themeKey,
    target: t.target,
    representativeChange: t.representativeChange,
    corroborationCount: t.corroborationCount,
    reason: "budget-cap" as const,
    deferredBehind: null,
    outOfScopeFilename: null,
  }));

  return {
    candidatePromotions,
    notedButNotPromoted: [...overflow, ...deferred, ...oosFiltered],
    recurringObservations,
  };
}

/**
 * VA-408: compute the stable theme key for a recommendation. Exported
 * so the Weekly Review pass can compute the same key when stamping
 * promoted issue bodies (so the next week's promoter recognizes the
 * open queue entry by matching keys exactly).
 */
export function themeKeyOf(rec: Recommendation): string {
  const fragment = normalize(rec.change).slice(0, THEME_KEY_FRAGMENT_LEN);
  // Append a short hash of the full normalized change so two themes
  // with identical first-60-chars but distinct tails (rare but
  // possible — e.g. "tighten reviewer prompt to require X" vs "tighten
  // reviewer prompt to require Y" if the prefix runs to 60 chars) get
  // distinct keys. The 8-char hex hash gives ~32 bits of separation,
  // plenty for the scale of a single Weekly Review.
  const hash = createHash("sha256")
    .update(normalize(rec.change))
    .digest("hex")
    .slice(0, 8);
  return `${rec.target}:${fragment}:${hash}`;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function groupIntoThemes(
  recs: readonly RecommendationSource[],
): readonly InternalTheme[] {
  const buckets = new Map<
    string,
    {
      target: RecommendationTarget;
      representativeChange: string;
      sources: string[];
      maxConfidence: Recommendation["confidence"];
    }
  >();

  for (const src of recs) {
    const key = themeKeyOf(src.recommendation);
    const existing = buckets.get(key);
    if (existing) {
      // Dedupe by source identifier — a Run Review that recommended
      // the same change twice would otherwise double-corroborate.
      // First-write-wins on the representative change string so the
      // theme description stays stable across the run.
      if (!existing.sources.includes(src.sourceMetaReviewIdentifier)) {
        existing.sources.push(src.sourceMetaReviewIdentifier);
      }
      if (
        CONFIDENCE_SCORE[src.recommendation.confidence] >
        CONFIDENCE_SCORE[existing.maxConfidence]
      ) {
        existing.maxConfidence = src.recommendation.confidence;
      }
    } else {
      buckets.set(key, {
        target: src.recommendation.target,
        representativeChange: src.recommendation.change,
        sources: [src.sourceMetaReviewIdentifier],
        maxConfidence: src.recommendation.confidence,
      });
    }
  }

  const themes: InternalTheme[] = [];
  for (const [themeKey, bucket] of buckets.entries()) {
    // Deterministic source ordering — alphabetic by identifier — so
    // the same input always produces the same output. Test
    // determinism + diff readability.
    const sorted = [...bucket.sources].sort();
    themes.push({
      themeKey,
      target: bucket.target,
      representativeChange: bucket.representativeChange,
      corroborationCount: sorted.length,
      maxConfidence: bucket.maxConfidence,
      sourceMetaReviewIdentifiers: sorted,
    });
  }
  return themes;
}

function rankingScore(theme: InternalTheme): number {
  return CONFIDENCE_SCORE[theme.maxConfidence] * theme.corroborationCount;
}
