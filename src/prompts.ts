import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { RunwayIssue } from "./linear.js";

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

export function implementVars(issue: RunwayIssue): Record<string, string> {
  return {
    ISSUE_IDENTIFIER: issue.identifier,
    ISSUE_TITLE: issue.title,
    ISSUE_DESCRIPTION: issue.description || "(no description)",
  };
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
