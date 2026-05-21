import { existsSync } from "node:fs";
import { join } from "node:path";
import { Duration, Effect, Schedule } from "effect";
import type { Config } from "./config.js";
import { detectBaseBranch, pruneStaleAgentBranch } from "./git.js";
import type { GithubError, GithubGateway } from "./github.js";
import type { LinearError, LinearGateway, RunwayIssue } from "./linear.js";
import { loadPolicy, type Policy } from "./policy.js";
import { flagHitl, handleProcessFailure } from "./hitl.js";
import { runImplementLoop } from "./implement.js";
import {
  formatInRunReviewerFeedback,
  formatPriorFeedback,
} from "./prompts.js";
import { runReviewPass } from "./review.js";
import {
  makeCiWatcher,
  makeIsMerged,
  makeMergeabilityWatcher,
  makeReviewerWatcher,
  runShepherdPass,
} from "./shepherd.js";
import {
  finalize,
  formatRebaseConflictReason,
  formatRebaseFailureReason,
} from "./finalize.js";

// Re-exports so existing callers (commands/run.ts) and tests
// (orchestrator.test.ts) keep working without import churn. The
// verdict parsers and the ADT now live alongside the phase code
// that uses them, but this module is still the public face of
// orchestration.
export { parseImplVerdict } from "./implement.js";
export { parseReviewVerdict, type ParsedVerdict } from "./review.js";

export interface OrchestratorDeps {
  readonly config: Config;
  readonly linear: LinearGateway;
  readonly github: GithubGateway;
  /** Absolute path of the target repo. Defaults to process.cwd(). */
  readonly cwd: string;
}

export interface OrchestratorResult {
  /**
   * Number of issues attempted in this invocation. VA-344: `--max`
   * caps attempts, not successes — a deterministic startup failure
   * still consumes one attempt so we don't loop on the same broken
   * issue forever.
   */
  readonly attempts: number;
  readonly opened: number;
  readonly hitl: number;
  readonly errored: number;
  /**
   * VA-423: count of issues skipped because the
   * `ready-for-agent` label was already removed at claim time
   * (another runner won the race). Tracked separately from
   * `errored` because nothing actually went wrong — the issue is
   * being handled by the winning run.
   */
  readonly skipped: number;
  /**
   * VA-355: per-issue verdict trail so the operator can scan
   * `runway run`'s exit summary without opening Linear. Order matches
   * the order in which issues were picked up.
   */
  readonly outcomes: readonly IssueOutcome[];
}

export interface IssueOutcome {
  readonly identifier: string;
  // VA-423: the `reverted` outcome retired with the status-mutation
  // model — every failure now lands on `ready-for-human` via the
  // HITL path. The `skipped` variant is the lost-claim-race signal
  // (another runner removed `ready-for-agent` between fetchReady
  // and the pickup write). Distinct buckets remain for the
  // dashboard and the exit summary: `opened` = PR opened, `hitl` =
  // planned HITL or crashed-into-HITL, `errored` = same as HITL on
  // the data side but flagged separately so a per-run "things
  // actually crashed" count survives, `skipped` = lost race.
  readonly kind: "opened" | "hitl" | "errored" | "skipped";
  readonly detail: string;
}

/**
 * Confirms the cwd looks like a sandcastle-initialised repo. If not,
 * we error early with a clear message rather than letting Sandcastle
 * fail deep inside Docker setup.
 */
export function assertSandcastleInitialised(cwd: string): void {
  const sandcastleDir = join(cwd, ".sandcastle");
  if (!existsSync(sandcastleDir)) {
    throw new Error(
      `No .sandcastle/ directory in ${cwd}. Run \`npx sandcastle init\` here first.`,
    );
  }
}

// VA-358: the error union processIssue can yield. drainQueue catches
// the lot via `Effect.either` and routes to the revert / HITL path
// based on whether the agent produced commits — we don't need to
// pattern-match here, just extract a message.
type ProcessIssueError =
  | LinearError
  | GithubError
  | { readonly _tag?: string; readonly message: string };

interface ProcessOutcome {
  readonly kind: "opened" | "hitl" | "skipped";
  /**
   * - `opened`: PR URL.
   * - `hitl`: the rejection / HITL reason.
   * - `skipped`: VA-423 lost-claim-race reason ("another runner
   *   already removed `ready-for-agent`"). The orchestrator does
   *   none of the visible per-issue side-effects (no pickup
   *   comment, no agent branch push) on this branch.
   */
  readonly detail: string;
}

interface ResolvedDeps extends OrchestratorDeps {
  /** Default branch of the cwd repo. Resolved once in drainQueue. */
  readonly baseBranch: string;
  /** Effective write-path policy (VA-352). Resolved once in drainQueue. */
  readonly policy: Policy;
  /**
   * VA-383: effective author allowlist for surfacing prior-attempt
   * review feedback. Resolved once at drain startup — either from
   * `config.commentAuthorAllowlist` or, when unset, from the Linear
   * viewer's name (the API key's identity, which is who both runway
   * and the reviewer post comments under).
   */
  readonly commentAuthorAllowlist: readonly string[];
}

/**
 * VA-358: drains the Linear queue as a single Effect program with
 * spans at every pipeline stage and structured-field logs (issue id,
 * branch, stage, duration). Externally still appears to "do the
 * loop" — `Effect.runPromise` at the cli.ts boundary turns it back
 * into a Promise<OrchestratorResult>.
 *
 * Error channel is `never` because the function folds every per-issue
 * failure into an `IssueOutcome` (revert / errored / HITL) rather than
 * propagating. The whole drain only halts when the queue is empty or
 * `--max` is reached.
 */
export const drainQueue = (
  deps: OrchestratorDeps,
  opts: {
    max?: number;
    allowPaths?: readonly string[];
    /**
     * VA-480: restrict the drain to a single Linear issue identifier.
     * When set, drainQueue filters the ready queue to just this
     * identifier and exits as soon as it's been picked (or errors if
     * the identifier isn't present in the queue).
     */
    target?: string;
  } = {},
): Effect.Effect<OrchestratorResult, never, never> =>
  Effect.gen(function* () {
    const { config, linear } = deps;
    const max = opts.max ?? Number.POSITIVE_INFINITY;

    // VA-455: announce the drain to the dashboard before any other
    // work. The log carries the drainQueue span's trace_id/span_id
    // (we're already inside `Effect.withSpan("drainQueue")`), and the
    // dashboard's projector matches on the literal body string —
    // keep it in lock-step with `DRAIN_STARTED_LOG` in projector.ts.
    yield* Effect.logInfo("drain.started");

    // VA-455: keep the dashboard's "still alive" signal warm during
    // long impl/review phases. `Effect.fork` ties the heartbeat fiber
    // to this gen's lifetime, so it's interrupted automatically when
    // drainQueue completes (success, failure, or interrupt). The 30s
    // cadence matches `ACTIVE_DRAIN_STALENESS_NANOS / 3` on the
    // dashboard so a single dropped flush doesn't toggle the card.
    yield* Effect.fork(
      Effect.logInfo("drain.heartbeat").pipe(
        Effect.repeat(Schedule.spaced(Duration.seconds(30))),
      ),
    );

    // Resolve the base branch once at startup so every issue in the
    // drain sees the same answer (and so a misconfigured repo fails
    // fast, before we touch any Linear state).
    const baseBranchResolved = yield* (
      config.baseBranch
        ? Effect.succeed(config.baseBranch)
        : detectBaseBranch(deps.cwd)
    ).pipe(
      Effect.catchAll((err) =>
        Effect.fail({
          _tag: "BaseBranchDetectionFailed" as const,
          message: err.message,
        }),
      ),
      // If base-branch detection fails, the whole drain is dead in the
      // water (we'd diff against an undefined branch). Surface it as a
      // top-level defect; drainQueue's `never` error type is preserved
      // because the unrecoverable failure dies the fiber, not the
      // error channel.
      Effect.orDie,
    );
    yield* Effect.logInfo("base branch resolved").pipe(
      Effect.annotateLogs({ baseBranch: baseBranchResolved }),
    );

    const policy = loadPolicy(deps.cwd, { allowPathsOverride: opts.allowPaths });
    yield* Effect.logInfo(`policy source: ${policy.source}`);

    // VA-383: resolve the Linear viewer once per drain to seed the
    // default comment-author allowlist. If the operator has provided
    // an explicit allowlist, skip the lookup. If the lookup fails,
    // fall back to an empty allowlist — `formatPriorFeedback` will
    // emit nothing and the run proceeds with description-only
    // context (matching VA-383's "never blocks the run" AC).
    const commentAuthorAllowlist: readonly string[] = config
      .commentAuthorAllowlist?.length
      ? config.commentAuthorAllowlist
      : yield* linear.viewer().pipe(
          Effect.map((v) => [v.name] as const),
          Effect.catchAll((err) =>
            Effect.logWarning(
              `VA-383: viewer() failed; prior-attempt feedback will be empty (${
                (err as { message?: string }).message ?? String(err)
              })`,
            ).pipe(Effect.as([] as const)),
          ),
        );
    yield* Effect.logInfo(
      `comment author allowlist: ${
        commentAuthorAllowlist.length === 0
          ? "(empty — prior-feedback surfacing disabled)"
          : commentAuthorAllowlist.join(", ")
      }`,
    );

    const runDeps: ResolvedDeps = {
      ...deps,
      baseBranch: baseBranchResolved,
      policy,
      commentAuthorAllowlist,
    };

    // VA-344: never re-pick an issue in the same invocation. After
    // VA-423, the `ready-for-agent` label is stripped on pickup so
    // a fresh `fetchReady` shouldn't re-surface a just-attempted
    // issue anyway — but a same-invocation guard is still cheap
    // insurance against a Linear eventual-consistency edge re-
    // returning the issue before the label-removal write has
    // propagated.
    const seen = new Set<string>();
    const outcomes: IssueOutcome[] = [];
    let attempts = 0;
    let opened = 0;
    let hitl = 0;
    let errored = 0;
    let skipped = 0;

    while (attempts < max) {
      const queue = yield* linear.fetchReady().pipe(
        // Failure to fetch the queue is fatal to the drain (we can't
        // pick the next issue); die rather than infinite-loop on the
        // same error.
        Effect.orDie,
      );
      // VA-480: when `opts.target` is set, filter the queue to that
      // identifier. If the target isn't in the ready queue (already
      // picked up, label removed, or wrong identifier), exit with a
      // clear log line — the planner's drain-spawn path treats this
      // as a `errored` outcome.
      const filtered = opts.target
        ? queue.filter((i) => i.identifier === opts.target)
        : queue;
      if (opts.target && filtered.length === 0) {
        yield* Effect.logWarning(
          `target ${opts.target} not present in ready queue — exiting`,
        );
        break;
      }
      const issue = filtered.find((i) => !seen.has(i.id));
      if (!issue) break;
      seen.add(issue.id);
      attempts += 1;

      const branch = `agent/${issue.identifier.toLowerCase()}`;

      // VA-386: the dashboard projector reads the final outcome from
      // the processIssue span's attributes. Compute it inside the
      // span scope (so `annotateCurrentSpan` targets `processIssue`,
      // not `drainQueue`) and route afterwards.
      //
      // VA-387: annotate `runway.pr.url` on opened outcomes and
      // `runway.hitl.reason` on HITL outcomes (both planned and
      // failure-routed) so the detail pane can render the GitHub
      // link / human-review reason without re-parsing the generic
      // `runway.outcome.detail` string.
      const resolved = yield* Effect.gen(function* () {
        const processed = yield* processIssue(issue, runDeps).pipe(
          Effect.either,
        );
        if (processed._tag === "Right") {
          const result = processed.right;
          yield* Effect.annotateCurrentSpan({
            "runway.outcome.kind": result.kind,
            "runway.outcome.detail": result.detail,
            ...(result.kind === "opened"
              ? { "runway.pr.url": result.detail }
              : result.kind === "hitl"
                ? { "runway.hitl.reason": result.detail }
                : {}),
          });
          return { errored: false, outcome: result };
        }
        const failureOutcome = yield* handleProcessFailure(
          processed.left,
          issue,
          runDeps,
        );
        yield* Effect.annotateCurrentSpan({
          "runway.outcome.kind": failureOutcome.kind,
          "runway.outcome.detail": failureOutcome.detail,
          // True when the issue process exited via the failure path
          // — distinguishes "planned HITL" (kind=hitl, errored=false)
          // from "crashed and routed to HITL" (kind=hitl,
          // errored=true) on the dashboard row.
          "runway.outcome.errored": true,
          // VA-387 / VA-423: failure outcomes always land on HITL now;
          // surface the reason as `runway.hitl.reason` for the
          // dashboard detail pane.
          "runway.hitl.reason": failureOutcome.detail,
        });
        return { errored: true, outcome: failureOutcome };
      }).pipe(
        Effect.withSpan("processIssue", {
          attributes: {
            "runway.issue.identifier": issue.identifier,
            "runway.issue.id": issue.id,
            "runway.issue.title": issue.title,
            // OTel encodes string[] as arrayValue on the wire. The
            // projector decodes it back via `attrMap`.
            "runway.issue.labels": [...issue.labels],
            "runway.branch": branch,
          },
        }),
        Effect.annotateLogs({
          issue: issue.identifier,
          branch,
        }),
      );

      if (resolved.errored) {
        errored += 1;
      } else {
        if (resolved.outcome.kind === "opened") opened += 1;
        if (resolved.outcome.kind === "hitl") hitl += 1;
        if (resolved.outcome.kind === "skipped") skipped += 1;
      }
      outcomes.push({
        identifier: issue.identifier,
        kind: resolved.outcome.kind,
        detail: resolved.outcome.detail,
      });
    }

    yield* printExitSummary(outcomes);

    // VA-386: counter attributes on the drain span so the dashboard's
    // drain row carries the same totals as runway's exit summary.
    yield* Effect.annotateCurrentSpan({
      "runway.drain.attempts": attempts,
      "runway.drain.opened": opened,
      "runway.drain.hitl": hitl,
      "runway.drain.errored": errored,
      "runway.drain.skipped": skipped,
    });

    return {
      attempts,
      opened,
      hitl,
      errored,
      skipped,
      outcomes,
    } satisfies OrchestratorResult;
  }).pipe(Effect.withSpan("drainQueue"));

/**
 * Per-issue composer. Claims the issue on Linear, drives the
 * implement → review → finalize phase chain, and routes any HITL
 * outcome to `flagHitl`. Each phase decides; the composer enacts the
 * Linear side-effects so the phases stay independently testable.
 */
const processIssue = (
  issue: RunwayIssue,
  deps: ResolvedDeps,
): Effect.Effect<ProcessOutcome, ProcessIssueError, never> =>
  Effect.gen(function* () {
    const { config, linear, commentAuthorAllowlist } = deps;
    const branch = `agent/${issue.identifier.toLowerCase()}`;

    // VA-423: claim the issue by removing the `ready-for-agent`
    // label BEFORE any other side-effect. The gateway returns
    // `removed: false` when the label was already absent at read
    // time — another runner picked the issue between fetchReady and
    // here, or an operator removed the label. Bail out before the
    // pickup comment / agent branch push so the losing runner
    // doesn't post visible bookkeeping for work it didn't do.
    //
    // Linear's GitHub integration will move the workflow status to
    // `In Progress` automatically when the winner's PR opens (and
    // to `Done` when it merges), so runway no longer issues any
    // state mutations of its own.
    const claim = yield* linear.removeLabel(issue.id, config.readyLabel);
    if (!claim.removed) {
      yield* Effect.logInfo(
        `${issue.identifier}: lost claim race — \`${config.readyLabel}\` was already absent at pickup; skipping`,
      );
      return {
        kind: "skipped" as const,
        detail: `claim race lost: \`${config.readyLabel}\` already absent at pickup`,
      };
    }

    // VA-383: fetch prior comments BEFORE posting "Runway picked up
    // this issue" so we don't see our own bookkeeping. The allowlist
    // resolved at drain startup filters to reviewer/repo-owner
    // identities; `formatPriorFeedback` additionally strips known
    // runway bookkeeping prefixes. A fetch failure logs a warning and
    // the run proceeds with empty feedback (never blocks).
    const priorFeedback = yield* (
      commentAuthorAllowlist.length === 0
        ? Effect.succeed("")
        : linear.fetchComments(issue.id).pipe(
            Effect.map((cs) =>
              formatPriorFeedback(cs, commentAuthorAllowlist),
            ),
            Effect.catchAll((err) =>
              Effect.logWarning(
                `${issue.identifier}: fetchComments failed; proceeding with description-only context (${
                  (err as { message?: string }).message ?? String(err)
                })`,
              ).pipe(Effect.as("")),
            ),
          )
    );

    yield* linear.comment(
      issue.id,
      `Runway picked up this issue. Branch: \`${branch}\`.`,
    );

    // VA-366 + VA-417: keep the agent branch from carrying state
    // forward across drains.
    //   - VA-366: if a prior attempt left `agent/<id>` behind with no
    //     commits (typical of a startup-failure retry), delete it.
    //   - VA-417: if `agent/<id>` carries commits from a prior attempt
    //     that review rejected, reset it to `origin/<baseBranch>` so
    //     the impl agent doesn't observe the rejected diff and signal
    //     `IMPL: DONE` without modification.
    // The function fails ONLY with `AgentBranchResetTargetUnreachable`
    // (origin/<base> AND local <base> both missing — env/config
    // issue). `Effect.orDie` kills the drain so the operator fixes
    // the env rather than re-trigger the no-op pattern; other git
    // failures inside the function are already swallowed there.
    yield* pruneStaleAgentBranch(deps.cwd, deps.baseBranch, branch).pipe(
      Effect.orDie,
    );

    // VA-418: in-run review-rejection retry loop. Each iteration runs
    // impl, then review; on `rejected-retry` (and remaining budget),
    // we append the rejection reason to `inRunRejections`, re-render
    // the impl prompt with the full chain in the
    // `{{IN_RUN_REVIEWER_FEEDBACK}}` slot, and try again. `attempt`
    // counts the impl+review pairs we've launched; the budget is
    // `1 + config.reviewRetries`, matching VA-414's pattern (default
    // 1 means up to 2 total pairs per drain pickup). `0` disables the
    // loop entirely: every rejection escalates immediately.
    const retryBudget = Math.max(0, config.reviewRetries);
    const inRunRejections: string[] = [];
    let attempt = 0;
    while (true) {
      attempt += 1;
      const impl = yield* runImplementLoop(
        issue,
        {
          ...deps,
          priorFeedback,
          inRunReviewerFeedback: formatInRunReviewerFeedback(inRunRejections),
        },
        branch,
      );
      if (impl.kind === "hitl") {
        yield* flagHitl(issue, deps, impl.reason);
        return { kind: "hitl", detail: impl.reason };
      }

      const review = yield* runReviewPass(issue, deps, branch);
      if (review.kind === "approved") {
        // VA-419 / VA-424: finalize may report `rebase-conflict` (real
        // merge conflicts) or `rebase-failure` (non-zero rebase exit
        // with no unmerged files — e.g., dirty host worktree, signing
        // hook). Both route to HITL but with distinct diagnostics so
        // the operator sees the real cause. Reviewer's APPROVED
        // verdict is preserved in either message.
        const finalized = yield* finalize(issue, deps, branch);
        if (finalized.kind === "rebase-conflict") {
          const reason = formatRebaseConflictReason(finalized);
          yield* flagHitl(issue, deps, reason);
          return { kind: "hitl", detail: reason };
        }
        if (finalized.kind === "rebase-failure") {
          const reason = formatRebaseFailureReason(finalized);
          yield* flagHitl(issue, deps, reason);
          return { kind: "hitl", detail: reason };
        }
        // VA-460: post-finalize shepherd loop. Gated off by default —
        // first ship lands the scaffolding only; VA-461..463 wire the
        // mergeability / CI / reviewer subscriptions, VA-464 the
        // budget knobs. When gated off the composer returns the
        // `opened` outcome verbatim, preserving the historical
        // behavior.
        if (deps.config.shepherdEnabled) {
          const shepherd = yield* runShepherdPass(
            issue,
            {
              config: deps.config,
              cwd: deps.cwd,
              baseBranch: deps.baseBranch,
              github: deps.github,
              // VA-461 / VA-462 / VA-463: three real subscriptions
              // wired in precedence order. Mergeability runs first
              // (a dirty base would prevent CI from even running);
              // CI second; reviewer feedback last (CI fixes that
              // address reviewer concerns push commits which will
              // be seen on the next tick).
              isMerged: makeIsMerged(deps.github),
              subscriptions: [
                makeMergeabilityWatcher({
                  github: deps.github,
                  config: deps.config,
                }),
                makeCiWatcher({
                  github: deps.github,
                  config: deps.config,
                }),
                makeReviewerWatcher({
                  github: deps.github,
                  config: deps.config,
                }),
              ],
            },
            branch,
            finalized.detail,
          );
          if (shepherd.kind === "hitl") {
            const reason = `Shepherd routed PR to HITL: ${shepherd.reason}`;
            yield* flagHitl(issue, deps, reason);
            return { kind: "hitl", detail: reason };
          }
          // `merged` and `ready` both preserve the `opened` outcome —
          // the PR exists; whether it's merged yet doesn't change the
          // per-issue verdict the operator sees in the exit summary.
        }
        return finalized;
      }
      if (review.kind === "hitl") {
        // Crashed / truncated marker — distinct from a real rejection.
        yield* flagHitl(issue, deps, review.reason);
        return { kind: "hitl", detail: review.reason };
      }
      if (review.kind === "rejected-hitl") {
        // Reviewer judged the rejection to need human input. Escalate
        // immediately — no more impl attempts this drain.
        const reason = `Sub-agent review rejected (needs human judgment): ${review.reason}`;
        yield* flagHitl(issue, deps, reason);
        return { kind: "hitl", detail: reason };
      }
      // rejected-retry: mechanically fixable. Hand the reason back to
      // the impl agent on the next attempt, unless the retry budget is
      // exhausted.
      inRunRejections.push(review.reason);
      if (attempt > retryBudget) {
        // Budget exhausted. Escalate to HITL with a message that
        // names the FINAL rejection reason plus the chain length so
        // the operator can see how many attempts we burned through.
        const reason = `Ran out of review retries (${attempt} attempt${
          attempt === 1 ? "" : "s"
        }); last rejection: ${review.reason}`;
        yield* flagHitl(issue, deps, reason);
        return { kind: "hitl", detail: reason };
      }
      yield* Effect.logInfo(
        `${issue.identifier}: review rejected-retry; retrying impl with reviewer feedback (attempt ${
          attempt + 1
        } of ${retryBudget + 1})`,
      );
    }
  });


/**
 * VA-355: render a per-issue verdict trail at the end of the drain so
 * the operator can scan results without opening Linear. Skipped when
 * no issues were attempted.
 */
const printExitSummary = (
  outcomes: readonly IssueOutcome[],
): Effect.Effect<void, never, never> =>
  Effect.sync(() => {
    if (outcomes.length === 0) return;
    console.log("\n[runway] per-issue outcomes:");
    for (const o of outcomes) {
      const tag =
        o.kind === "opened"
          ? "APPROVED → PR opened"
          : o.kind === "hitl"
            ? "HITL"
            : o.kind === "skipped"
              ? "SKIPPED (claim race lost)"
              : "INFRA_ERROR";
      console.log(`  ${o.identifier}  ${tag}  ${o.detail}`);
    }
  });

