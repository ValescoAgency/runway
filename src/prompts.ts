import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { RunwayIssue } from "./linear.js";
import { renderForbiddenPathsBullet, type Policy } from "./policy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Prompts ship with the runway package, NOT in the target repo's
// .sandcastle/. Runway substitutes {{KEY}} placeholders before passing
// the rendered string inline to sandcastle.run({ prompt }).
//   runway/src/prompts.ts → runway/prompts/
const PROMPT_DIR = join(__dirname, "..", "prompts");

export async function loadImplementPrompt(): Promise<string> {
  return readFile(join(PROMPT_DIR, "implement.md"), "utf8");
}

export async function loadReviewPrompt(): Promise<string> {
  return readFile(join(PROMPT_DIR, "review.md"), "utf8");
}

/**
 * Render a prompt by replacing all `{{KEY}}` placeholders with values
 * from `vars`. We do the substitution here (instead of relying on
 * sandcastle's promptArgs) because we pass the prompt inline and want
 * one canonical place to template.
 */
export function renderPrompt(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) =>
    vars[k] ?? `{{${k}}}`,
  );
}

export function implementVars(
  issue: RunwayIssue,
  opts: { previousIterations?: string; policy?: Policy } = {},
): Record<string, string> {
  return {
    ISSUE_IDENTIFIER: issue.identifier,
    ISSUE_TITLE: issue.title,
    ISSUE_DESCRIPTION: issue.description || "(no description)",
    // VA-349: empty for iteration 1, a structured summary for 2+.
    PREVIOUS_ITERATIONS: opts.previousIterations ?? "",
    // VA-352: render the working-style denylist from the active policy
    // so the agent never sees a hardcoded list that diverges from what
    // runway actually enforces.
    POLICY_FORBIDDEN_BULLET: opts.policy
      ? renderForbiddenPathsBullet(opts.policy)
      : "",
  };
}

/**
 * VA-349: build the "## Previous iterations" block that gets prepended
 * to iteration N+1's prompt. Carries the agent's commit log and the
 * tail of its final message so the next iteration doesn't re-explore
 * the repo from scratch.
 */
export function buildIterationSummary(args: {
  iterationsRun: number;
  commits: string;
  finalMessageTail: string;
}): string {
  const { iterationsRun, commits, finalMessageTail } = args;
  return [
    "## Previous iterations",
    "",
    `You have already completed ${iterationsRun} iteration(s) on this issue.`,
    "Do **not** re-explore the repository — pick up where the last iteration left off.",
    "",
    "### Commits so far on this branch",
    "",
    "```",
    commits.trim() || "(no commits yet)",
    "```",
    "",
    "### Tail of the last iteration's final message",
    "",
    "```",
    finalMessageTail.trim() || "(no output captured)",
    "```",
    "",
  ].join("\n");
}

/** Keep the tail of an iteration's stdout small enough to fit alongside the prompt. */
export function tailOfMessage(stdout: string, maxChars = 2000): string {
  if (stdout.length <= maxChars) return stdout;
  return `…(earlier output truncated)\n${stdout.slice(-maxChars)}`;
}

export function reviewVars(args: {
  issue: RunwayIssue;
  diff: string;
  commits: string;
}): Record<string, string> {
  return {
    ISSUE_IDENTIFIER: args.issue.identifier,
    ISSUE_TITLE: args.issue.title,
    ISSUE_DESCRIPTION: args.issue.description || "(no description)",
    DIFF: args.diff || "(empty diff)",
    COMMITS: args.commits || "(no commits)",
  };
}
