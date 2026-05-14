import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { RunwayComment, RunwayIssue } from "./linear.js";
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
  /**
   * VA-383: comments from prior runway attempts on this issue,
   * pre-filtered and pre-formatted by the orchestrator via
   * `formatPriorFeedback`. Empty string when there's nothing to
   * surface — the template variable expands to empty and the
   * section header disappears from the rendered prompt.
   */
  priorReviewFeedback: string;
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
  priorReviewFeedback: string;
}): Record<string, string> {
  return {
    ISSUE_IDENTIFIER: args.issue.identifier,
    ISSUE_TITLE: args.issue.title,
    ISSUE_DESCRIPTION: args.issue.description || "(no description)",
    PREVIOUS_ITERATIONS: args.previousIterations,
    PRIOR_REVIEW_FEEDBACK: args.priorReviewFeedback,
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
 * VA-383: known orchestrator-emitted comment prefixes that are
 * bookkeeping noise, not feedback the impl agent should learn from.
 * Filtering by author alone is insufficient because runway and the
 * reviewer both post under the API-key owner's identity — so
 * "Runway picked up this issue. Branch: …" would otherwise leak into
 * the prior-feedback block on every retry.
 *
 * Intentionally does NOT include `Runway flagged for human review:` —
 * that comment carries the reviewer's rejection reason, which is the
 * load-bearing signal VA-383 exists to surface.
 */
const RUNWAY_BOOKKEEPING_PREFIXES = [
  "Runway picked up this issue",
  "Runway opened a PR for review:",
  "Runway hit a startup failure",
  "Note: could not apply",
] as const;

const isRunwayBookkeeping = (body: string): boolean =>
  RUNWAY_BOOKKEEPING_PREFIXES.some((p) => body.startsWith(p));

/**
 * VA-383: filter + format the comment set fetched off an issue into
 * the "Review feedback from prior attempts" block the implement
 * prompt renders. Pure, side-effect-free, no Linear deps — the
 * orchestrator owns I/O, this owns the shape.
 *
 * Comments survive the filter when **all** of:
 *   1. author name is in `allowlist` (case-sensitive exact match)
 *   2. body does NOT begin with a known runway bookkeeping prefix
 *      (orchestrator transitions, PR-opened announcements, etc.)
 *
 * Returns the empty string when nothing makes it through — the
 * `{{PRIOR_REVIEW_FEEDBACK}}` slot expands to empty and the section
 * disappears from the rendered prompt entirely.
 */
export function formatPriorFeedback(
  comments: readonly RunwayComment[],
  allowlist: readonly string[],
): string {
  const allowed = new Set(allowlist);
  const surviving = comments.filter(
    (c) => allowed.has(c.author) && !isRunwayBookkeeping(c.body),
  );
  if (surviving.length === 0) return "";

  // Already sorted ascending by createdAt at the gateway boundary —
  // re-sort here defensively in case a caller hands us an unsorted
  // array (the test fixture, for instance, asserts ordering explicitly).
  const ordered = [...surviving].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );

  const entries = ordered.map((c) => {
    const when = c.createdAt.toISOString();
    return `### ${when} — ${c.author}\n\n${c.body.trim()}`;
  });
  return [
    "# Review feedback from prior attempts",
    "",
    "Prior runway attempts on this issue were rejected. Each block below is a",
    "review comment to internalize **before** redoing the work — these are the",
    "specific blockers that caused the previous attempt to be rejected. The",
    "issue description above is the spec; the comments here are augmenting",
    "guidance. If the two contradict, prefer the spec and call out the conflict",
    "in your final message.",
    "",
    entries.join("\n\n"),
    "",
  ].join("\n");
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
