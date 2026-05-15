import { claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { Effect } from "effect";
import type { Config } from "./config.js";
import { captureCommitLog, captureDiff } from "./git.js";
import type { RunwayIssue } from "./linear.js";
import { reviewerReportSpanAttrs } from "./meta/span-attrs.js";
import {
  parseReviewerReport,
  type ReportParseResult,
  type ReviewerReport,
} from "./meta/templates.js";
import { renderReviewPrompt } from "./prompts.js";
import {
  dockerEnv,
  runSandcastle,
  stringifyResult,
} from "./sandcastle.js";

/**
 * Narrow per-phase deps: the review pass needs the workspace and
 * baseBranch to diff against, plus config for docker env. No Linear,
 * no GitHub, no policy.
 */
export interface ReviewDeps {
  readonly config: Config;
  readonly cwd: string;
  readonly baseBranch: string;
}

/**
 * What the review pass hands back to the composer.
 *
 * `approved`        — proceed to finalize (push + PR).
 * `rejected-retry`  — VA-418: reviewer flagged a mechanically-fixable
 *                    rejection. Composer should hand the rejection
 *                    reason back to the impl agent and re-run review
 *                    (bounded by `RUNWAY_REVIEW_RETRIES`).
 * `rejected-hitl`   — VA-418: reviewer flagged a rejection that needs
 *                    human judgment (wrong direction, ambiguous spec).
 *                    Composer should escalate immediately — no more
 *                    impl attempts this drain.
 * `hitl`            — missing marker (likely crashed / truncated). The
 *                    composer enacts HITL with a distinct reason so the
 *                    operator can tell crash from rejection.
 */
export type ReviewOutcome =
  | { readonly kind: "approved" }
  | { readonly kind: "rejected-retry"; readonly reason: string }
  | { readonly kind: "rejected-hitl"; readonly reason: string }
  | { readonly kind: "hitl"; readonly reason: string };

// VA-353 / VA-418: review verdict marker. Global flag because
// sandcastle appends wrapper output ("Agent stopped", "Capturing
// session", "Reached max iterations (1).", "Run complete: …") AFTER
// the agent's final message — so the marker is rarely the last line.
// We scan every line-start match and keep the LAST one, which is the
// most recent agent verdict. Standalone-line: ^…$ with /m anchors
// prevent mid-prose matches like "the reviewer should output REVIEW:
// APPROVED when…".
//
// VA-418 extended the verdict alphabet from {APPROVED, REJECTED} to
// {APPROVED, REJECTED, REJECTED-RETRY, REJECTED-HITL}. Plain
// `REJECTED` (the legacy marker) still parses and maps to
// `rejected-retry` so existing prompts continue to drive the retry
// flow without an update.
const REVIEW_VERDICT_RE =
  /^REVIEW:\s*(APPROVED|REJECTED-RETRY|REJECTED-HITL|REJECTED)(?:\s+—\s+(.*))?$/gm;

// VA-360 / VA-418: review verdict ADT with explicit `missing` instead
// of silently bucketing "no marker found" as rejected, and a split
// between `rejected-retry` and `rejected-hitl` so the composer can
// route accordingly. A schema doesn't help here — the regex IS the
// parser, there's no upstream structured shape to validate.
export type ParsedVerdict =
  | { readonly kind: "approved"; readonly reason: string }
  | { readonly kind: "rejected-retry"; readonly reason: string }
  | { readonly kind: "rejected-hitl"; readonly reason: string }
  | { readonly kind: "missing"; readonly reason: string };

/**
 * VA-353: parse the reviewer's final `REVIEW: APPROVED` /
 * `REVIEW: REJECTED — <reason>` marker. Scans the agent's combined
 * stdout for *all* matches and returns the LAST one, since
 * sandcastle appends its own wrapper output ("Agent stopped",
 * "Capturing session", "Reached max iterations (N).", "Run complete:
 * …") after the agent's final message. A missing marker is itself a
 * rejection — a reviewer pass that didn't terminate cleanly is not
 * trustworthy.
 */
export function parseReviewVerdict(result: unknown): ParsedVerdict {
  const text = stringifyResult(result);
  const matches = [...text.matchAll(REVIEW_VERDICT_RE)];
  const last = matches[matches.length - 1];
  // VA-360: explicit `missing` kind. Pre-VA-360 this returned a
  // rejection with the message "review output did not contain a
  // REVIEW: verdict line" — which conflated "agent reviewed and
  // rejected" with "agent never emitted a verdict (crash, truncation,
  // OOM)". The composer now routes the two to HITL with distinct
  // reason lines so the operator can tell them apart.
  if (!last) {
    return {
      kind: "missing",
      reason: "review output did not contain a REVIEW: verdict line",
    };
  }
  if (last[1] === "APPROVED") return { kind: "approved", reason: "" };
  const reason = last[2]?.trim() || "no reason given";
  // VA-418: REJECTED-HITL escalates immediately; REJECTED-RETRY (and
  // the legacy bare REJECTED, for graceful degradation) flows into
  // the bounded retry loop. Default to the more forgiving path on
  // ambiguity — the retry budget caps the blast radius.
  if (last[1] === "REJECTED-HITL") return { kind: "rejected-hitl", reason };
  return { kind: "rejected-retry", reason };
}

export const runReviewPass = (
  issue: RunwayIssue,
  deps: ReviewDeps,
  branch: string,
): Effect.Effect<ReviewOutcome, { readonly message: string }, never> =>
  Effect.gen(function* () {
    const { config, cwd, baseBranch } = deps;
    const diff = yield* captureDiff(cwd, baseBranch, branch);
    const commitLog = yield* captureCommitLog(cwd, baseBranch, branch);
    const reviewPrompt = yield* Effect.promise(() =>
      renderReviewPrompt({ issue, diff, commits: commitLog }),
    );
    // VA-401: parse the Reviewer Report in the outer scope so we can
    // (a) annotate it on the `review` span (inner) and (b) bubble it
    // up to the parent `processIssue` span (after the inner scope
    // exits) — matching the PRD's "extend the VA-387 span enrichment
    // to include the report fields" mechanism.
    let reviewerReport: ReportParseResult<ReviewerReport> | undefined;
    const reviewResult = yield* Effect.gen(function* () {
      const result = yield* runSandcastle({
        agent: claudeCode("claude-opus-4-7"),
        sandbox: docker({ env: dockerEnv(config) }),
        cwd,
        prompt: reviewPrompt,
        branchStrategy: { type: "head" },
        maxIterations: 1,
        name: `review-${issue.identifier}`,
      });
      const report = parseReviewerReport(stringifyResult(result));
      reviewerReport = report;
      yield* Effect.annotateCurrentSpan(reviewerReportSpanAttrs(report));
      return result;
    }).pipe(Effect.withSpan("review"));

    // Bubble the final Reviewer Report onto `processIssue` so the
    // detail pane (and the IRA's Run Review pass) reads it without
    // joining child spans. Parse errors land here too — the
    // dashboard then shows reviewer template drift on the same row
    // as agent template drift.
    if (reviewerReport) {
      yield* Effect.annotateCurrentSpan(reviewerReportSpanAttrs(reviewerReport));
    }

    const verdict = parseReviewVerdict(reviewResult);
    // VA-418: split rejection into two outcomes so the composer can
    // route mechanically-fixable rejections back to the impl agent
    // (within the configured retry budget) and only escalate to HITL
    // when the reviewer explicitly asks for human judgment.
    if (verdict.kind === "rejected-retry") {
      return { kind: "rejected-retry", reason: verdict.reason };
    }
    if (verdict.kind === "rejected-hitl") {
      return { kind: "rejected-hitl", reason: verdict.reason };
    }
    if (verdict.kind === "missing") {
      // VA-360: a review pass that didn't emit any marker is
      // untrustworthy — usually a crash, OOM, or context-window
      // truncation. Route to HITL with a reason that distinguishes
      // this from a real rejection so the operator knows to look at
      // the agent log instead of arguing with the verdict.
      return {
        kind: "hitl",
        reason: `Review pass ended without a REVIEW: marker (likely crashed or truncated): ${verdict.reason}`,
      };
    }
    return { kind: "approved" };
  });
