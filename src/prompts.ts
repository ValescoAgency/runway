import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { RunwayIssue } from "./linear.js";
import type { Policy } from "./policy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Prompts ship with the runway package, NOT in the target repo's
// .sandcastle/. Runway substitutes {{KEY}} placeholders before passing
// the rendered string inline to sandcastle.run({ prompt }).
//   runway/src/prompts.ts → runway/prompts/
const PROMPT_DIR = join(__dirname, "..", "prompts");

// ---------------------------------------------------------------------------
// VA-361: deep public API. Callers get a single async call that returns
// the finished prompt string. The load → varsBuilder → renderPrompt
// chain stays internal — bug surface that used to live at every call
// site (forgot to load? wrong var? skipped policy?) collapses into
// this module.
// ---------------------------------------------------------------------------

/**
 * Render the impl-agent prompt for a single iteration. `policy` is
 * threaded through so the agent's working-style denylist matches the
 * effective policy for this run (subsumes the renderForbiddenPathsBullet
 * concern that previously lived in policy.ts).
 */
export async function renderImplementPrompt(args: {
  issue: RunwayIssue;
  policy: Policy;
  /** Empty for iteration 1; structured summary for 2+ (built by implement.ts). */
  previousIterations: string;
}): Promise<string> {
  const template = await loadImplementPrompt();
  return renderPrompt(template, implementVars(args));
}

/**
 * Render the reviewer-agent prompt for a single review pass.
 */
export async function renderReviewPrompt(args: {
  issue: RunwayIssue;
  diff: string;
  commits: string;
}): Promise<string> {
  const template = await loadReviewPrompt();
  return renderPrompt(template, reviewVars(args));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function loadImplementPrompt(): Promise<string> {
  return readFile(join(PROMPT_DIR, "implement.md"), "utf8");
}

async function loadReviewPrompt(): Promise<string> {
  return readFile(join(PROMPT_DIR, "review.md"), "utf8");
}

/**
 * Replace all `{{KEY}}` placeholders with values from `vars`. Done
 * here (not in sandcastle's promptArgs) so the prompt can be passed
 * inline with one canonical substitution rule.
 */
function renderPrompt(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) =>
    vars[k] ?? `{{${k}}}`,
  );
}

function implementVars(args: {
  issue: RunwayIssue;
  policy: Policy;
  previousIterations: string;
}): Record<string, string> {
  return {
    ISSUE_IDENTIFIER: args.issue.identifier,
    ISSUE_TITLE: args.issue.title,
    ISSUE_DESCRIPTION: args.issue.description || "(no description)",
    PREVIOUS_ITERATIONS: args.previousIterations,
    POLICY_FORBIDDEN_BULLET: renderForbiddenPathsBullet(args.policy),
  };
}

function reviewVars(args: {
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

/**
 * VA-352 (absorbed from policy.ts in VA-361): render the bullet
 * sentence the impl prompt shows the agent. Stable formatting so a
 * missing path is visible in a diff. Lives here now because rendering
 * for the impl prompt is a prompt-module concern; policy.ts stays a
 * pure data module.
 */
function renderForbiddenPathsBullet(policy: Policy): string {
  if (policy.forbiddenPaths.length === 0) {
    return "- (No write-path restrictions for this repo. Use judgment.)";
  }
  const quoted = policy.forbiddenPaths.map((p) => `\`${p}\``).join(", ");
  return `- Never modify ${quoted}. If the issue's acceptance criteria require modifying one of these paths, **stop and emit \`IMPL: BLOCKED — issue requires modifying <path>, which working-style policy forbids\`** — do not silently skip the work.`;
}
