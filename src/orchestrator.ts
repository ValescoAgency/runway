import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import type { Config } from "./config.js";
import { detectBaseBranch } from "./git.js";
import type { GithubError, GithubGateway } from "./github.js";
import type { LinearError, LinearGateway, RunwayIssue } from "./linear.js";
import { loadPolicy, type Policy } from "./policy.js";
import { runExecaScoped } from "./subprocess.js";
import { runImplementLoop } from "./implement.js";
import { runReviewPass } from "./review.js";
import { finalize } from "./finalize.js";

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

    const runDeps: ResolvedDeps = {
      ...deps,
      baseBranch: baseBranchResolved,
      policy,
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

      const processed = yield* processIssue(issue, runDeps).pipe(
        Effect.either,
        Effect.withSpan("processIssue", {
          attributes: {
            "runway.issue.identifier": issue.identifier,
            "runway.issue.id": issue.id,
            "runway.branch": branch,
          },
        }),
        Effect.annotateLogs({
          issue: issue.identifier,
          branch,
        }),
      );

      if (processed._tag === "Right") {
        const result = processed.right;
        if (result.kind === "opened") opened += 1;
        if (result.kind === "hitl") hitl += 1;
        outcomes.push({
          identifier: issue.identifier,
          kind: result.kind,
          detail: result.detail,
        });
      } else {
        errored += 1;
        const errDetail = errMsg(processed.left);
        yield* Effect.logError(`error on ${issue.identifier}`).pipe(
          Effect.annotateLogs({
            issue: issue.identifier,
            error: errDetail,
          }),
        );

        // If the agent crashed before producing any commits (missing
        // image, varlock validation, container failed to boot, etc.),
        // it's an infrastructure failure — not a HITL. Revert the
        // issue to the ready state and skip the HITL label so the
        // next run can pick it up cleanly. `In Progress` is reserved
        // for "agent has committed to the branch".
        const startedRealWork = yield* hasCommits(
          deps.cwd,
          baseBranchResolved,
          branch,
        ).pipe(Effect.catchAll(() => Effect.succeed(false)));

        if (!startedRealWork) {
          yield* runSwallow(
            linear.transition(issue.id, config.readyStatus),
            `${issue.identifier}: revert transition to ${config.readyStatus}`,
          );
          yield* runSwallow(
            linear.comment(
              issue.id,
              `Runway hit a startup failure before the agent produced any commits — reverting to \`${config.readyStatus}\` for retry:\n\n\`\`\`\n${errDetail}\n\`\`\``,
            ),
            `${issue.identifier}: revert-comment`,
          );
          outcomes.push({
            identifier: issue.identifier,
            kind: "reverted",
            detail: errDetail,
          });
        } else {
          // VA-355: comment first with the substantive reason, label
          // second (best-effort). If we labeled first and the label
          // didn't exist (Flightplan workspaces hitting the
          // `needs-human` default — see VA-354), the orchestrator's
          // catch would never get to the reason and the operator
          // would see an infrastructure error in Linear with no clue
          // what the agent actually found.
          yield* flagHitl(
            issue,
            runDeps,
            `Runway hit an unrecoverable error and flagged for human review: ${errDetail}`,
          );
          outcomes.push({
            identifier: issue.identifier,
            kind: "errored",
            detail: errDetail,
          });
        }
      }
    }

    yield* printExitSummary(outcomes);

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
    const { config, linear } = deps;
    const branch = `agent/${issue.identifier.toLowerCase()}`;

    yield* linear.transition(issue.id, config.inProgressStatus);
    yield* linear.comment(
      issue.id,
      `Runway picked up this issue. Branch: \`${branch}\`.`,
    );

    const impl = yield* runImplementLoop(issue, deps, branch);
    if (impl.kind === "hitl") {
      yield* flagHitl(issue, deps, impl.reason);
      return { kind: "hitl", detail: impl.reason };
    }

    const review = yield* runReviewPass(issue, deps, branch);
    if (review.kind === "hitl") {
      yield* flagHitl(issue, deps, review.reason);
      return { kind: "hitl", detail: review.reason };
    }

    return yield* finalize(issue, deps, branch);
  });

/**
 * VA-355: comment is the load-bearing artifact, label is metadata.
 * Post the comment FIRST so the substantive reason lands on the
 * issue even if the label apply later fails (Flightplan workspaces
 * hitting the `needs-human` default, transient Linear errors, etc.).
 * On full failure (comment didn't even post), dump the reason to
 * stderr with a clear banner so the operator sees it terminal-side.
 */
const flagHitl = (
  issue: RunwayIssue,
  deps: ResolvedDeps,
  reason: string,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const { config, linear } = deps;
    const body = `Runway flagged for human review: ${reason}`;

    const commentResult = yield* linear.comment(issue.id, body).pipe(
      Effect.either,
    );
    const commentPosted = commentResult._tag === "Right";
    if (!commentPosted) {
      yield* Effect.logError(`${issue.identifier}: failed to post HITL comment`).pipe(
        Effect.annotateLogs({
          issue: issue.identifier,
          error: errMsg(commentResult.left),
        }),
      );
    }

    const labelResult = yield* linear
      .applyLabel(issue.id, config.hitlLabel)
      .pipe(Effect.either);
    if (labelResult._tag === "Left") {
      const detail = errMsg(labelResult.left);
      yield* Effect.logError(
        `${issue.identifier}: failed to apply HITL label "${config.hitlLabel}"`,
      ).pipe(
        Effect.annotateLogs({
          issue: issue.identifier,
          label: config.hitlLabel,
          error: detail,
        }),
      );
      if (commentPosted) {
        // Best-effort follow-up note; the real reason is already on
        // the issue from the first comment.
        yield* runSwallow(
          linear.comment(
            issue.id,
            `Note: could not apply \`${config.hitlLabel}\` label — please apply it manually. (${detail})`,
          ),
          `${issue.identifier}: HITL follow-up note`,
        );
      }
    }

    if (!commentPosted) {
      // Last resort: the operator at least sees the reason in their
      // terminal, even with Linear entirely unreachable.
      yield* Effect.sync(() => {
        process.stderr.write(
          [
            "",
            `===== REJECTION REASON FOLLOWS (${issue.identifier}) =====`,
            reason,
            "===== END REJECTION REASON =====",
            "",
            "",
          ].join("\n"),
        );
      });
    }
  });

/**
 * VA-356: explicit-by-intent "swallow this failure" runner for
 * best-effort Linear calls (revert paths, HITL follow-up notes). The
 * pre-Effect code used `.catch(() => undefined)`, which made the
 * decision-to-ignore invisible. Here we log a one-liner so a failed
 * label apply or transition leaves a trail without aborting the
 * drain.
 */
const runSwallow = (
  effect: Effect.Effect<unknown, LinearError>,
  label: string,
): Effect.Effect<void, never, never> =>
  effect.pipe(
    Effect.catchAll((err) =>
      Effect.logWarning(
        `${label}: best-effort call failed (${err._tag}): ${err.message}`,
      ),
    ),
    Effect.asVoid,
  );

const errMsg = (err: unknown): string => {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m.split("\n")[0] ?? m;
  }
  return String(err);
};

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

/**
 * VA-358: Whether the agent branch has any commits beyond `base`.
 * Used by the drain loop to distinguish "agent crashed mid-run, after
 * producing real work" (→ HITL) from "agent crashed during startup,
 * no work done" (→ revert to Todo). If the branch doesn't exist or
 * git fails, treat as "no commits" so we revert rather than strand
 * the issue.
 */
const hasCommits = (
  repoPath: string,
  base: string,
  branch: string,
): Effect.Effect<boolean, { readonly message: string }, never> =>
  runExecaScoped(
    "git",
    ["rev-list", "--count", `${base}..${branch}`],
    { cwd: repoPath, reject: false },
    (err) => ({
      message: err instanceof Error ? err.message : String(err),
    }),
  ).pipe(
    Effect.map((res) => {
      const raw = res.stdout;
      const out = typeof raw === "string" ? raw : "";
      return Number.parseInt(out.trim(), 10) > 0;
    }),
  );
