import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
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
import { finalize, formatRebaseConflictReason } from "./finalize.js";

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
   * VA-355: per-issue verdict trail so the operator can scan
   * `runway run`'s exit summary without opening Linear. Order matches
   * the order in which issues were picked up.
   */
  readonly outcomes: readonly IssueOutcome[];
}

export interface IssueOutcome {
  readonly identifier: string;
  readonly kind: "opened" | "hitl" | "reverted" | "errored";
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
  readonly kind: "opened" | "hitl";
  /** PR URL for "opened", or the rejection/HITL reason for "hitl". */
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
  opts: { max?: number; allowPaths?: readonly string[] } = {},
): Effect.Effect<OrchestratorResult, never, never> =>
  Effect.gen(function* () {
    const { config, linear } = deps;
    const max = opts.max ?? Number.POSITIVE_INFINITY;

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

    // VA-344: never re-pick an issue in the same invocation, even if
    // VA-342 reverted it to `Todo`. Without this, a deterministic
    // startup failure (broken .env.schema, missing image, expired
    // token) would loop on the same issue until --max was exhausted.
    const seen = new Set<string>();
    const outcomes: IssueOutcome[] = [];
    let attempts = 0;
    let opened = 0;
    let hitl = 0;
    let errored = 0;

    while (attempts < max) {
      const queue = yield* linear.fetchReady().pipe(
        // Failure to fetch the queue is fatal to the drain (we can't
        // pick the next issue); die rather than infinite-loop on the
        // same error.
        Effect.orDie,
      );
      const issue = queue.find((i) => !seen.has(i.id));
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
              : { "runway.hitl.reason": result.detail }),
          });
          return { errored: false, outcome: result };
        }
        const failureOutcome = yield* handleProcessFailure(
          processed.left,
          issue,
          runDeps,
          branch,
        );
        yield* Effect.annotateCurrentSpan({
          "runway.outcome.kind": failureOutcome.kind,
          "runway.outcome.detail": failureOutcome.detail,
          // True when the issue process exited via the failure path
          // — distinguishes "planned HITL" (kind=hitl, errored=false)
          // from "crashed and routed to HITL" (kind=hitl,
          // errored=true) on the dashboard row.
          "runway.outcome.errored": true,
          // VA-387: only "errored" failure outcomes land on HITL.
          // "reverted" outcomes go back to Todo and never reach a
          // human, so `runway.hitl.reason` would be misleading.
          ...(failureOutcome.kind === "errored"
            ? { "runway.hitl.reason": failureOutcome.detail }
            : {}),
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
    });

    return {
      attempts,
      opened,
      hitl,
      errored,
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

    yield* linear.transition(issue.id, config.inProgressStatus);
    yield* linear.comment(
      issue.id,
      `Runway picked up this issue. Branch: \`${branch}\`.`,
    );

    // VA-366: if a prior attempt left an `agent/<id>` branch behind
    // with zero commits ahead of base (typical of a startup-failure
    // retry), delete it so sandcastle's worktree creation forks from
    // current `baseBranch` HEAD. Preserves the branch when it carries
    // real work. Best-effort — failures here don't abort the issue.
    yield* pruneStaleAgentBranch(deps.cwd, deps.baseBranch, branch).pipe(
      Effect.catchAll((err) =>
        Effect.logWarning(
          `${issue.identifier}: pruneStaleAgentBranch failed (continuing): ${err.message}`,
        ),
      ),
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
        // VA-419: finalize may report `rebase-conflict` when the base
        // branch advanced during this drain and the post-review rebase
        // hit a conflict. Route to HITL with the conflicted-file list
        // — reviewer's APPROVED verdict is preserved in the message so
        // the operator knows the diff was good before the conflict
        // surfaced.
        const finalized = yield* finalize(issue, deps, branch);
        if (finalized.kind === "rebase-conflict") {
          const reason = formatRebaseConflictReason(finalized);
          yield* flagHitl(issue, deps, reason);
          return { kind: "hitl", detail: reason };
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
            : o.kind === "reverted"
              ? "REVERTED → Todo"
              : "INFRA_ERROR";
      console.log(`  ${o.identifier}  ${tag}  ${o.detail}`);
    }
  });

