import {
  RUNWAY_META_PREDICTED_EFFECT_MARKER,
  type AttributionMetric,
  type PredictedEffect,
  type Verdict,
} from "./templates.js";

/**
 * VA-409: extract the source meta-review identifiers stamped by
 * `renderPromotionMarkdown` into the body's `**Source meta-reviews**`
 * line. The line carries them as a comma-separated list of either
 * markdown links (`[VA-1001](url), [VA-1002](url)`) or bare
 * identifiers (`VA-1001, VA-1002`) when the URL wasn't known at
 * promotion time. We grep both shapes.
 *
 * Returns an empty array when the line isn't present — the body was
 * hand-edited or pre-dates the marker convention. The shipped
 * promotion still renders, just without cross-links.
 */
export function parseSourceMetaReviewIdentifiers(
  body: string,
): readonly string[] {
  const lineMatch = /\*\*Source meta-reviews\*\*:\s*([^\n]+)/.exec(body);
  if (!lineMatch || !lineMatch[1]) return [];
  const line = lineMatch[1];
  const out: string[] = [];
  // Match markdown-link form first: `[VA-1001](https://...)`. Greedy
  // matching grabs every link.
  const linkRe = /\[([^\]]+)\]\([^)]+\)/g;
  let linkMatch: RegExpExecArray | null;
  while ((linkMatch = linkRe.exec(line)) !== null) {
    if (linkMatch[1]) out.push(linkMatch[1].trim());
  }
  if (out.length > 0) return out;
  // Fall back to bare comma-separated identifiers.
  return line
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * VA-409: attribution loop — pure functions that grade shipped
 * promotions against their predicted effects.
 *
 * Two responsibilities, both kept pure so the Weekly Review pass can
 * mechanically compute verdicts before the LLM authors narrative:
 *
 *   1. **Parse the predicted effect off a runway-repo issue body.**
 *      v1.1.0 promotions stamp a structured JSON blob via the
 *      `runway-meta-predicted-effect` HTML comment marker; v1.0.0
 *      promotions (pre-VA-409) only emitted the human-readable
 *      markdown body. We try the marker first, then fall back to a
 *      regex over the `**Claim**` / `**Minimum sample size**` lines —
 *      both layers must round-trip the same `PredictedEffect` shape so
 *      `computeVerdict` doesn't have to know which path was taken.
 *
 *   2. **Compute the verdict.** Given a parsed `predicted_effect`, a
 *      post-ship `observed` value, and the post-ship sample count,
 *      return one of HELD / PARTIAL / MISSED / PENDING / QUALITATIVE
 *      per the PRD AC. Deterministic — same inputs always give the
 *      same verdict — so the Weekly Review's *What we shipped* row
 *      is auditable.
 */

// ---------------------------------------------------------------------------
// Parse predicted effect from a runway-repo issue body
// ---------------------------------------------------------------------------

/**
 * VA-409: try the v1.1.0 stamped marker first, then fall back to the
 * v1.0.0 markdown. Returns `null` when neither path yields enough
 * structure to grade against (no marker, no `**Claim**` line, etc.) —
 * the caller treats that as "predicted effect lost" and skips the
 * shipped promotion in the *What we shipped* section.
 *
 * The marker carries the full `PredictedEffect` JSON including the
 * optional `attribution` block; the markdown fallback recovers
 * `claim`, `min_sample_size`, and `sample_description` but never
 * synthesizes an `attribution` (legacy bodies have no metric to grade
 * against, so the verdict falls through to `QUALITATIVE`).
 */
export function parsePredictedEffectFromBody(
  body: string,
): PredictedEffect | null {
  const fromMarker = parsePredictedEffectFromMarker(body);
  if (fromMarker) return fromMarker;
  return parsePredictedEffectFromMarkdown(body);
}

const parsePredictedEffectFromMarker = (
  body: string,
): PredictedEffect | null => {
  const re = new RegExp(
    `<!--\\s*${RUNWAY_META_PREDICTED_EFFECT_MARKER}:\\s*(\\{[\\s\\S]*?\\})\\s*-->`,
  );
  const match = re.exec(body);
  if (!match || !match[1]) return null;
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    return validatePredictedEffectShape(parsed);
  } catch {
    return null;
  }
};

const parsePredictedEffectFromMarkdown = (
  body: string,
): PredictedEffect | null => {
  // VA-408's `renderPromotionMarkdown` writes:
  //   > **Claim**: <text>
  //   > **Minimum sample size**: n ≥ <N> <sample-description>
  // Match those two lines tolerantly. The IRA may quote ">"  with or
  // without trailing whitespace and may use unicode `≥` or a plain `>=`.
  const claimMatch = /\*\*Claim\*\*:\s*([^\n]+)/.exec(body);
  const sampleMatch = /\*\*Minimum sample size\*\*:\s*n\s*(?:≥|>=)\s*(\d+)\s*([^\n]+?)\s*$/m.exec(
    body,
  );
  if (!claimMatch || !sampleMatch) return null;
  const claim = claimMatch[1]?.trim();
  const minSampleSize = Number(sampleMatch[1] ?? "");
  const sampleDescription = sampleMatch[2]?.trim();
  if (
    !claim ||
    !sampleDescription ||
    !Number.isFinite(minSampleSize) ||
    minSampleSize <= 0
  ) {
    return null;
  }
  return {
    claim,
    min_sample_size: minSampleSize,
    sample_description: sampleDescription,
  };
};

const ATTRIBUTION_METRICS: ReadonlySet<AttributionMetric> = new Set<
  AttributionMetric
>([
  "median_iteration_count",
  "p95_iteration_count",
  "median_wall_time_ms",
  "p95_wall_time_ms",
  "reviewer_rejection_rate",
  "revert_rate",
  "hitl_escape_rate",
  "infra_error_rate",
]);

const validatePredictedEffectShape = (parsed: unknown): PredictedEffect | null => {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.claim !== "string" || obj.claim.length === 0) return null;
  if (
    typeof obj.min_sample_size !== "number" ||
    !Number.isFinite(obj.min_sample_size) ||
    obj.min_sample_size <= 0 ||
    !Number.isInteger(obj.min_sample_size)
  ) {
    return null;
  }
  if (
    typeof obj.sample_description !== "string" ||
    obj.sample_description.length === 0
  ) {
    return null;
  }
  const base: PredictedEffect = {
    claim: obj.claim,
    min_sample_size: obj.min_sample_size,
    sample_description: obj.sample_description,
  };
  const attribution = obj.attribution;
  if (attribution === undefined || attribution === null) return base;
  if (typeof attribution !== "object") return base;
  const a = attribution as Record<string, unknown>;
  if (typeof a.metric !== "string") return base;
  if (!ATTRIBUTION_METRICS.has(a.metric as AttributionMetric)) return base;
  if (typeof a.baseline_value !== "number" || !Number.isFinite(a.baseline_value)) {
    return base;
  }
  if (a.direction !== "decrease" && a.direction !== "increase") return base;
  if (
    typeof a.threshold_value !== "number" ||
    !Number.isFinite(a.threshold_value)
  ) {
    return base;
  }
  return {
    ...base,
    attribution: {
      metric: a.metric as AttributionMetric,
      baseline_value: a.baseline_value,
      direction: a.direction,
      threshold_value: a.threshold_value,
    },
  };
};

// ---------------------------------------------------------------------------
// Verdict computation
// ---------------------------------------------------------------------------

export interface VerdictInput {
  readonly predictedEffect: PredictedEffect;
  /** Post-ship aggregate value; null when no data has accrued yet. */
  readonly observedValue: number | null;
  /** Number of post-ship runs that count toward the prediction's window. */
  readonly observedSampleSize: number;
}

export interface VerdictResult {
  readonly verdict: Verdict;
  readonly observedValue: number | null;
  /**
   * Default comment the attribution loop generates. The LLM may
   * overwrite this when authoring the *What we shipped* section, but
   * it's the safe fallback when the LLM declines to write one or when
   * the pass renders the section without LLM augmentation.
   */
  readonly comment: string;
}

/**
 * VA-409: deterministic verdict computation. The PRD's four numeric
 * branches plus the QUALITATIVE fallback:
 *
 *   - No `attribution` block → `QUALITATIVE` (no metric to grade).
 *   - `observedSampleSize < min_sample_size` → `PENDING` (insufficient
 *     post-ship runs; the comment carries the AC-mandated
 *     `n=X of Y needed` phrasing).
 *   - Numeric paths compare `observedValue` against
 *     `attribution.threshold_value` per `direction`:
 *       · `decrease` + `observed <= threshold` → `HELD`
 *       · `increase` + `observed >= threshold` → `HELD`
 *       · `decrease` + `observed < baseline` (didn't reach threshold)
 *         → `PARTIAL`
 *       · `increase` + `observed > baseline` (didn't reach threshold)
 *         → `PARTIAL`
 *       · otherwise → `MISSED` (no movement, or moved the wrong way)
 *
 * A null `observedValue` with a satisfied sample count is impossible
 * in practice (the read-model can't return null if rows exist) but
 * defensively maps to `MISSED` — better to mark as missed than to
 * silently return PENDING and re-grade forever.
 */
export function computeVerdict(input: VerdictInput): VerdictResult {
  const { predictedEffect, observedValue, observedSampleSize } = input;
  const { attribution } = predictedEffect;

  if (!attribution) {
    return {
      verdict: "QUALITATIVE",
      observedValue,
      comment: `QUALITATIVE — operator review needed. Predicted: "${predictedEffect.claim}"`,
    };
  }

  if (observedSampleSize < predictedEffect.min_sample_size) {
    return {
      verdict: "PENDING",
      observedValue,
      comment: `PENDING — n=${observedSampleSize} of ${predictedEffect.min_sample_size} needed`,
    };
  }

  if (observedValue === null) {
    return {
      verdict: "MISSED",
      observedValue,
      comment: `MISSED — sample met the bar (n=${observedSampleSize}) but no metric value was observed`,
    };
  }

  const { direction, baseline_value, threshold_value, metric } = attribution;
  const hitThreshold =
    direction === "decrease"
      ? observedValue <= threshold_value
      : observedValue >= threshold_value;
  if (hitThreshold) {
    return {
      verdict: "HELD",
      observedValue,
      comment: `HELD — ${metric} observed at ${formatNumber(observedValue)} across n=${observedSampleSize} (threshold: ${formatComparator(direction)}${formatNumber(threshold_value)}, baseline: ${formatNumber(baseline_value)})`,
    };
  }

  const movedTowardThreshold =
    direction === "decrease"
      ? observedValue < baseline_value
      : observedValue > baseline_value;
  if (movedTowardThreshold) {
    return {
      verdict: "PARTIAL",
      observedValue,
      comment: `PARTIAL — ${metric} moved from baseline ${formatNumber(baseline_value)} to ${formatNumber(observedValue)} but didn't reach threshold ${formatComparator(direction)}${formatNumber(threshold_value)} (n=${observedSampleSize})`,
    };
  }

  return {
    verdict: "MISSED",
    observedValue,
    comment: `MISSED — ${metric} at ${formatNumber(observedValue)} did not improve vs baseline ${formatNumber(baseline_value)} (n=${observedSampleSize})`,
  };
}

const formatNumber = (n: number): string => {
  if (Number.isInteger(n)) return n.toString();
  // Three significant decimals — rates and seconds both render
  // legibly without scientific notation for typical workspace scales.
  return n.toFixed(3).replace(/\.?0+$/, "");
};

const formatComparator = (direction: "decrease" | "increase"): string =>
  direction === "decrease" ? "≤ " : "≥ ";
