import { Effect } from "effect";
import type { Config } from "./config.js";
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

export interface FinalizeOutcome {
  readonly kind: "opened";
  /** PR URL — what the operator sees in the exit summary. */
  readonly detail: string;
}

/**
 * Push the agent branch, open the PR, transition the Linear issue to
 * the in-review status, and link the PR back on the issue.
 */
export const finalize = (
  issue: RunwayIssue,
  deps: FinalizeDeps,
  branch: string,
): Effect.Effect<FinalizeOutcome, LinearError | GithubError, never> =>
  Effect.gen(function* () {
    const { config, cwd, baseBranch, linear, github } = deps;
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

function buildPrBody(issue: RunwayIssue): string {
  return [
    `Runway-generated PR for **${issue.identifier} — ${issue.title}**.`,
    "",
    "Sub-agent review pass: APPROVED.",
    "",
    "## Linear issue",
    "",
    issue.description || "(no description)",
    "",
    `Refs ${issue.identifier}`,
  ].join("\n");
}
