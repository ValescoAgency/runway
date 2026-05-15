import { claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { Effect } from "effect";
import type { Config } from "./config.js";
import { captureCommitLog } from "./git.js";
import type { RunwayIssue } from "./linear.js";
import { codingAgentReportSpanAttrs } from "./meta/span-attrs.js";
import {
  augmentCodingAgentReport,
  parseCodingAgentReport,
  type CodingAgentReport,
  type ReportParseResult,
} from "./meta/templates.js";
import type { Policy } from "./policy.js";
import { renderImplementPrompt } from "./prompts.js";
import {
  dockerEnv,
  runSandcastle,
  stringifyResult,
  type SandcastleRunResult,
} from "./sandcastle.js";

/**
 * Narrow per-phase deps: the implement loop has no business with
 * Linear or GitHub gateways. Policy is here because it shapes the
 * implement prompt's "do-not-touch" bullet (VA-352). `priorFeedback`
 * (VA-383) is pre-fetched and pre-formatted by the orchestrator —
 * the implement loop never reaches for Linear itself.
 */
export interface ImplementDeps {
  readonly config: Config;
  readonly cwd: string;
  readonly baseBranch: string;
  readonly policy: Policy;
  /**
   * VA-383: formatted "Review feedback from prior attempts" block to
   * inject into iteration 1's prompt. Empty string when the
   * orchestrator found no surviving comments (or the fetch failed —
   * in which case the run continues, per VA-383's never-block AC).
   */
  readonly priorFeedback: string;
  /**
   * VA-418: formatted "Reviewer feedback from this run" block. Empty
   * string on the first impl pass; populated by the orchestrator on
   * a retry after the previous review pass emitted
   * `REVIEW: REJECTED-RETRY — <reason>`. Kept independent of
   * `priorFeedback` so the agent reads it as the higher-trust signal.
   */
  readonly inRunReviewerFeedback?: string;
}

/**
 * What the implement loop hands back to the composer.
 *
 * `ready` — agent terminated cleanly with commits; review pass is next.
 * `hitl`  — agent self-blocked, missed the marker after retries, or
 *           produced no commits at all. The composer enacts the HITL
 *           side-effects.
 */
export type ImplementOutcome =
  | { readonly kind: "ready"; readonly finalResult: SandcastleRunResult }
  | { readonly kind: "hitl"; readonly reason: string };

type ImplVerdict =
  | { readonly kind: "done" }
  | { readonly kind: "continue" }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "missing" };

// VA-350: impl-pass termination contract. Last `IMPL:` marker line in
// the agent's output wins (most recent iteration's verdict). DONE →
// proceed to review; BLOCKED → HITL with reason; CONTINUE or missing →
// fall through (back-compat). The trailing reason after `—` is
// captured for BLOCKED.
const IMPL_VERDICT_RE = /^IMPL:\s*(DONE|BLOCKED|CONTINUE)(?:\s+—\s+(.*))?$/gm;
const IMPL_COMPLETION_SIGNALS = ["IMPL: DONE", "IMPL: BLOCKED"] as const;

/**
 * VA-401: the Claude model runway uses to drive the impl agent. Lifted
 * to a module-level constant so the report's telemetry slot has a
 * single source of truth — the orchestrator stamps it post-parse, and
 * the IRA's "did we pay the right model price for this run?" axis
 * grades against the same string.
 */
const IMPL_AGENT_MODEL = "claude-opus-4-7";

/**
 * Pulls the last `IMPL:` marker line out of the agent's output. The
 * orchestrator uses this to distinguish a clean completion (DONE)
 * from a self-declared block (BLOCKED — reason) from a multi-
 * iteration in-progress signal (CONTINUE). A missing marker is
 * treated as CONTINUE-with-warning for back-compat.
 */
export function parseImplVerdict(result: unknown): ImplVerdict {
  const text = stringifyResult(result);
  // Take the LAST match — later iterations override earlier ones if
  // the agent emitted multiple markers across an iteration loop.
  const matches = [...text.matchAll(IMPL_VERDICT_RE)];
  const last = matches[matches.length - 1];
  if (!last) return { kind: "missing" };
  if (last[1] === "DONE") return { kind: "done" };
  if (last[1] === "CONTINUE") return { kind: "continue" };
  return {
    kind: "blocked",
    reason: last[2]?.trim() || "no reason given",
  };
}

/**
 * VA-349 + VA-350: run iterations one at a time so we can (a) inject
 * a summary of the previous iteration into the next prompt — no more
 * "I'll start by understanding the current state of the repository"
 * 5× per issue — and (b) break early on IMPL: DONE/BLOCKED parsed
 * from our own code rather than relying on sandcastle's substring
 * completionSignal.
 */
export const runImplementLoop = (
  issue: RunwayIssue,
  deps: ImplementDeps,
  branch: string,
): Effect.Effect<ImplementOutcome, { readonly message: string }, never> =>
  Effect.gen(function* () {
    const { config, cwd, baseBranch, policy, priorFeedback } = deps;
    const inRunReviewerFeedback = deps.inRunReviewerFeedback ?? "";
    const maxIters = Math.max(1, config.maxIterations);
    let prevSummary = "";
    let implementResult: SandcastleRunResult | undefined;
    let implVerdict: ImplVerdict = { kind: "missing" };
    // VA-401: the FINAL iteration's report is what the IRA (and the
    // dashboard's processIssue detail pane) reads as authoritative.
    // We accumulate it inside the loop and bubble it up to the
    // processIssue span at exit, so the report survives a downstream
    // reviewer / finalize crash regardless of which iteration
    // produced it.
    let lastReport: ReportParseResult<CodingAgentReport> | undefined;

    for (let iter = 1; iter <= maxIters; iter += 1) {
      const implementPrompt = yield* Effect.promise(() =>
        renderImplementPrompt({
          issue,
          policy,
          previousIterations: prevSummary,
          // VA-383: surface prior-attempt review feedback on every
          // iteration of this run — the rejection blockers that put
          // the issue back to Todo are equally relevant on iteration 1
          // and iteration N+1, since the implementer keeps drifting
          // toward the same code paths until corrected.
          priorReviewFeedback: priorFeedback,
          // VA-418: in-run rejection feedback (empty on first impl
          // pass, populated on a review-rejection retry). Independent
          // slot from `priorReviewFeedback` so the agent reads it as
          // the higher-trust signal.
          inRunReviewerFeedback,
          // VA-417: pass the actual base branch so the prompt
          // renders the real name (`main`, `master`, etc.) rather
          // than a hardcoded default.
          baseBranch,
        }),
      );

      const sandcastleRunId = `impl-${issue.identifier}-iter-${iter}`;
      // VA-389: parse the verdict inside the span scope so the
      // dashboard projector can read `runway.iteration.exit_status`
      // off the `impl-iter-N` span without joining against the agent
      // log. `runway.iteration.sandcastle_run_id` lets a future link
      // to the per-run output (raw stdout, etc.) without needing to
      // rebuild the name from issue identifier + iteration.
      implementResult = yield* Effect.gen(function* () {
        // VA-401: wall-time is one of the auto-populated telemetry
        // fields. Captured around the sandcastle call so it reflects
        // the agent's actual work duration, not the surrounding
        // bookkeeping.
        const startMs = Date.now();
        const result = yield* runSandcastle({
          agent: claudeCode(IMPL_AGENT_MODEL),
          sandbox: docker({ env: dockerEnv(config) }),
          cwd,
          prompt: implementPrompt,
          branchStrategy: { type: "branch", branch },
          maxIterations: config.implTurns,
          completionSignal: [...IMPL_COMPLETION_SIGNALS],
          name: sandcastleRunId,
        });
        const wallTimeMs = Date.now() - startMs;
        const verdict = parseImplVerdict(result);
        // VA-401: capture the structured Coding Agent Report
        // immediately on agent exit, before review fires. The
        // iteration span (`impl-iter-N`) is the **durable source**
        // for the report — it ends as soon as this gen exits (when
        // sandcastle returns), so the OTel BatchSpanProcessor queues
        // it for export BEFORE the reviewer pass starts. The
        // dashboard / IRA read from the iteration span (or, after
        // VA-402 lands, the `meta_reviews` row composed from it),
        // not from the still-open `processIssue` parent. Parse
        // errors are recorded as typed `error.kind` attributes —
        // orchestration must continue regardless of report shape.
        const parsed = parseCodingAgentReport(stringifyResult(result));
        // Augment with orchestrator-stamped telemetry before
        // projecting to span attrs. Agents don't know wall-time or
        // their own model name; runway does. `tool_call_count` is a
        // proxy from sandcastle's iteration count — the inner-loop
        // turns the agent actually consumed.
        const report: ReportParseResult<CodingAgentReport> = parsed.ok
          ? {
              ok: true,
              report: augmentCodingAgentReport(parsed.report, {
                model: IMPL_AGENT_MODEL,
                tool_call_count: sandcastleToolCallCount(result),
                wall_time_ms: wallTimeMs,
              }),
            }
          : parsed;
        lastReport = report;
        yield* Effect.annotateCurrentSpan({
          "runway.iteration.exit_status": verdict.kind,
          "runway.iteration.sandcastle_run_id": sandcastleRunId,
          ...codingAgentReportSpanAttrs(report),
        });
        return result;
      }).pipe(
        Effect.withSpan(`impl-iter-${iter}`, {
          attributes: {
            "runway.iteration": iter,
            "runway.iteration.max": maxIters,
          },
        }),
      );

      implVerdict = parseImplVerdict(implementResult);
      if (implVerdict.kind === "done" || implVerdict.kind === "blocked") break;

      // CONTINUE / missing — build the summary the NEXT iteration
      // will see at the top of its prompt.
      const commits = yield* captureCommitLog(cwd, baseBranch, branch).pipe(
        Effect.catchAll(() => Effect.succeed("")),
      );
      prevSummary = buildIterationSummary({
        iterationsRun: iter,
        commits,
        finalMessageTail: tailOfMessage(implementResult.stdout ?? ""),
      });
    }

    // implementResult is set after the first iteration. The `!` is
    // safe because maxIters >= 1.
    const finalResult = implementResult!;

    // VA-401: the Coding Agent Report lives on the **iteration span**
    // (`impl-iter-N`), which has ended by the time we reach this
    // point — so it's already in the OTel batch processor's export
    // queue. We intentionally do NOT re-annotate it on the still-open
    // `processIssue` parent: that span doesn't end until the whole
    // composer (impl → review → finalize) finishes, so a parent-level
    // attribute wouldn't be durable across a reviewer/finalize crash.
    // The dashboard / IRA read the report from the iteration span (or
    // from the `meta_reviews` table once VA-402 lands), then join up
    // to `processIssue` via `agent_iterations.issue_process_id`.
    //
    // Reference suppressed-unused-vars: `lastReport` is kept as a
    // local because the future VA-402 pass will need it surfaced via
    // `ImplementOutcome` to avoid re-parsing. The current orchestrator
    // doesn't read it back out, so we just acknowledge it.
    void lastReport;

    // VA-350: BLOCKED short-circuits straight to HITL — no reviewer
    // pass for a self-declared blocker.
    if (implVerdict.kind === "blocked") {
      return {
        kind: "hitl",
        reason: `Implementation pass blocked: ${implVerdict.reason}`,
      };
    }
    if (implVerdict.kind === "missing") {
      yield* Effect.logWarning(
        `impl agent ended without an IMPL: marker after ${maxIters} iteration(s); proceeding to review for back-compat`,
      );
    }

    if (finalResult.commits.length === 0) {
      return {
        kind: "hitl",
        reason:
          "Agent produced no commits — the issue may need clarification or human input.",
      };
    }

    return { kind: "ready", finalResult };
  });

// ---------------------------------------------------------------------------
// Iteration-accounting helpers
//
// VA-361 moved these from prompts.ts. They're about assembling the
// "previous iterations" block for the NEXT iteration's prompt — an
// implement-loop concern, not template-rendering. prompts.ts gets a
// finished `previousIterations` string passed in; how it was built is
// this module's business.
// ---------------------------------------------------------------------------

/**
 * VA-349: build the "## Previous iterations" block that gets prepended
 * to iteration N+1's prompt. Carries the agent's commit log and the
 * tail of its final message so the next iteration doesn't re-explore
 * the repo from scratch.
 */
function buildIterationSummary(args: {
  iterationsRun: number;
  commits: string;
  finalMessageTail: string;
}): string {
  const { iterationsRun, commits, finalMessageTail } = args;
  return [
    "## Previous iterations",
    "",
    `You have already completed ${iterationsRun} iteration(s) on this issue.`,
    "Do **not** re-explore the repository — pick up where the last iteration left off.",
    "",
    "### Commits so far on this branch",
    "",
    "```",
    commits.trim() || "(no commits yet)",
    "```",
    "",
    "### Tail of the last iteration's final message",
    "",
    "```",
    finalMessageTail.trim() || "(no output captured)",
    "```",
    "",
  ].join("\n");
}

/** Keep the tail of an iteration's stdout small enough to fit alongside the prompt. */
function tailOfMessage(stdout: string, maxChars = 2000): string {
  if (stdout.length <= maxChars) return stdout;
  return `…(earlier output truncated)\n${stdout.slice(-maxChars)}`;
}

/**
 * VA-401: best-effort tool-call count from a sandcastle result. The
 * sandcastle SDK exposes `iterations: { output, text }[]` — one entry
 * per inner-loop turn the agent took. Each turn typically issues one
 * or more tool calls; we use the iteration count as a portable proxy
 * (sandcastle doesn't surface a per-tool-call counter). Reports `0`
 * for shapes that don't carry the field — better to under-report than
 * fabricate.
 */
function sandcastleToolCallCount(result: SandcastleRunResult): number {
  const r = result as { iterations?: readonly unknown[] };
  return Array.isArray(r.iterations) ? r.iterations.length : 0;
}
