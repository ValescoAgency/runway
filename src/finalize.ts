import { Effect } from "effect";
import type { Config } from "./config.js";
import { rebaseOntoBase } from "./git.js";
import type { GithubError, GithubGateway } from "./github.js";
import type { LinearError, LinearGateway, RunwayIssue } from "./linear.js";

/**
 * Narrow per-phase deps: finalize is the only phase that touches
 * GitHub (push + PR) and Linear state transitions. No policy, no
 * sandcastle.
 */
export interface FinalizeDeps {
  readonly config: Config;
  readonly cwd: string;
  readonly baseBranch: string;
  readonly linear: LinearGateway;
  readonly github: GithubGateway;
}

/**
 * What finalize hands back to the composer.
 *
 *   opened          — branch pushed, PR opened, Linear transitioned.
 *   rebase-conflict — review APPROVED but the post-review rebase onto
 *                     the latest `origin/<baseBranch>` produced
 *                     conflicts. The pre-rebase state has been
 *                     restored via `git rebase --abort`; the orchestrator
 *                     should route to HITL with the conflicted-file
 *                     list. PR is NOT opened.
 */
export type FinalizeOutcome =
  | {
      readonly kind: "opened";
      /** PR URL — what the operator sees in the exit summary. */
      readonly detail: string;
    }
  | {
      readonly kind: "rebase-conflict";
      readonly baseBranch: string;
      readonly conflictedFiles: readonly string[];
      /** Reviewer's verdict line, surfaced in the HITL comment so the
       *  operator knows the diff was APPROVED before the conflict. */
      readonly reviewVerdict: string;
    };

/**
 * VA-419: rebase the agent branch onto the latest `origin/<baseBranch>`,
 * then push and open the PR. If the rebase hits a conflict, restore
 * pre-rebase state and surface a `rebase-conflict` outcome — the
 * orchestrator routes it to HITL so the operator can reconcile
 * manually (or let VA-417 reset the branch on the next drain).
 */
export const finalize = (
  issue: RunwayIssue,
  deps: FinalizeDeps,
  branch: string,
): Effect.Effect<
  FinalizeOutcome,
  LinearError | GithubError | { readonly message: string },
  never
> =>
  Effect.gen(function* () {
    const { config, cwd, baseBranch, linear, github } = deps;

    const rebase = yield* rebaseOntoBase(cwd, baseBranch, branch).pipe(
      Effect.withSpan("rebaseOntoBase"),
    );
    if (rebase.kind === "conflict") {
      return {
        kind: "rebase-conflict",
        baseBranch,
        conflictedFiles: rebase.conflictedFiles,
        reviewVerdict: "REVIEW: APPROVED",
      };
    }

    yield* github.pushBranch(cwd, branch).pipe(Effect.withSpan("pushBranch"));
    const prBody = buildPrBody(issue);
    const prUrl = yield* github
      .openPullRequest({
        repoPath: cwd,
        branch,
        base: baseBranch,
        issue,
        body: prBody,
      })
      .pipe(Effect.withSpan("openPullRequest"));
    yield* linear.transition(issue.id, config.inReviewStatus);
    yield* linear.comment(issue.id, `Runway opened a PR for review: ${prUrl}`);
    return { kind: "opened", detail: prUrl };
  });

/**
 * VA-419: format the HITL message body for a rebase-conflict outcome.
 * Names the base branch and the conflicted file list, and quotes the
 * reviewer's APPROVED verdict so the operator knows the agent's diff
 * was good before the conflict surfaced.
 */
export function formatRebaseConflictReason(args: {
  readonly baseBranch: string;
  readonly conflictedFiles: readonly string[];
  readonly reviewVerdict: string;
}): string {
  const fileLines = args.conflictedFiles.length
    ? args.conflictedFiles.map((f) => `  - ${f}`).join("\n")
    : "  (no conflicted files reported by git — inspect manually)";
  return [
    `Upstream base \`${args.baseBranch}\` advanced during this drain; the rebase`,
    "onto the latest base produced conflicts in:",
    fileLines,
    `Review was APPROVED before the rebase (\`${args.reviewVerdict}\`); the agent's diff`,
    "is good but needs operator reconciliation against the new base. Re-run runway",
    "after rebasing manually, or let VA-417 handle it on the next drain.",
  ].join("\n");
}

// VA-412: `Closes` (not `Refs`) is the Linear GitHub-integration magic
// word that auto-transitions the issue to Done on PR merge. `Refs`
// only attaches the PR to the issue and leaves it stuck In Progress.
export function buildPrBody(issue: RunwayIssue): string {
  return [
    `Runway-generated PR for **${issue.identifier} — ${issue.title}**.`,
    "",
    "Sub-agent review pass: APPROVED.",
    "",
    "## Linear issue",
    "",
    issue.description || "(no description)",
    "",
    `Closes ${issue.identifier}`,
  ].join("\n");
}
