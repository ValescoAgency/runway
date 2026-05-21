import { Effect } from "effect";
import type { Config } from "./config.js";
import {
  PLANNER_ACTION_COMPLETED_LOG,
  PLANNER_ACTION_FAILED_LOG,
  PLANNER_ACTION_STARTED_LOG,
  PLANNER_RECOMMENDATION_PROPOSED_LOG,
} from "./dashboard/projector.js";
import {
  autoAcceptIfEligible,
  resolveCapabilityMode,
} from "./planner-capability-mode.js";
import type { GithubGateway } from "./github.js";
import type { RunwayIssue } from "./linear.js";
import type {
  OpenShepherdedPrRow,
  PlannerReadClient,
} from "./planner-storage.js";
import {
  defaultInvokeRebaseAgent,
  parsePrNumber,
  type ShepherdContext,
  type Subscription,
  type SubscriptionSignal,
} from "./shepherd.js";

/**
 * VA-477: mergeability capability for the planner daemon. The
 * subscription body (`makeMergeabilityWatcher`) is the same one the
 * inline shepherd used in VA-461 — relocated here per ADR 0004
 * § Migration so callers from both the legacy shepherd loop AND the
 * planner harness share a single implementation. The planner-side
 * dispatcher (`evaluateMergeability`) iterates open shepherded PRs
 * from the dashboard's read-projection and translates the
 * subscription's `SubscriptionSignal` into planner OTLP events:
 *
 *   - `fix` signal, no prior recommendation → `recommendation.proposed`
 *   - existing `accepted` recommendation, no in-flight action → run
 *     the fix action, then `action.started` + `action.completed` /
 *     `action.failed` framing
 *   - `quiet` or `hitl` → no emission (`hitl` goes through the
 *     legacy inline path until VA-482 retires it)
 *
 * Recommendation IDs are stable per PR (`shepherd-mergeability:PR-<n>`)
 * so an `INSERT OR IGNORE` on the dashboard side absorbs duplicate
 * proposals across ticks. Action IDs include a per-attempt timestamp
 * so a retry after rejection creates a fresh row.
 */

export const MERGEABILITY_CAPABILITY = "shepherd-mergeability";

// ---------------------------------------------------------------------------
// Relocated subscription (VA-461) — unchanged from src/shepherd.ts.
// ---------------------------------------------------------------------------

/**
 * Subscription A — mergeability watcher.
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

// ---------------------------------------------------------------------------
// Capability dispatcher (VA-477).
// ---------------------------------------------------------------------------

export interface MergeabilityCapabilityContext {
  readonly readClient: PlannerReadClient;
  readonly github: GithubGateway;
  readonly config: Config;
  /** Working-tree path the rebase agent runs against. */
  readonly cwd: string;
  /** Base branch the watcher rebases onto. */
  readonly baseBranch: string;
  /** Same override surface as the watcher. */
  readonly invokeRebaseAgent?: typeof defaultInvokeRebaseAgent;
  /**
   * Wall-clock timestamp generator (unix-nano string). Production
   * passes `() => String(Date.now() * 1_000_000)`; tests inject a
   * monotonically-increasing fixture for snapshot stability.
   */
  readonly now: () => string;
}

export interface MergeabilityEvalResult {
  readonly proposed: readonly string[];
  readonly actionsCompleted: readonly string[];
  readonly actionsFailed: readonly string[];
}

const EMPTY: MergeabilityEvalResult = {
  proposed: [],
  actionsCompleted: [],
  actionsFailed: [],
};

const stableRecommendationId = (prNumber: number): string =>
  `${MERGEABILITY_CAPABILITY}:PR-${prNumber}`;

const actionIdFor = (prNumber: number, nowNano: string): string =>
  `${MERGEABILITY_CAPABILITY}:PR-${prNumber}:${nowNano}`;

const rowToRunwayIssue = (row: OpenShepherdedPrRow): RunwayIssue => ({
  id: row.issueId ?? "",
  identifier: row.issueIdentifier,
  title: row.issueTitle ?? row.issueIdentifier,
  description: "",
  labels: row.issueLabels,
});

/**
 * One planner-tick pass of the mergeability capability. Iterates open
 * shepherded PRs from the read-projection, evaluates the watcher for
 * each, and emits the appropriate planner events. Errors from the
 * watcher (GH gateway failures, parse errors) are caught + logged at
 * the per-PR level so one broken PR doesn't poison the rest of the
 * tick.
 */
export const evaluateMergeability = (
  ctx: MergeabilityCapabilityContext,
): Effect.Effect<MergeabilityEvalResult> =>
  Effect.gen(function* () {
    // VA-481: manual → silent capability.
    const mode = resolveCapabilityMode(ctx.readClient, MERGEABILITY_CAPABILITY);
    if (mode === "manual") return EMPTY;

    const prs = ctx.readClient.listOpenShepherdedPrs();
    if (prs.length === 0) return EMPTY;

    const watcher = makeMergeabilityWatcher({
      github: ctx.github,
      config: ctx.config,
      invokeRebaseAgent: ctx.invokeRebaseAgent,
    });

    const proposed: string[] = [];
    const actionsCompleted: string[] = [];
    const actionsFailed: string[] = [];

    for (const row of prs) {
      yield* evaluateOnePr({
        ctx,
        row,
        watcher,
        mode,
        proposed,
        actionsCompleted,
        actionsFailed,
      }).pipe(
        // Per-PR failures stay local. The Effect runtime's error
        // channel is `never` for this capability — one PR's GH
        // outage must not abort the rest of the tick.
        Effect.catchAllCause((cause) =>
          Effect.logError("planner.capability.error").pipe(
            Effect.annotateLogs({
              capability: MERGEABILITY_CAPABILITY,
              target: `PR-${row.prNumber}`,
              cause: cause.toString(),
            }),
          ),
        ),
      );
    }

    return { proposed, actionsCompleted, actionsFailed };
  });

interface EvaluateOnePrArgs {
  readonly ctx: MergeabilityCapabilityContext;
  readonly row: OpenShepherdedPrRow;
  readonly watcher: Subscription;
  readonly mode: import("./dashboard/storage.js").PlannerCapabilityMode;
  readonly proposed: string[];
  readonly actionsCompleted: string[];
  readonly actionsFailed: string[];
}

const evaluateOnePr = (
  args: EvaluateOnePrArgs,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const { ctx, row, watcher } = args;
    const recommendationId = stableRecommendationId(row.prNumber);
    const existing = ctx.readClient.getRecommendation(recommendationId);

    // Status gates:
    //   undefined           → maybe propose
    //   proposed | rejected → nothing this tick (rejected is terminal;
    //                         operator removes + re-adds the
    //                         ready-for-shepherd state to retry)
    //   accepted            → maybe fire the action
    if (existing && existing.status !== "accepted") return;

    // For an `accepted` recommendation, only act when no action exists
    // for this recommendation_id yet. Once an action is started or
    // terminal, leave it to the next reconciliation loop.
    if (existing?.status === "accepted") {
      const priorActions =
        ctx.readClient.getActionsForRecommendation(recommendationId);
      if (priorActions.length > 0) return;
    }

    const issue = rowToRunwayIssue(row);
    const shepherdCtx: ShepherdContext = {
      issue,
      branch: row.branch,
      prUrl: row.prUrl,
      prNumber: row.prNumber,
      cwd: ctx.cwd,
      baseBranch: ctx.baseBranch,
      config: ctx.config,
      github: ctx.github,
      iteration: 1,
    };

    const signal: SubscriptionSignal = yield* watcher(shepherdCtx);

    if (signal.kind === "quiet") return;

    if (signal.kind === "hitl") {
      // v1: HITL handling stays with the inline shepherd loop until
      // VA-482 retires it. The planner-side capability deliberately
      // does NOT emit a recommendation for the no-fix case — the
      // operator already sees the inline shepherd's HITL routing.
      yield* Effect.logInfo("planner.mergeability.hitl_signal").pipe(
        Effect.annotateLogs({
          target: `PR-${row.prNumber}`,
          reason: signal.reason,
        }),
      );
      return;
    }

    if (!existing) {
      // VA-481: mergeability fixes are mechanical (rebase against
      // base). Auto-approve-eligible.
      const autoApproveEligible = true;
      yield* emitProposed({
        recommendationId,
        prNumber: row.prNumber,
        description: signal.description,
        nowNano: ctx.now(),
        autoApproveEligible,
      });
      yield* autoAcceptIfEligible({
        mode: args.mode,
        recommendationId,
        autoApproveEligible,
        now: ctx.now,
      });
      args.proposed.push(recommendationId);
      return;
    }

    // existing.status === "accepted" and no prior action — fire it.
    yield* runAcceptedAction({
      recommendationId,
      prNumber: row.prNumber,
      description: signal.description,
      action: signal.action,
      nowFactory: ctx.now,
      actionsCompleted: args.actionsCompleted,
      actionsFailed: args.actionsFailed,
    });
  });

interface EmitProposedArgs {
  readonly recommendationId: string;
  readonly prNumber: number;
  readonly description: string;
  readonly nowNano: string;
  readonly autoApproveEligible: boolean;
}

const emitProposed = (args: EmitProposedArgs): Effect.Effect<void> => {
  const evidence = {
    prNumber: args.prNumber,
  };
  return Effect.logInfo(PLANNER_RECOMMENDATION_PROPOSED_LOG).pipe(
    Effect.annotateLogs({
      recommendationId: args.recommendationId,
      capability: MERGEABILITY_CAPABILITY,
      target: `PR-${args.prNumber}`,
      summary: args.description,
      evidence: JSON.stringify(evidence),
      autoApproveEligible: String(args.autoApproveEligible),
      timestampUnixNano: args.nowNano,
    }),
  );
};

interface RunAcceptedActionArgs {
  readonly recommendationId: string;
  readonly prNumber: number;
  readonly description: string;
  readonly action: Extract<
    SubscriptionSignal,
    { kind: "fix" }
  >["action"];
  readonly nowFactory: () => string;
  readonly actionsCompleted: string[];
  readonly actionsFailed: string[];
}

const runAcceptedAction = (
  args: RunAcceptedActionArgs,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const startNano = args.nowFactory();
    const actionId = actionIdFor(args.prNumber, startNano);

    yield* Effect.logInfo(PLANNER_ACTION_STARTED_LOG).pipe(
      Effect.annotateLogs({
        actionId,
        recommendationId: args.recommendationId,
        capability: MERGEABILITY_CAPABILITY,
        target: `PR-${args.prNumber}`,
        timestampUnixNano: startNano,
      }),
    );

    // The rebase agent's invocation can fail with a sandcastle error
    // (typed as `{ message: string }`). Catch the typed error here so
    // the projector sees a clean `action.failed` instead of the loop
    // bailing.
    const outcome = yield* args.action.pipe(
      Effect.matchEffect({
        onFailure: (err) =>
          Effect.succeed({
            kind: "hitl" as const,
            reason: "message" in err ? err.message : String(err),
          }),
        onSuccess: (out) => Effect.succeed(out),
      }),
    );

    if (outcome.kind === "fixed") {
      yield* Effect.logInfo(PLANNER_ACTION_COMPLETED_LOG).pipe(
        Effect.annotateLogs({
          actionId,
          outcome: outcome.detail,
          timestampUnixNano: args.nowFactory(),
        }),
      );
      args.actionsCompleted.push(actionId);
      return;
    }

    yield* Effect.logInfo(PLANNER_ACTION_FAILED_LOG).pipe(
      Effect.annotateLogs({
        actionId,
        error: outcome.reason,
        timestampUnixNano: args.nowFactory(),
      }),
    );
    args.actionsFailed.push(actionId);
  });

// parsePrNumber re-exported so callers building OpenShepherdedPrRow
// from external sources (tests, future capabilities) don't reach into
// shepherd.ts directly.
export { parsePrNumber };
