import { Effect } from "effect";
import type { Config } from "./config.js";
import type { LinearError, LinearGateway, RunwayIssue } from "./linear.js";
import { runExecaScoped } from "./subprocess.js";

/**
 * Narrow per-phase deps for the failure-routing module. flagHitl and
 * handleProcessFailure both need a LinearGateway + the hitlLabel /
 * readyStatus from config; handleProcessFailure also needs the
 * workspace + base branch to ask git "did the agent produce any
 * commits?" before deciding to revert vs flag-for-human-review. No
 * GitHub, no policy.
 */
export interface HitlDeps {
  readonly config: Config;
  readonly linear: LinearGateway;
  readonly cwd: string;
  readonly baseBranch: string;
}

/**
 * What handleProcessFailure hands back to the composer:
 *
 *   reverted — agent never produced commits; we reverted the issue to
 *              readyStatus so the next drain can retry it cleanly.
 *   errored  — agent crashed mid-run after producing real work; we
 *              flagged the issue for human review and left the branch
 *              + In-Progress state intact for triage.
 */
export type ProcessFailureOutcome =
  | { readonly kind: "reverted"; readonly detail: string }
  | { readonly kind: "errored"; readonly detail: string };

/**
 * VA-355: comment is the load-bearing artifact, label is metadata.
 * Post the comment FIRST so the substantive reason lands on the
 * issue even if the label apply later fails (Flightplan workspaces
 * hitting the `needs-human` default, transient Linear errors, etc.).
 * On full failure (comment didn't even post), dump the reason to
 * stderr with a clear banner so the operator sees it terminal-side.
 */
export const flagHitl = (
  issue: RunwayIssue,
  deps: HitlDeps,
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
 * VA-358: routes a per-issue processIssue failure. Zero-commit
 * failures (agent crashed before writing anything — missing image,
 * varlock failure, container failed to boot) revert the issue to
 * readyStatus so the next drain can retry cleanly. Mid-run failures
 * (agent committed real work then crashed) flag for human review and
 * leave the branch + In-Progress state intact for triage.
 *
 * `In Progress` is reserved for "agent has committed to the branch":
 * if we left the issue there after a clean startup failure, the next
 * drain wouldn't pick it up via fetchReady (it's no longer in the
 * ready state) and the operator would have to manually nudge it.
 */
export const handleProcessFailure = (
  error: unknown,
  issue: RunwayIssue,
  deps: HitlDeps,
  branch: string,
): Effect.Effect<ProcessFailureOutcome, never, never> =>
  Effect.gen(function* () {
    const { config, linear, cwd, baseBranch } = deps;
    const errDetail = errMsg(error);
    yield* Effect.logError(`error on ${issue.identifier}`).pipe(
      Effect.annotateLogs({
        issue: issue.identifier,
        error: errDetail,
      }),
    );

    const startedRealWork = yield* hasCommits(cwd, baseBranch, branch).pipe(
      Effect.catchAll(() => Effect.succeed(false)),
    );

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
      return { kind: "reverted", detail: errDetail };
    }

    // VA-355: comment first with the substantive reason, label
    // second (best-effort). If we labeled first and the label
    // didn't exist (Flightplan workspaces hitting the `needs-human`
    // default — see VA-354), the orchestrator's catch would never
    // get to the reason and the operator would see an infrastructure
    // error in Linear with no clue what the agent actually found.
    yield* flagHitl(
      issue,
      deps,
      `Runway hit an unrecoverable error and flagged for human review: ${errDetail}`,
    );
    return { kind: "errored", detail: errDetail };
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
 * VA-358: Whether the agent branch has any commits beyond `base`.
 * Used to distinguish "agent crashed mid-run, after producing real
 * work" (→ HITL) from "agent crashed during startup, no work done"
 * (→ revert to readyStatus). If the branch doesn't exist or git
 * fails, treat as "no commits" so we revert rather than strand the
 * issue.
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
