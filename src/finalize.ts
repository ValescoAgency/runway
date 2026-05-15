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
 *                     the latest `origin/<baseBranch>` produced real
 *                     merge conflicts (unmerged files reported by
 *                     `git diff --name-only --diff-filter=U`). The
 *                     pre-rebase state has been restored via
 *                     `git rebase --abort`; the orchestrator routes
 *                     to HITL with the conflicted-file list.
 *   rebase-failure  — review APPROVED but the post-review rebase
 *                     exited non-zero with no unmerged files. The
 *                     rebase failed for a non-conflict reason (dirty
 *                     host worktree, signing hook, lock contention,
 *                     etc.); stderr/stdout are captured for the
 *                     operator. PR is NOT opened.
 *
 * VA-424: the two non-ok outcomes are distinct so the HITL diagnostic
 * names the real cause instead of always claiming "upstream advanced".
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
    }
  | {
      readonly kind: "rebase-failure";
      readonly baseBranch: string;
      readonly stderr: string;
      readonly stdout: string;
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
    if (rebase.kind === "failure") {
      return {
        kind: "rebase-failure",
        baseBranch,
        stderr: rebase.stderr,
        stdout: rebase.stdout,
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
 * VA-419 / VA-424: format the HITL message body for a rebase-conflict
 * outcome. Names the base branch and the conflicted file list, and
 * quotes the reviewer's APPROVED verdict so the operator knows the
 * agent's diff was good before the conflict surfaced. VA-424 drops
 * the "let VA-417 handle it on the next drain" suggestion — VA-417
 * hard-resets the agent branch, which would destroy the approved
 * work. Operator must reconcile manually.
 */
export function formatRebaseConflictReason(args: {
  readonly baseBranch: string;
  readonly conflictedFiles: readonly string[];
  readonly reviewVerdict: string;
}): string {
  const fileLines = args.conflictedFiles
    .map((f) => `  - ${f}`)
    .join("\n");
  return [
    `Rebase of the agent branch onto \`origin/${args.baseBranch}\` produced merge`,
    "conflicts in:",
    fileLines,
    `Review was APPROVED before the rebase (\`${args.reviewVerdict}\`); the agent's diff`,
    "is good but needs operator reconciliation against the new base. Rebase the",
    "agent branch manually and re-open the PR — do NOT let the next drain reset",
    "this branch (that would discard the approved work).",
  ].join("\n");
}

/**
 * VA-424: format the HITL message body for a rebase-failure outcome
 * (rebase exited non-zero but git reported no unmerged files —
 * something other than a real merge conflict broke it). Surfaces
 * git's stderr/stdout so the operator can diagnose, and explicitly
 * does NOT recommend VA-417 (which would destroy the approved work).
 */
export function formatRebaseFailureReason(args: {
  readonly baseBranch: string;
  readonly stderr: string;
  readonly stdout: string;
  readonly reviewVerdict: string;
}): string {
  const trimmedStderr = args.stderr.trim();
  const trimmedStdout = args.stdout.trim();
  const diagnostic =
    trimmedStderr.length > 0
      ? trimmedStderr
      : trimmedStdout.length > 0
        ? trimmedStdout
        : "(git produced no stderr or stdout output)";
  const diagnosticBlock = diagnostic
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  return [
    `Rebase of the agent branch onto \`origin/${args.baseBranch}\` failed without`,
    "producing merge conflicts (git reported no unmerged files). Diagnostic from",
    "git:",
    diagnosticBlock,
    `Review was APPROVED before the rebase (\`${args.reviewVerdict}\`); the agent's diff`,
    "is good. Investigate the underlying cause, rebase the agent branch manually",
    "if appropriate, and re-open the PR — do NOT let the next drain reset this",
    "branch (that would discard the approved work).",
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
