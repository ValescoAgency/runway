import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { RunwayIssue } from "./linear.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// runway/src/prompts.ts → runway/.sandcastle/prompts/
const PROMPT_DIR = join(__dirname, "..", ".sandcastle", "prompts");

export async function loadImplementPrompt(): Promise<string> {
  return readFile(join(PROMPT_DIR, "implement.md"), "utf8");
}

export async function loadReviewPrompt(): Promise<string> {
  return readFile(join(PROMPT_DIR, "review.md"), "utf8");
}

/**
 * Build the substitution map Sandcastle's promptArgs takes. Sandcastle
 * replaces {{KEY}} placeholders in the prompt file with these values.
 */
export function implementPromptArgs(
  issue: RunwayIssue,
): Record<string, string> {
  return {
    ISSUE_IDENTIFIER: issue.identifier,
    ISSUE_TITLE: issue.title,
    ISSUE_DESCRIPTION: issue.description || "(no description)",
  };
}

export function reviewPromptArgs(args: {
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
