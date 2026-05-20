import { claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { Duration, Effect } from "effect";
import type { Config } from "./config.js";
import type {
  CheckRun,
  GithubError,
  GithubGateway,
  PrComment,
} from "./github.js";
import type { RunwayIssue } from "./linear.js";
import {
  renderShepherdCiFixPrompt,
  renderShepherdRebasePrompt,
  renderShepherdReviewFixPrompt,
  renderShepherdReviewRespondPrompt,
} from "./prompts.js";
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
 * VA-462: shepherd subscription B — CI failure watcher.
 *
 * Polls `check-runs` for the PR's head SHA, filters to failures, and
 * splits required vs. optional via branch protection. The first
 * required failure each tick fires a `fix` action that launches
 * sandcastle with the existing impl context + the log tail. Optional
 * failures are logged and ignored — they don't burn iteration
 * budget.
 *
 * Per-shepherd-pass de-dupe state lives in the watcher closure
 * (`failureHistory`). The key is the check name; the value tracks
 * the most-recently-seen (errorHash, sha, count). Three rules,
 * applied in order:
 *
 *   1. Same `(name, errorHash, sha)` as the prior poll → quiet. We
 *      already acted on this failure; the new commit hasn't started
 *      CI yet (the AC's "don't re-act on stale SHA").
 *   2. Same `(name, errorHash)` on a NEW sha → increment counter.
 *      Reaching 3 consecutive identical failures across SHAs →
 *      `hitl` with the AC's canonical reason.
 *   3. Anything else (new check, different error, fresh window) →
 *      reset counter to 1 and fire `fix`.
 */
export type CiFixAgentResult =
  | { readonly kind: "done" }
  | { readonly kind: "blocked"; readonly reason: string };

export interface CiFixAgentInvocation {
  readonly issue: RunwayIssue;
  readonly branch: string;
  readonly checkName: string;
  readonly logTail: string;
  readonly cwd: string;
  readonly config: Config;
}

/**
 * Production CI-fix invocation: render the prompt, run one sandcastle
 * iteration, parse the verdict. Tests stub via the watcher deps.
 */
export const defaultInvokeCiFixAgent = (
  args: CiFixAgentInvocation,
): Effect.Effect<CiFixAgentResult, { readonly message: string }> =>
  Effect.gen(function* () {
    const prompt = yield* Effect.promise(() =>
      renderShepherdCiFixPrompt({
        issue: args.issue,
        branch: args.branch,
        checkName: args.checkName,
        logTail: args.logTail,
      }),
    );
    const result = yield* runSandcastle({
      agent: claudeCode("claude-opus-4-7"),
      sandbox: docker({ env: dockerEnv(args.config) }),
      cwd: args.cwd,
      prompt,
      branchStrategy: { type: "branch", branch: args.branch },
      maxIterations: 1,
      name: `shepherd-ci-fix-${args.issue.identifier}-${sanitiseCheckName(args.checkName)}`,
    });
    return parseCiFixVerdict(stringifyResult(result));
  });

/**
 * Parse the CI-fix agent's verdict. Mirrors `parseRebaseVerdict` — same
 * IMPL: DONE / IMPL: BLOCKED markers, same fallback to BLOCKED when
 * no marker fires.
 */
export function parseCiFixVerdict(output: string): CiFixAgentResult {
  const blocked = output.match(/^IMPL:\s*BLOCKED(?:\s*[—-]\s*(.*))?$/im);
  if (blocked) {
    return { kind: "blocked", reason: (blocked[1] ?? "").trim() };
  }
  if (/^IMPL:\s*DONE\b/im.test(output)) {
    return { kind: "done" };
  }
  return {
    kind: "blocked",
    reason: "ci-fix agent produced no IMPL: marker",
  };
}

/**
 * VA-462: stable hash for a log tail used as the de-dup key. Just a
 * cheap DJB2 — collisions don't cause correctness issues here (worst
 * case is one extra re-impl), and we want determinism without a crypto
 * import.
 */
function hashLogTail(s: string): string {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return String(hash);
}

function sanitiseCheckName(name: string): string {
  return name.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 40);
}

interface CiFailureRecord {
  readonly errorHash: string;
  readonly count: number;
  readonly sha: string;
}

export interface CiWatcherDeps {
  readonly github: GithubGateway;
  readonly config: Config;
  /** Production default; tests inject a stub. */
  readonly invokeCiFixAgent?: typeof defaultInvokeCiFixAgent;
  /**
   * VA-462 AC: 3 consecutive identical failures (across SHAs) →
   * HITL. Exposed as a knob mostly for tests, which set it to 2 so
   * the dedup escalation fires without 3 mock sequences.
   */
  readonly maxConsecutiveSameFailure?: number;
}

const DEFAULT_MAX_CONSECUTIVE_SAME_FAILURE = 3;

export function makeCiWatcher(deps: CiWatcherDeps): Subscription {
  const invoke = deps.invokeCiFixAgent ?? defaultInvokeCiFixAgent;
  const maxConsecutive =
    deps.maxConsecutiveSameFailure ?? DEFAULT_MAX_CONSECUTIVE_SAME_FAILURE;
  // Per-PR-shepherd state. The closure lives for the duration of one
  // runShepherdPass invocation; a new PR opens fresh history.
  const failureHistory = new Map<string, CiFailureRecord>();

  return (ctx) =>
    Effect.gen(function* () {
      const pr = yield* deps.github.getPullRequest({
        repoPath: ctx.cwd,
        prNumber: ctx.prNumber,
      });

      // Merged PRs short-circuit before we burn an API call on
      // check-runs. The merge-check upstream is the canonical exit;
      // this is defense-in-depth.
      if (pr.merged) return { kind: "quiet" } as const;

      const checkRuns = yield* deps.github.getCheckRuns({
        repoPath: ctx.cwd,
        sha: pr.headSha,
      });

      const failing = checkRuns.filter(
        (c) => c.status === "completed" && c.conclusion === "failure",
      );
      if (failing.length === 0) return { kind: "quiet" } as const;

      // Branch-protection lookup can return null (no admin / no
      // protection rule); the watcher then treats every check as
      // required to err on the side of acting on failures rather
      // than swallowing them silently.
      const required = yield* deps.github.getRequiredChecks({
        repoPath: ctx.cwd,
        baseBranch: ctx.baseBranch,
      });

      const requiredFailing: readonly CheckRun[] =
        required === null
          ? failing
          : failing.filter((c) => required.includes(c.name));

      if (requiredFailing.length === 0) {
        // Optional failures: surface in logs so the operator sees
        // them but don't burn iteration budget. The AC pinpoints
        // exactly this behavior.
        const names = failing.map((c) => c.name).join(", ");
        yield* Effect.logInfo(
          `${ctx.issue.identifier}: shepherd.ci.optional_failure pr=${pr.number} checks=${names} (no action)`,
        );
        return { kind: "quiet" } as const;
      }

      // First required failure wins for this tick. The next iteration
      // (after the fix lands) re-polls and picks up whatever's still
      // broken.
      const first = requiredFailing[0]!;
      const logTail =
        first.runId !== null
          ? yield* deps.github.getCheckRunLogTail({
              repoPath: ctx.cwd,
              runId: first.runId,
              lines: 50,
            })
          : "";

      const errorHash = hashLogTail(logTail);
      const prior = failureHistory.get(first.name);

      // Rule 1: identical failure on the same SHA → quiet (already acted).
      if (
        prior &&
        prior.errorHash === errorHash &&
        prior.sha === pr.headSha
      ) {
        return { kind: "quiet" } as const;
      }

      // Rule 2: identical failure on a NEW SHA → escalate after the
      // configured threshold.
      if (prior && prior.errorHash === errorHash) {
        const newCount = prior.count + 1;
        failureHistory.set(first.name, {
          errorHash,
          count: newCount,
          sha: pr.headSha,
        });
        if (newCount >= maxConsecutive) {
          const lastLine = lastNonEmptyLine(logTail);
          return {
            kind: "hitl",
            reason: `Repeated CI failure in \`${first.name}\`: ${lastLine}`,
          } as const;
        }
        // else: fall through to fix
      } else {
        // Rule 3: fresh failure window.
        failureHistory.set(first.name, {
          errorHash,
          count: 1,
          sha: pr.headSha,
        });
      }

      const checkName = first.name;
      return {
        kind: "fix",
        description: `Re-impl after CI failure in \`${checkName}\``,
        action: Effect.gen(function* () {
          const result = yield* invoke({
            issue: ctx.issue,
            branch: ctx.branch,
            checkName,
            logTail,
            cwd: ctx.cwd,
            config: deps.config,
          });
          if (result.kind === "blocked") {
            return {
              kind: "hitl",
              reason: `CI fix BLOCKED in \`${checkName}\`: ${result.reason}`,
            } as const;
          }
          return {
            kind: "fixed",
            detail: `Re-impl after \`${checkName}\` failure`,
          } as const;
        }),
      } as const;
    });
}

function lastNonEmptyLine(s: string): string {
  const lines = s.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.length > 0) return line;
  }
  return "(empty log)";
}

// ---------------------------------------------------------------------------
// VA-463 — reviewer-comment responder (subscription C)
// ---------------------------------------------------------------------------

/**
 * VA-463: the adversarial PR-reviewer agent's verdict markers, as
 * documented in `prompts/pr-review.md`. Distinct from
 * `parseReviewVerdict` in `src/review.ts`, which parses the in-run
 * reviewer agent's `REJECTED-RETRY` / `REJECTED-HITL` markers — those
 * never appear in PR comments, only in the implementation-side
 * review loop.
 */
export type PrReviewVerdict =
  | { readonly kind: "approved" }
  | { readonly kind: "changes-requested"; readonly fix: string }
  | { readonly kind: "needs-discussion"; readonly decision: string }
  | { readonly kind: "none" };

/**
 * VA-463: parse a PR-reviewer-bot comment for its `REVIEW: ...` line.
 * Returns `{ kind: "none" }` when the body has no marker (e.g., a
 * status update comment from the bot before the verdict). The regex
 * matches the LAST occurrence — the prompt structure has the verdict
 * line at the end of the comment body.
 */
export function parsePrReviewVerdict(body: string): PrReviewVerdict {
  const matches = Array.from(
    body.matchAll(
      /^REVIEW:\s*(APPROVED|CHANGES-REQUESTED|NEEDS-DISCUSSION)(?:\s*[—-]\s*(.*))?$/gim,
    ),
  );
  if (matches.length === 0) return { kind: "none" };
  const last = matches[matches.length - 1]!;
  const kind = last[1]!.toUpperCase();
  const detail = (last[2] ?? "").trim();
  if (kind === "APPROVED") return { kind: "approved" };
  if (kind === "CHANGES-REQUESTED") {
    return { kind: "changes-requested", fix: detail };
  }
  return { kind: "needs-discussion", decision: detail };
}

/**
 * VA-463: result of one reviewer-response invocation. `done` means
 * the agent reported `IMPL: DONE` (commit + push, or non-actionable
 * no-op); `blocked` carries the agent's reported reason.
 */
export type ReviewerResponseResult =
  | { readonly kind: "done" }
  | { readonly kind: "blocked"; readonly reason: string };

export interface ReviewerResponseInvocation {
  readonly issue: RunwayIssue;
  readonly branch: string;
  readonly cwd: string;
  readonly config: Config;
  /** Distinguishes the two prompt templates. */
  readonly mode:
    | { readonly kind: "fix-request"; readonly fix: string }
    | {
        readonly kind: "verbatim";
        readonly commentAuthor: string;
        readonly commentSource: string;
        readonly commentBody: string;
      };
}

/**
 * Production reviewer-response invocation: pick the right template
 * (parsed CHANGES-REQUESTED fix vs. verbatim human comment), run one
 * sandcastle iteration, parse the IMPL: verdict.
 */
export const defaultInvokeReviewerResponseAgent = (
  args: ReviewerResponseInvocation,
): Effect.Effect<ReviewerResponseResult, { readonly message: string }> =>
  Effect.gen(function* () {
    const prompt = yield* Effect.promise(() =>
      args.mode.kind === "fix-request"
        ? renderShepherdReviewFixPrompt({
            issue: args.issue,
            branch: args.branch,
            fixRequest: args.mode.fix,
          })
        : renderShepherdReviewRespondPrompt({
            issue: args.issue,
            branch: args.branch,
            commentAuthor: args.mode.commentAuthor,
            commentSource: args.mode.commentSource,
            commentBody: args.mode.commentBody,
          }),
    );
    const result = yield* runSandcastle({
      agent: claudeCode("claude-opus-4-7"),
      sandbox: docker({ env: dockerEnv(args.config) }),
      cwd: args.cwd,
      prompt,
      branchStrategy: { type: "branch", branch: args.branch },
      maxIterations: 1,
      name: `shepherd-review-${args.issue.identifier}-${args.mode.kind}`,
    });
    return parseReviewerResponseVerdict(stringifyResult(result));
  });

export function parseReviewerResponseVerdict(
  output: string,
): ReviewerResponseResult {
  const blocked = output.match(/^IMPL:\s*BLOCKED(?:\s*[—-]\s*(.*))?$/im);
  if (blocked) {
    return { kind: "blocked", reason: (blocked[1] ?? "").trim() };
  }
  if (/^IMPL:\s*DONE\b/im.test(output)) {
    return { kind: "done" };
  }
  return {
    kind: "blocked",
    reason: "reviewer-response agent produced no IMPL: marker",
  };
}

export interface ReviewerWatcherDeps {
  readonly github: GithubGateway;
  readonly config: Config;
  /** Production default; tests inject a stub. */
  readonly invokeReviewerResponseAgent?: typeof defaultInvokeReviewerResponseAgent;
}

/**
 * VA-463: subscription C — reviewer-comment responder.
 *
 * Polls PR comments (top-level + review thread + review summaries) on
 * every shepherd tick. Partitions by author:
 *
 *   * Adversarial reviewer bot (`config.prReviewerBotLogin`): parse
 *     for `REVIEW:` marker. APPROVED → quiet. CHANGES-REQUESTED →
 *     fix-request prompt with the parsed fix line. NEEDS-DISCUSSION
 *     → immediate hitl with the canonical reason verbatim.
 *   * Anyone else (human): pass the comment body verbatim to the
 *     respond prompt; agent decides actionable vs. not. BLOCKED →
 *     hitl with the agent's reason.
 *
 * Dedup: per-shepherd-pass Set of responded comment IDs. The first
 * unhandled comment each tick wins; subsequent comments wait for the
 * next iteration. The next pass picks up whatever's still unhandled.
 *
 * Initial snapshot: the first poll records every existing comment ID
 * as already-seen WITHOUT acting on them — only comments posted AFTER
 * the shepherd loop started should trigger work. The PR was just
 * opened; pre-existing comments are noise from prior runs.
 */
export function makeReviewerWatcher(deps: ReviewerWatcherDeps): Subscription {
  const invoke =
    deps.invokeReviewerResponseAgent ?? defaultInvokeReviewerResponseAgent;
  const respondedTo = new Set<number>();
  let primed = false;

  return (ctx) =>
    Effect.gen(function* () {
      const pr = yield* deps.github.getPullRequest({
        repoPath: ctx.cwd,
        prNumber: ctx.prNumber,
      });
      if (pr.merged) return { kind: "quiet" } as const;

      const comments = yield* deps.github.getPullRequestComments({
        repoPath: ctx.cwd,
        prNumber: ctx.prNumber,
      });

      // Initial-snapshot priming: on the first poll, snapshot every
      // existing comment ID into the responded set so we only act on
      // NEW comments posted during this shepherd loop's lifetime.
      // Pre-existing comments (from prior runway runs, manual reviews,
      // etc.) are noise.
      if (!primed) {
        for (const c of comments) respondedTo.add(c.id);
        primed = true;
        return { kind: "quiet" } as const;
      }

      // First unhandled comment wins. Sorted ascending by createdAt
      // already (gateway contract), so this picks the oldest unseen
      // one — gives human reviewers a chance to be answered in order.
      const next = comments.find((c) => !respondedTo.has(c.id));
      if (!next) return { kind: "quiet" } as const;

      // Mark before processing so a poll mid-action doesn't double-fire.
      respondedTo.add(next.id);

      const botLogin = deps.config.prReviewerBotLogin?.trim();
      const isBot =
        Boolean(botLogin) && next.authorLogin === botLogin;

      if (isBot) {
        const verdict = parsePrReviewVerdict(next.body);
        if (verdict.kind === "approved" || verdict.kind === "none") {
          // APPROVED is a positive signal — the shepherd keeps
          // watching CI/mergeability but doesn't fire. NONE is the
          // bot posting a status update without a verdict; same
          // treatment.
          return { kind: "quiet" } as const;
        }
        if (verdict.kind === "needs-discussion") {
          return {
            kind: "hitl",
            reason: `Reviewer flagged needs-discussion: ${verdict.decision || "(no detail provided)"}`,
          } as const;
        }
        // CHANGES-REQUESTED → fix-request prompt path.
        return buildFixSignal(ctx, deps, invoke, {
          kind: "fix-request",
          fix: verdict.fix,
        }, next);
      }

      // Human (non-bot) comment path. Pass the body verbatim — the
      // agent decides whether it's actionable.
      return buildFixSignal(ctx, deps, invoke, {
        kind: "verbatim",
        commentAuthor: next.authorLogin,
        commentSource: next.source,
        commentBody: next.body,
      }, next);
    });
}

function buildFixSignal(
  ctx: ShepherdContext,
  deps: ReviewerWatcherDeps,
  invoke: typeof defaultInvokeReviewerResponseAgent,
  mode: ReviewerResponseInvocation["mode"],
  comment: PrComment,
): SubscriptionSignal {
  const summary =
    mode.kind === "fix-request"
      ? `CHANGES-REQUESTED — ${truncate(mode.fix, 60)}`
      : `${comment.authorLogin || "unknown"} (${comment.source})`;
  return {
    kind: "fix",
    description: `Respond to PR comment: ${summary}`,
    action: Effect.gen(function* () {
      const result = yield* invoke({
        issue: ctx.issue,
        branch: ctx.branch,
        cwd: ctx.cwd,
        config: deps.config,
        mode,
      });
      if (result.kind === "blocked") {
        return {
          kind: "hitl",
          reason:
            mode.kind === "fix-request"
              ? `Reviewer CHANGES-REQUESTED BLOCKED: ${result.reason}`
              : `Reviewer comment BLOCKED (${comment.authorLogin || "unknown"}): ${result.reason}`,
        } as const;
      }
      return {
        kind: "fixed",
        detail:
          mode.kind === "fix-request"
            ? `Addressed reviewer fix-request`
            : `Responded to ${comment.authorLogin || "reviewer"} comment`,
      } as const;
    }),
  };
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= n) return flat;
  return `${flat.slice(0, n - 1)}…`;
}

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
 * VA-461: subscription A — mergeability watcher.
 *
 * Polls the PR's `mergeable_state`. Acts on `dirty` (conflicts) and
 * `behind` (base moved). All other states — including `unknown` (GH
 * still computing) and `clean` (mergeable) — return `quiet`.
 *
 * The fix action launches sandcastle with the rebase prompt against
 * the impl branch (`branchStrategy: { type: "branch", branch }` per
 * VA-456's contract). If the agent reports `IMPL: BLOCKED`, the
 * outcome routes to HITL with the conflicted files surfaced in the
 * reason. On `IMPL: DONE`, the loop continues to the next iteration.
 */
export interface MergeabilityWatcherDeps {
  readonly github: GithubGateway;
  readonly config: Config;
  /**
   * Sandcastle invocation for the rebase agent. Defaulted to the
   * production impl; tests inject a stub to assert prompt + branch
   * strategy without booting Docker.
   */
  readonly invokeRebaseAgent?: typeof defaultInvokeRebaseAgent;
}

export function makeMergeabilityWatcher(
  deps: MergeabilityWatcherDeps,
): Subscription {
  const invoke = deps.invokeRebaseAgent ?? defaultInvokeRebaseAgent;
  return (ctx) =>
    Effect.gen(function* () {
      const pr = yield* deps.github.getPullRequest({
        repoPath: ctx.cwd,
        prNumber: ctx.prNumber,
      });

      // `merged` is handled by the merge-check upstream of subscription
      // polls; defensive return here keeps the watcher idempotent if
      // its merge-check sibling races slow.
      if (pr.merged) return { kind: "quiet" } as const;

      // Only `dirty` and `behind` warrant action. `unknown` happens
      // briefly after a push while GH computes — treat as quiet so
      // the next tick re-evaluates against settled state.
      if (pr.mergeableState !== "dirty" && pr.mergeableState !== "behind") {
        return { kind: "quiet" } as const;
      }

      // Pre-detect conflict files locally. `behind` typically returns
      // an empty list (clean fast-forward); `dirty` returns the paths
      // the agent will need to resolve.
      const conflictFiles = yield* deps.github.getConflictFiles({
        repoPath: ctx.cwd,
        baseBranch: ctx.baseBranch,
        branch: ctx.branch,
      });

      const mergeableState = pr.mergeableState;
      return {
        kind: "fix",
        description: `Rebase ${ctx.branch} onto origin/${ctx.baseBranch} (mergeable_state=${mergeableState})`,
        action: Effect.gen(function* () {
          const result = yield* invoke({
            issue: ctx.issue,
            branch: ctx.branch,
            baseBranch: ctx.baseBranch,
            mergeableState,
            conflictFiles,
            cwd: ctx.cwd,
            config: deps.config,
          });
          if (result.kind === "blocked") {
            const files =
              result.conflictFiles.length > 0
                ? result.conflictFiles
                : conflictFiles;
            const fileList = files.length > 0 ? files.join(", ") : "(unknown)";
            return {
              kind: "hitl",
              reason: `Mergeability: conflict in ${fileList} required human resolution`,
            } as const;
          }
          return {
            kind: "fixed",
            detail: `Rebased ${ctx.branch} onto origin/${ctx.baseBranch}`,
          } as const;
        }),
      } as const;
    });
}

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
