import { claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { Duration, Effect } from "effect";
import type { Config } from "./config.js";
import type { CheckRun, GithubError, GithubGateway } from "./github.js";
import type { RunwayIssue } from "./linear.js";
import {
  renderShepherdCiFixPrompt,
  renderShepherdRebasePrompt,
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
  /** Override for tests; production hardcodes 3 (becomes config in VA-464). */
  readonly maxIterations?: number;
}

export type ShepherdOutcome =
  | { readonly kind: "merged" }
  | { readonly kind: "ready"; readonly reason: string }
  | { readonly kind: "hitl"; readonly reason: string };

/**
 * VA-464 follow-up will read this from `config.shepherdMaxIterations`.
 * Hardcoded here so the scaffolding ships without a half-finished
 * config knob — the feature gate keeps the loop from running in
 * production until VA-461..463 land anyway.
 */
const DEFAULT_MAX_ITERATIONS = 3;

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
    const maxIterations = deps.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const pollSeconds =
      deps.pollIntervalSeconds ?? deps.config.shepherdPollIntervalSeconds;

    yield* Effect.logInfo(
      `${issue.identifier}: shepherd.start pr=${prUrl} branch=${branch} ` +
        `maxIterations=${maxIterations} pollSeconds=${pollSeconds}`,
    );

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      const ctx: ShepherdContext = {
        issue,
        branch,
        prUrl,
        prNumber,
        cwd: deps.cwd,
        baseBranch: deps.baseBranch,
        config: deps.config,
        github: deps.github,
        iteration,
      };

      const merged = yield* isMerged(ctx);
      if (merged) {
        yield* Effect.logInfo(
          `${issue.identifier}: shepherd.merged pr=${prUrl} iteration=${iteration}`,
        );
        return { kind: "merged" } as const;
      }

      // First non-quiet signal wins — A/B/C are checked in declaration
      // order, so callers control precedence by ordering the array.
      let firedFix = false;
      for (const sub of subscriptions) {
        const signal = yield* sub(ctx);
        if (signal.kind === "hitl") {
          yield* Effect.logInfo(
            `${issue.identifier}: shepherd.hitl iteration=${iteration} reason=${signal.reason}`,
          );
          return { kind: "hitl", reason: signal.reason } as const;
        }
        if (signal.kind === "fix") {
          yield* Effect.logInfo(
            `${issue.identifier}: shepherd.fix.start iteration=${iteration} description=${signal.description}`,
          );
          const out = yield* signal.action;
          if (out.kind === "hitl") {
            yield* Effect.logInfo(
              `${issue.identifier}: shepherd.fix.hitl iteration=${iteration} reason=${out.reason}`,
            );
            return { kind: "hitl", reason: out.reason } as const;
          }
          yield* Effect.logInfo(
            `${issue.identifier}: shepherd.fix.done iteration=${iteration} detail=${out.detail}`,
          );
          firedFix = true;
          break; // Next iteration re-checks merged + subscriptions.
        }
      }
      // Quiet vs. fired-fix distinction matters for the test that
      // asserts "no fix → next iteration after sleep" vs. "fix fired
      // → next iteration immediately."
      void firedFix;

      // Sleep between polls — but not after the final iteration,
      // since the loop is about to exit `ready` anyway.
      if (iteration < maxIterations) {
        yield* Effect.sleep(Duration.seconds(pollSeconds));
      }
    }

    const reason =
      `shepherd completed ${maxIterations} poll${maxIterations === 1 ? "" : "s"} ` +
      `with no merge and no actionable signals — PR ready for human merge`;
    yield* Effect.logInfo(`${issue.identifier}: shepherd.ready ${reason}`);
    return { kind: "ready", reason } as const;
  }).pipe(Effect.withSpan("shepherd"));
