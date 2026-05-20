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
  /**
   * VA-418: in-run rejection feedback. Populated by the orchestrator
   * via `formatInRunReviewerFeedback` when a previous review pass in
   * THIS drain emitted `REVIEW: REJECTED-RETRY — <reason>`. Kept
   * separate from `priorReviewFeedback` (VA-383, cross-drain Linear
   * comments) so the agent reads in-run feedback as the higher-trust
   * signal — it's the reviewer's actual verdict on the diff the agent
   * just produced, not stale guidance from a prior runway invocation.
   * Empty string on the first attempt and when no in-run rejection
   * has fired yet.
   */
  inRunReviewerFeedback?: string;
  /**
   * VA-417: the repo's actual base branch (resolved from
   * `config.baseBranch` or auto-detected from `origin/HEAD` at
   * orchestrator startup). Substituted into the prompt so the agent
   * sees the real branch name — `main` vs. `master` vs. anything
   * else — instead of a hardcoded default.
   */
  baseBranch?: string;
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

/**
 * VA-461: render the shepherd-rebase prompt. The agent receives the
 * branch / base / mergeable_state and an optional list of files
 * `getConflictFiles` pre-detected — it executes the rebase inside
 * sandcastle and signals IMPL: DONE or IMPL: BLOCKED.
 */
export async function renderShepherdRebasePrompt(args: {
  issue: RunwayIssue;
  branch: string;
  baseBranch: string;
  mergeableState: string;
  conflictFiles: readonly string[];
}): Promise<string> {
  const template = await loadShepherdRebasePrompt();
  return renderPrompt(template, shepherdRebaseVars(args));
}

/**
 * VA-462: render the shepherd-ci-fix prompt. The agent receives the
 * failing check name and the trailing log lines and executes a
 * targeted fix on the impl branch (commit + push, not force-push).
 */
export async function renderShepherdCiFixPrompt(args: {
  issue: RunwayIssue;
  branch: string;
  checkName: string;
  logTail: string;
}): Promise<string> {
  const template = await loadShepherdCiFixPrompt();
  return renderPrompt(template, shepherdCiFixVars(args));
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

async function loadShepherdRebasePrompt(): Promise<string> {
  return readFile(join(PROMPT_DIR, "shepherd-rebase.md"), "utf8");
}

async function loadShepherdCiFixPrompt(): Promise<string> {
  return readFile(join(PROMPT_DIR, "shepherd-ci-fix.md"), "utf8");
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
  inRunReviewerFeedback?: string;
  baseBranch?: string;
}): Record<string, string> {
  return {
    ISSUE_IDENTIFIER: args.issue.identifier,
    ISSUE_TITLE: args.issue.title,
    ISSUE_DESCRIPTION: args.issue.description || "(no description)",
    PREVIOUS_ITERATIONS: args.previousIterations,
    PRIOR_REVIEW_FEEDBACK: args.priorReviewFeedback,
    // VA-418: empty string when the orchestrator has no in-run
    // rejection to surface (the common case — first attempt, or a
    // run with retries disabled). The `{{IN_RUN_REVIEWER_FEEDBACK}}`
    // slot expands to empty and the section header disappears from
    // the rendered prompt.
    IN_RUN_REVIEWER_FEEDBACK: args.inRunReviewerFeedback ?? "",
    POLICY_FORBIDDEN_BULLET: renderForbiddenPathsBullet(args.policy),
    // VA-417: fall back to "main" if the caller didn't pass one, so
    // older test fixtures keep working. Production always passes the
    // resolved base branch from config / orchestrator detection.
    BASE_BRANCH: args.baseBranch ?? "main",
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

function shepherdCiFixVars(args: {
  issue: RunwayIssue;
  branch: string;
  checkName: string;
  logTail: string;
}): Record<string, string> {
  return {
    ISSUE_IDENTIFIER: args.issue.identifier,
    ISSUE_TITLE: args.issue.title,
    ISSUE_DESCRIPTION: args.issue.description || "(no description)",
    BRANCH: args.branch,
    CHECK_NAME: args.checkName,
    LOG_TAIL: args.logTail.trim() || "(log unavailable)",
  };
}

function shepherdRebaseVars(args: {
  issue: RunwayIssue;
  branch: string;
  baseBranch: string;
  mergeableState: string;
  conflictFiles: readonly string[];
}): Record<string, string> {
  // The conflict-files block is one of two shapes: a bulleted list
  // (when `getConflictFiles` returned hits) or a single line saying
  // the branch is "behind" with no expected conflicts. The template
  // substitutes the whole block via `{{CONFLICT_FILES_BLOCK}}` so
  // either shape renders cleanly without dangling headers.
  const filesBlock =
    args.conflictFiles.length > 0
      ? `Pre-detected conflicting files:\n${args.conflictFiles
          .map((f) => `  - ${f}`)
          .join("\n")}`
      : `No conflicts pre-detected — the branch is behind base, expect a clean fast-forward rebase`;
  return {
    ISSUE_IDENTIFIER: args.issue.identifier,
    ISSUE_TITLE: args.issue.title,
    BRANCH: args.branch,
    BASE_BRANCH: args.baseBranch,
    MERGEABLE_STATE: args.mergeableState,
    CONFLICT_FILES_BLOCK: filesBlock,
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
 * VA-418: format the reviewer's in-run rejection text into the block
 * the implement prompt renders into `{{IN_RUN_REVIEWER_FEEDBACK}}`.
 * Higher-trust framing than VA-383's cross-drain feedback — this is
 * the reviewer's verdict on the diff the agent JUST produced in this
 * drain, not stale guidance from a prior runway invocation.
 *
 * `rejections` is the chronological list of rejection reasons from
 * every prior review pass in the current drain. The most recent
 * rejection is the load-bearing one; earlier rejections are included
 * so the agent can see what it has already tried + been told to fix.
 *
 * Returns the empty string when there are no rejections to surface —
 * the slot expands to empty and the section disappears from the
 * rendered prompt.
 */
export function formatInRunReviewerFeedback(
  rejections: readonly string[],
): string {
  if (rejections.length === 0) return "";
  const numbered = rejections.map((r, i) =>
    `${i + 1}. ${r.trim()}`,
  );
  return [
    "# Reviewer feedback from this run",
    "",
    "The previous iteration of this drain produced commits that review",
    "rejected. Every blocker below is from review of YOUR work this run —",
    "the reviewer judged each fix to be mechanical (no human judgment",
    "required). Address every blocker before signaling `IMPL: DONE` again.",
    "",
    "Rejections so far this drain (most recent last):",
    "",
    numbered.join("\n"),
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
