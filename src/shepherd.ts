import { claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { Duration, Effect } from "effect";
import type { Config } from "./config.js";
import type { GithubError, GithubGateway } from "./github.js";
import type { RunwayIssue } from "./linear.js";
import { renderShepherdRebasePrompt } from "./prompts.js";
import {
  dockerEnv,
  runSandcastle,
  stringifyResult,
} from "./sandcastle.js";

/**
 * VA-460: shepherd-phase scaffolding. The shepherd loop runs after
 * `finalize` returns an open PR and drives it toward merge by reacting
 * to three subscriptions (mergeability / CI / reviewer feedback) — see
 * VA-461..463 for the wired implementations. This file is the seam;
 * subscriptions default to no-op stubs and the feature gate
 * (`config.shepherdEnabled`) is `false` for the first ship.
 */

export interface ShepherdContext {
  readonly issue: RunwayIssue;
  readonly branch: string;
  readonly prUrl: string;
  /** Parsed from `prUrl` once at loop start; subscriptions consume it. */
  readonly prNumber: number;
  readonly cwd: string;
  readonly baseBranch: string;
  readonly config: Config;
  readonly github: GithubGateway;
  /** 1-indexed; bumps after each subscription returns a non-quiet signal. */
  readonly iteration: number;
}

/**
 * What a subscription reports for a single poll.
 *
 *   quiet — nothing to act on this poll.
 *   hitl  — non-actionable; route to HITL with reason. Loop exits.
 *   fix   — actionable; the embedded `action` Effect runs an out-of-
 *           band sandcastle invocation that drives the PR back to a
 *           mergeable state. Counts as one shepherd iteration.
 */
export type SubscriptionSignal =
  | { readonly kind: "quiet" }
  | { readonly kind: "hitl"; readonly reason: string }
  | {
      readonly kind: "fix";
      readonly description: string;
      readonly action: Effect.Effect<
        FixOutcome,
        GithubError | { readonly message: string }
      >;
    };

/**
 * VA-461: result of a `fix` subscription's action.
 *
 *   fixed — action ran; the loop continues to the next iteration to
 *           re-check merged + subscriptions against the new state.
 *   hitl  — action couldn't resolve (e.g., rebase agent reported
 *           BLOCKED); the loop exits with the reason.
 */
export type FixOutcome =
  | { readonly kind: "fixed"; readonly detail: string }
  | { readonly kind: "hitl"; readonly reason: string };

export type Subscription = (
  ctx: ShepherdContext,
) => Effect.Effect<SubscriptionSignal, GithubError | { readonly message: string }>;

/**
 * Separate first-class check from A/B/C: did the PR merge between
 * polls? Default returns `false`; VA-461 plugs in `gh pr view` /
 * `pulls/:n` so the loop can exit `merged` instead of hitting the
 * iteration cap.
 */
export type MergeCheck = (
  ctx: ShepherdContext,
) => Effect.Effect<boolean, GithubError | { readonly message: string }>;

export interface ShepherdDeps {
  readonly config: Config;
  readonly cwd: string;
  readonly baseBranch: string;
  readonly github: GithubGateway;
  /** No-op default; VA-461 wires the real merge poll. */
  readonly isMerged?: MergeCheck;
  /** Empty default; VA-461/462/463 fill in mergeability/ci/reviewer. */
  readonly subscriptions?: readonly Subscription[];
  /** Override for tests; production reads `config.shepherdPollIntervalSeconds`. */
  readonly pollIntervalSeconds?: number;
  /**
   * VA-460: max consecutive QUIET poll cycles before exiting `ready`.
   * Quiet polls (no merge, no subscription fire) are the "PR is
   * calm" signal — after `maxQuietPolls` of them in a row, the
   * shepherd presumes the PR is ready for human merge and exits. This
   * is NOT a budget — it's a natural-exit threshold.
   * Default: 5. Tests override to drive fast `ready` outcomes.
   */
  readonly maxQuietPolls?: number;
  /**
   * VA-464: max FIX attempts the loop will make before escalating to
   * HITL with the iteration-budget reason. Each `fix` signal that
   * runs an action counts as one. Production reads
   * `config.shepherdMaxIterations`. Override for tests.
   */
  readonly maxFixAttempts?: number;
  /**
   * VA-464: wall-clock cap (seconds) from the start of the
   * runShepherdPass invocation. Production reads
   * `config.shepherdMaxWallSeconds`. Override for tests.
   */
  readonly maxWallSeconds?: number;
}

export type ShepherdOutcome =
  | { readonly kind: "merged" }
  | { readonly kind: "ready"; readonly reason: string }
  | { readonly kind: "hitl"; readonly reason: string };

/**
 * VA-460: "PR has been calm long enough — presume ready for human
 * merge" default. Not a budget; just the natural-exit threshold for
 * the loop when nothing is happening. Override via
 * `ShepherdDeps.maxQuietPolls` for tests.
 */
const DEFAULT_MAX_QUIET_POLLS = 5;

const DEFAULT_NO_OP_MERGE_CHECK: MergeCheck = () => Effect.succeed(false);

/**
 * VA-460: named no-op subscription stubs. VA-461..463 each replace
 * one of these with a real handler factory.
 *
 *   A. mergeabilityStub — replaced by `makeMergeabilityWatcher` (VA-461)
 *   B. ciStub           — replaced by VA-462 (check-runs watcher)
 *   C. reviewerStub     — replaced by VA-463 (PR comment watcher)
 */
export const mergeabilityStub: Subscription = () =>
  Effect.succeed({ kind: "quiet" });
export const ciStub: Subscription = () =>
  Effect.succeed({ kind: "quiet" });
export const reviewerStub: Subscription = () =>
  Effect.succeed({ kind: "quiet" });

export const DEFAULT_SUBSCRIPTIONS: readonly Subscription[] = [
  mergeabilityStub,
  ciStub,
  reviewerStub,
];

/**
 * VA-461: real merge check, wired to the github gateway's
 * `getPullRequest`. Drop-in replacement for the scaffolding's
 * `DEFAULT_NO_OP_MERGE_CHECK`.
 */
export function makeIsMerged(github: GithubGateway): MergeCheck {
  return (ctx) =>
    Effect.map(
      github.getPullRequest({ repoPath: ctx.cwd, prNumber: ctx.prNumber }),
      (pr) => pr.merged,
    );
}

/**
 * VA-461: result of one rebase-agent invocation. `done` means the
 * agent reported `IMPL: DONE` (rebase + push successful); `blocked`
 * carries the agent's reported reason and any files it enumerated.
 */
export type RebaseAgentResult =
  | { readonly kind: "done" }
  | {
      readonly kind: "blocked";
      readonly reason: string;
      readonly conflictFiles: readonly string[];
    };

export interface RebaseAgentInvocation {
  readonly issue: RunwayIssue;
  readonly branch: string;
  readonly baseBranch: string;
  readonly mergeableState: string;
  readonly conflictFiles: readonly string[];
  readonly cwd: string;
  readonly config: Config;
}

/**
 * Production rebase-agent invocation: render the prompt, run one
 * sandcastle iteration, parse the agent's `IMPL:` verdict. The
 * shepherd's `fix` action wraps this so tests can stub the whole
 * function via `MergeabilityWatcherDeps.invokeRebaseAgent`.
 */
export const defaultInvokeRebaseAgent = (
  args: RebaseAgentInvocation,
): Effect.Effect<RebaseAgentResult, { readonly message: string }> =>
  Effect.gen(function* () {
    const prompt = yield* Effect.promise(() =>
      renderShepherdRebasePrompt({
        issue: args.issue,
        branch: args.branch,
        baseBranch: args.baseBranch,
        mergeableState: args.mergeableState,
        conflictFiles: args.conflictFiles,
      }),
    );
    const result = yield* runSandcastle({
      agent: claudeCode("claude-opus-4-7"),
      sandbox: docker({ env: dockerEnv(args.config) }),
      cwd: args.cwd,
      prompt,
      // VA-456: rebase agent operates ON the impl branch.
      branchStrategy: { type: "branch", branch: args.branch },
      maxIterations: 1,
      name: `shepherd-rebase-${args.issue.identifier}`,
    });
    return parseRebaseVerdict(stringifyResult(result));
  });

/**
 * VA-461: parse the rebase agent's `IMPL: DONE` / `IMPL: BLOCKED`
 * verdict. Mirrors the shape `parseImplVerdict` (src/implement.ts)
 * uses for the main impl loop.
 */
export function parseRebaseVerdict(output: string): RebaseAgentResult {
  const blocked = output.match(/^IMPL:\s*BLOCKED(?:\s*[—-]\s*(.*))?$/im);
  if (blocked) {
    const reason = (blocked[1] ?? "").trim();
    const files = extractConflictFilesFromReason(reason);
    return { kind: "blocked", reason, conflictFiles: files };
  }
  if (/^IMPL:\s*DONE\b/im.test(output)) {
    return { kind: "done" };
  }
  // No marker at all is treated as BLOCKED with a synthetic reason —
  // the loop should escalate rather than silently believe the rebase
  // succeeded.
  return {
    kind: "blocked",
    reason: "rebase agent produced no IMPL: marker",
    conflictFiles: [],
  };
}

/**
 * VA-462 → VA-478: shepherd subscription B — CI failure watcher.
 *
 * Implementation moved to `src/planner-ci.ts` (relocation per ADR
 * 0004 § Migration). Re-exported here for the orchestrator's
 * existing `subscriptions: [..., makeCiWatcher(...)]` wiring.
 */
export {
  defaultInvokeCiFixAgent,
  makeCiWatcher,
  parseCiFixVerdict,
} from "./planner-ci.js";
export type {
  CiFixAgentInvocation,
  CiFixAgentResult,
  CiWatcherDeps,
} from "./planner-ci.js";

// ---------------------------------------------------------------------------
// VA-463 → VA-479: reviewer-comment responder (subscription C)
// Relocated to src/planner-reviewer.ts; re-exported here for the
// orchestrator's inline-shepherd wiring.
// ---------------------------------------------------------------------------

export {
  defaultInvokeReviewerResponseAgent,
  makeReviewerWatcher,
  parsePrReviewVerdict,
  parseReviewerResponseVerdict,
} from "./planner-reviewer.js";
export type {
  PrReviewVerdict,
  ReviewerResponseInvocation,
  ReviewerResponseResult,
  ReviewerWatcherDeps,
} from "./planner-reviewer.js";

function extractConflictFilesFromReason(reason: string): readonly string[] {
  // Format we instruct the agent to produce: "Mergeability: conflict
  // in <file1>, <file2> required human resolution". Anything else is
  // parsed loosely — we accept comma-separated lists after "in" /
  // "conflicts in" / "files".
  // File paths legitimately contain `.` (extensions), so the inner
  // character class only excludes `;` and newlines. The terminator is
  // either " required <word>" or end-of-string.
  const m = reason.match(
    /(?:conflict|conflicts|files)\s+(?:in\s+)?([^;\n]+?)(?:\s+required\s|\s*$)/i,
  );
  if (!m) return [];
  return m[1]!
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * VA-461 → VA-477: subscription A — mergeability watcher.
 *
 * Implementation moved to `src/planner-mergeability.ts` so both the
 * inline shepherd loop (legacy) and the planner harness share a
 * single body. Re-exported here for the orchestrator's existing
 * `subscriptions: [makeMergeabilityWatcher(...)]` wiring.
 */
export {
  makeMergeabilityWatcher,
  type MergeabilityWatcherDeps,
} from "./planner-mergeability.js";

/**
 * Parse the PR number from a GitHub PR URL
 * (`https://github.com/<owner>/<repo>/pull/<n>`). Throws when the URL
 * doesn't match — finalize only hands us GitHub PR URLs, so a parse
 * failure is a precondition violation, not a runtime branch worth
 * handling gracefully.
 */
export function parsePrNumber(prUrl: string): number {
  const m = prUrl.match(/\/pull\/(\d+)(?:[/?#]|$)/);
  if (!m) {
    throw new Error(`shepherd: cannot parse PR number from ${prUrl}`);
  }
  return Number.parseInt(m[1]!, 10);
}

export const runShepherdPass = (
  issue: RunwayIssue,
  deps: ShepherdDeps,
  branch: string,
  prUrl: string,
): Effect.Effect<
  ShepherdOutcome,
  GithubError | { readonly message: string }
> =>
  Effect.gen(function* () {
    const prNumber = parsePrNumber(prUrl);
    const isMerged = deps.isMerged ?? DEFAULT_NO_OP_MERGE_CHECK;
    const subscriptions = deps.subscriptions ?? DEFAULT_SUBSCRIPTIONS;
    const maxQuietPolls = deps.maxQuietPolls ?? DEFAULT_MAX_QUIET_POLLS;
    const maxFixAttempts =
      deps.maxFixAttempts ?? deps.config.shepherdMaxIterations;
    const maxWallSeconds =
      deps.maxWallSeconds ?? deps.config.shepherdMaxWallSeconds;
    const pollSeconds =
      deps.pollIntervalSeconds ?? deps.config.shepherdPollIntervalSeconds;

    const startMs = Date.now();
    let fixCount = 0;
    let quietStreak = 0;
    let lastAction = "(none)";
    let pollIndex = 0;

    // VA-465: emit the start marker with structured attributes the
    // dashboard's `extractShepherdMarkers` reads. The body is the
    // routing key; attributes carry context.
    yield* Effect.logInfo("shepherd.start").pipe(
      Effect.annotateLogs({
        pr: String(prNumber),
        branch,
        issue: issue.identifier,
        maxFixAttempts: String(maxFixAttempts),
        maxWallSeconds: String(maxWallSeconds),
      }),
    );

    while (true) {
      pollIndex++;

      // VA-464: wall-clock budget — checked at the top of every poll
      // so a stuck subscription action that takes minutes can still
      // be capped by it. Fires before merge / subscription work to
      // avoid spending one more API call on an already-doomed loop.
      const elapsedMs = Date.now() - startMs;
      if (elapsedMs >= maxWallSeconds * 1000) {
        const reason =
          `Shepherd wall-clock budget exhausted (${maxWallSeconds}s) — last action: ${lastAction}`;
        yield* Effect.logInfo("shepherd.ended").pipe(
          Effect.annotateLogs({
            pr: String(prNumber),
            outcome: "hitl",
            reason,
          }),
        );
        return { kind: "hitl", reason } as const;
      }

      const ctx: ShepherdContext = {
        issue,
        branch,
        prUrl,
        prNumber,
        cwd: deps.cwd,
        baseBranch: deps.baseBranch,
        config: deps.config,
        github: deps.github,
        iteration: pollIndex,
      };

      const merged = yield* isMerged(ctx);
      if (merged) {
        // VA-465: merged is the success terminal. Use the canonical
        // `shepherd.ended` body so the projector dispatches via
        // `markShepherdEnded` (outcome=merged).
        yield* Effect.logInfo("shepherd.ended").pipe(
          Effect.annotateLogs({
            pr: String(prNumber),
            outcome: "merged",
          }),
        );
        return { kind: "merged" } as const;
      }

      // First non-quiet signal wins — A/B/C are checked in declaration
      // order, so callers control precedence by ordering the array.
      let firedFix = false;
      let subscriptionName = "(unknown)";
      for (let i = 0; i < subscriptions.length; i++) {
        const sub = subscriptions[i]!;
        const signal = yield* sub(ctx);
        if (signal.kind === "hitl") {
          yield* Effect.logInfo("shepherd.ended").pipe(
            Effect.annotateLogs({
              pr: String(prNumber),
              outcome: "hitl",
              reason: signal.reason,
              subscription: `subscription[${i}]`,
            }),
          );
          return { kind: "hitl", reason: signal.reason } as const;
        }
        if (signal.kind === "fix") {
          // VA-464: each fix counts against `maxFixAttempts`. Check
          // BEFORE running the action so the count and the exhaustion
          // exit are deterministic. The Nth fix is the LAST one we
          // run — the (N+1)th attempt becomes the budget-exhausted
          // hitl.
          subscriptionName = `subscription[${i}]`;
          if (fixCount >= maxFixAttempts) {
            const reason =
              `Shepherd iteration budget exhausted (${maxFixAttempts}) — last action: ${lastAction}`;
            yield* Effect.logInfo("shepherd.ended").pipe(
              Effect.annotateLogs({
                pr: String(prNumber),
                outcome: "hitl",
                reason,
              }),
            );
            return { kind: "hitl", reason } as const;
          }
          fixCount++;
          lastAction = `${subscriptionName} on "${signal.description}"`;
          // VA-465: iteration.start marker — drives the sub-card's
          // "acting" state on the dashboard.
          yield* Effect.logInfo("shepherd.iteration.start").pipe(
            Effect.annotateLogs({
              pr: String(prNumber),
              subscription: subscriptionName,
              iteration: String(fixCount),
              maxIterations: String(maxFixAttempts),
              description: signal.description,
            }),
          );
          const out = yield* signal.action;
          if (out.kind === "hitl") {
            // Iteration-end (hitl) AND ended (hitl) both fire — the
            // first refreshes the row's last_seen + description;
            // the second terminates it.
            yield* Effect.logInfo("shepherd.iteration.end").pipe(
              Effect.annotateLogs({
                pr: String(prNumber),
                outcome: "hitl",
                detail: out.reason,
              }),
            );
            yield* Effect.logInfo("shepherd.ended").pipe(
              Effect.annotateLogs({
                pr: String(prNumber),
                outcome: "hitl",
                reason: out.reason,
              }),
            );
            return { kind: "hitl", reason: out.reason } as const;
          }
          yield* Effect.logInfo("shepherd.iteration.end").pipe(
            Effect.annotateLogs({
              pr: String(prNumber),
              outcome: "fixed",
              detail: out.detail,
            }),
          );
          firedFix = true;
          break;
        }
      }

      if (firedFix) {
        // A fix just landed — reset the quiet streak; the new commit
        // may produce CI activity / mergeability changes shortly.
        quietStreak = 0;
      } else {
        quietStreak++;
        if (quietStreak >= maxQuietPolls) {
          const reason =
            `shepherd quiet for ${maxQuietPolls} consecutive poll${maxQuietPolls === 1 ? "" : "s"} ` +
            `with no merge and no actionable signals — PR ready for human merge`;
          yield* Effect.logInfo("shepherd.ended").pipe(
            Effect.annotateLogs({
              pr: String(prNumber),
              outcome: "ready",
              reason,
            }),
          );
          return { kind: "ready", reason } as const;
        }
      }

      // Sleep between polls. Cap the sleep against the wall-clock
      // budget so the next poll runs at the right moment even when
      // the budget is about to fire.
      const remainingMs = maxWallSeconds * 1000 - (Date.now() - startMs);
      if (remainingMs <= 0) continue; // Wall-clock check at top will fire.
      const sleepMs = Math.min(pollSeconds * 1000, remainingMs);
      if (sleepMs > 0) {
        yield* Effect.sleep(Duration.millis(sleepMs));
      }
    }
  }).pipe(Effect.withSpan("shepherd"));
