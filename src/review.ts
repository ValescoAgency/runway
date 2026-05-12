import { claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { Effect } from "effect";
import type { Config } from "./config.js";
import { captureCommitLog, captureDiff } from "./git.js";
import type { RunwayIssue } from "./linear.js";
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
 * `approved` — proceed to finalize (push + PR).
 * `hitl`     — rejected by the sub-agent, OR missing marker (likely
 *              crashed / truncated). The composer enacts HITL.
 */
export type ReviewOutcome =
  | { readonly kind: "approved" }
  | { readonly kind: "hitl"; readonly reason: string };

// VA-353: review verdict marker. Global flag because sandcastle
// appends wrapper output ("Agent stopped", "Capturing session",
// "Reached max iterations (1).", "Run complete: …") AFTER the agent's
// final message — so the marker is rarely the last line. We scan
// every line-start match and keep the LAST one, which is the most
// recent agent verdict. Standalone-line: ^…$ with /m anchors prevent
// mid-prose matches like "the reviewer should output REVIEW: APPROVED
// when…".
const REVIEW_VERDICT_RE =
  /^REVIEW:\s*(APPROVED|REJECTED)(?:\s+—\s+(.*))?$/gm;

// VA-360: review verdict ADT with explicit `missing` instead of
// silently bucketing "no marker found" as rejected. A schema doesn't
// help here — the regex IS the parser, there's no upstream
// structured shape to validate. The substantive change is to make
// "missing" a distinct outcome so the composer can route a truncated
// / crashed review pass to HITL with the right detail line instead
// of pretending the agent rejected the work.
export type ParsedVerdict =
  | { readonly kind: "approved"; readonly reason: string }
  | { readonly kind: "rejected"; readonly reason: string }
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
  return {
    kind: "rejected",
    reason: last[2]?.trim() || "no reason given",
  };
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
    const reviewResult = yield* runSandcastle({
      agent: claudeCode("claude-opus-4-7"),
      sandbox: docker({ env: dockerEnv(config) }),
      cwd,
      prompt: reviewPrompt,
      branchStrategy: { type: "head" },
      maxIterations: 1,
      name: `review-${issue.identifier}`,
    }).pipe(Effect.withSpan("review"));

    const verdict = parseReviewVerdict(reviewResult);
    if (verdict.kind === "rejected") {
      return {
        kind: "hitl",
        reason: `Sub-agent review rejected: ${verdict.reason}`,
      };
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
