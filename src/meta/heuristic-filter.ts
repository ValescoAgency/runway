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
 *   - retry triggered at any phase — `reviewAttemptCount >= 2` covers
 *     the recovered-from-REJECTED-RETRY case (a run that ended
 *     "opened" but ran review more than once); the
 *     `Sub-agent review rejected` outcomeDetail prefix covers the
 *     escalated-to-HITL case
 *   - reviewer-rejected count ≥ N (default 2) — observed directly
 *     from `reviewAttemptCount` (each rejection produces a fresh
 *     review span)
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
  const { issueProcess: ip, codingAgentReport: agent, reviewAttemptCount } =
    context;

  if (ip.outcomeKind === "errored") {
    return { run: true, reason: "infra-error outcome" };
  }
  if (ip.outcomeKind === "reverted") {
    return { run: true, reason: "revert outcome" };
  }

  // VA-404 follow-up (cursor review on PR #105): "retry triggered at
  // any phase" must catch recovered-from-REJECTED-RETRY runs, not
  // only the ones that escalated to HITL. Each review attempt opens
  // a fresh `review` span; >= 2 means at least one mid-run retry
  // happened. Honour the configurable threshold so operators can
  // dial sensitivity (`minReviewerRejections: 1` would surface even
  // a single review attempt — useful as a debug knob).
  if (reviewAttemptCount >= thresholds.minReviewerRejections) {
    return {
      run: true,
      reason: `retry triggered (${reviewAttemptCount} review attempts >= ${thresholds.minReviewerRejections})`,
    };
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
    reason: `clean run (outcome=${ip.outcomeKind ?? "unknown"}, iterations=${agent.iterationIndex}, review_attempts=${reviewAttemptCount})`,
  };
}
