import type { RunReviewContext } from "./context.js";

/**
 * VA-404: heuristic pre-filter for the IRA's Run Review pass.
 *
 * The PRD's "skip uneventful runs" gate. A drain that produced a clean
 * one-iteration merge isn't worth a Run Review LLM call — the IRA's
 * value is in retrospecting on runs that exhibit signal (retries, HITL
 * escapes, reverts, infra errors). This filter codifies that bar.
 *
 * Trip conditions (defaults configurable via `metaFilterThresholds`):
 *
 *   - infra-error outcome (`outcomeKind === "errored"`)
 *   - HITL escape       (`outcomeKind === "hitl"`)
 *   - revert outcome    (`outcomeKind === "reverted"`)
 *   - reviewer rejection retry — `outcomeKind === "hitl"` AND
 *     `outcomeDetail` starts with `"Sub-agent review rejected"`
 *     (the prefix `src/review.ts` emits and the dashboard's
 *     aggregates view keys on)
 *   - reviewer-rejected count ≥ N (default 2) — proxied via
 *     `iterationIndex` because we don't have a per-attempt rejection
 *     counter on `issue_processes` yet. A run that hit ≥N iterations
 *     and ended in HITL is almost certainly a multi-rejection escape
 *   - iteration count ≥ M (default 3) when the agent report is
 *     present; when the agent report is absent / errored we treat
 *     that as a trip too — something failed before we could measure
 */

export interface MetaFilterThresholds {
  readonly minIterationCount: number;
  readonly minReviewerRejections: number;
}

export const DEFAULT_META_FILTER_THRESHOLDS: MetaFilterThresholds = {
  minIterationCount: 3,
  minReviewerRejections: 2,
};

export interface FilterDecision {
  readonly run: boolean;
  readonly reason: string;
}

export function shouldRunIRA(
  context: RunReviewContext,
  thresholds: MetaFilterThresholds = DEFAULT_META_FILTER_THRESHOLDS,
): FilterDecision {
  const { issueProcess: ip, codingAgentReport: agent } = context;

  if (ip.outcomeKind === "errored") {
    return { run: true, reason: "infra-error outcome" };
  }
  if (ip.outcomeKind === "reverted") {
    return { run: true, reason: "revert outcome" };
  }

  const isReviewRejection =
    typeof ip.outcomeDetail === "string" &&
    ip.outcomeDetail.startsWith("Sub-agent review rejected");

  if (ip.outcomeKind === "hitl") {
    if (isReviewRejection) {
      return {
        run: true,
        reason: "retry triggered (sub-agent review rejected)",
      };
    }
    if (
      agent.ok &&
      agent.iterationIndex >= thresholds.minReviewerRejections
    ) {
      return {
        run: true,
        reason: `HITL escape after ${agent.iterationIndex} iterations (>= ${thresholds.minReviewerRejections} reviewer-rejection proxy)`,
      };
    }
    return { run: true, reason: "HITL escape" };
  }

  if (!agent.ok) {
    return {
      run: true,
      reason: `coding agent report ${agent.kind}`,
    };
  }

  if (agent.iterationIndex >= thresholds.minIterationCount) {
    return {
      run: true,
      reason: `iteration count ${agent.iterationIndex} >= ${thresholds.minIterationCount}`,
    };
  }

  return {
    run: false,
    reason: `clean run (outcome=${ip.outcomeKind ?? "unknown"}, iterations=${agent.iterationIndex})`,
  };
}
