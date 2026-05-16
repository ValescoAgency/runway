import { Effect } from "effect";
import type { Config } from "./config.js";
import type { LinearError, LinearGateway, RunwayIssue } from "./linear.js";

/**
 * Narrow deps for `flagHitl`. Just a LinearGateway (to comment /
 * label / follow-up note) and the hitlLabel name from config. No
 * filesystem state — flagHitl doesn't touch git.
 */
export interface HitlDeps {
  readonly config: Config;
  readonly linear: LinearGateway;
}

/**
 * Deps for `handleProcessFailure`. VA-423 collapsed the
 * revert-vs-HITL fork into a single flagHitl path, so the failure
 * router no longer needs `cwd` / `baseBranch` (it used to consult
 * `hasCommits` to decide between revert-to-Todo and HITL). Kept
 * as an alias so call sites that already pass the wider shape
 * don't break.
 */
export type FailureRoutingDeps = HitlDeps;

/**
 * What handleProcessFailure hands back to the composer.
 *
 * VA-423 retired the `reverted` outcome — runway no longer flips
 * issues back to a `ready` state on startup failure. Every per-issue
 * failure (startup or mid-run) lands on `ready-for-human` so a
 * persistent infra problem can't loop the same issue forever; the
 * operator triages and re-applies `ready-for-agent` if appropriate.
 */
export type ProcessFailureOutcome = {
  readonly kind: "errored";
  readonly detail: string;
};

/**
 * VA-355: comment is the load-bearing artifact, label is metadata.
 * Post the comment FIRST so the substantive reason lands on the
 * issue even if the label apply later fails (transient Linear errors,
 * a workspace that hasn't yet created the label, etc.). On full
 * failure (comment didn't even post), dump the reason to stderr with
 * a clear banner so the operator sees it terminal-side.
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
 * VA-358 / VA-423: route a per-issue processIssue failure to HITL.
 * Both startup failures (agent crashed before writing anything —
 * missing image, varlock failure, container failed to boot) and
 * mid-run failures (agent committed real work then crashed) flip
 * the issue to `ready-for-human` so a human triages it. Runway
 * does NOT re-apply `ready-for-agent` on failure — terminal
 * failures should not retry indefinitely, and a re-apply path
 * would silently reopen the door to the same crash. If the
 * operator confirms the failure was transient (e.g. a quota blip),
 * they re-apply `ready-for-agent` manually.
 */
export const handleProcessFailure = (
  error: unknown,
  issue: RunwayIssue,
  deps: FailureRoutingDeps,
): Effect.Effect<ProcessFailureOutcome, never, never> =>
  Effect.gen(function* () {
    const errDetail = errMsg(error);
    yield* Effect.logError(`error on ${issue.identifier}`).pipe(
      Effect.annotateLogs({
        issue: issue.identifier,
        error: errDetail,
      }),
    );

    // VA-355: comment first with the substantive reason, label
    // second (best-effort). If we labeled first and the label
    // didn't exist (workspaces that haven't yet created
    // `ready-for-human`, transient API errors, etc.), the
    // orchestrator's catch would never get to the reason and the
    // operator would see a generic infrastructure error in Linear
    // with no clue what the agent actually found.
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

