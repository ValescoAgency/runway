import { existsSync } from "node:fs";
import { join } from "node:path";
import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { Effect } from "effect";
import { execa } from "execa";
import type { Config } from "./config.js";
import type { LinearError, LinearGateway, RunwayIssue } from "./linear.js";
import type { GithubGateway } from "./github.js";
import {
  buildIterationSummary,
  implementVars,
  loadImplementPrompt,
  loadReviewPrompt,
  renderPrompt,
  reviewVars,
  tailOfMessage,
} from "./prompts.js";
import { detectBaseBranch } from "./git.js";
import { loadPolicy, type Policy } from "./policy.js";

export interface OrchestratorDeps {
  readonly config: Config;
  readonly linear: LinearGateway;
  readonly github: GithubGateway;
  /** Absolute path of the target repo. Defaults to process.cwd(). */
  readonly cwd: string;
}

export interface OrchestratorResult {
  /**
   * Number of issues attempted in this invocation. VA-344: `--max`
   * caps attempts, not successes — a deterministic startup failure
   * still consumes one attempt so we don't loop on the same broken
   * issue forever.
   */
  readonly attempts: number;
  readonly opened: number;
  readonly hitl: number;
  readonly errored: number;
  /**
   * VA-355: per-issue verdict trail so the operator can scan
   * `runway run`'s exit summary without opening Linear. Order matches
   * the order in which issues were picked up.
   */
  readonly outcomes: readonly IssueOutcome[];
}

export interface IssueOutcome {
  readonly identifier: string;
  readonly kind: "opened" | "hitl" | "reverted" | "errored";
  readonly detail: string;
}

// VA-353: review verdict marker. Global flag because sandcastle
// appends wrapper output ("Agent stopped", "Capturing session",
// "Reached max iterations (1).", "Run complete: …") AFTER the agent's
// final message — so the marker is rarely the last line. We scan
// every line-start match and keep the LAST one, which is the most
// recent agent verdict. Standalone-line: ^…$ with /m anchors prevent
// mid-prose matches like "the reviewer should output REVIEW: APPROVED
// when…".
const REVIEW_VERDICT_RE =
  /^REVIEW:\s*(APPROVED|REJECTED)(?:\s+—\s+(.*))?$/gm;

// VA-350: impl-pass termination contract. Last `IMPL:` marker line in
// the agent's output wins (most recent iteration's verdict). DONE →
// proceed to review; BLOCKED → HITL with reason; CONTINUE or missing →
// fall through (back-compat). The trailing reason after `—` is
// captured for BLOCKED.
const IMPL_VERDICT_RE = /^IMPL:\s*(DONE|BLOCKED|CONTINUE)(?:\s+—\s+(.*))?$/gm;
const IMPL_COMPLETION_SIGNALS = ["IMPL: DONE", "IMPL: BLOCKED"] as const;

/**
 * Confirms the cwd looks like a sandcastle-initialised repo. If not,
 * we error early with a clear message rather than letting Sandcastle
 * fail deep inside Docker setup.
 */
export function assertSandcastleInitialised(cwd: string): void {
  const sandcastleDir = join(cwd, ".sandcastle");
  if (!existsSync(sandcastleDir)) {
    throw new Error(
      `No .sandcastle/ directory in ${cwd}. Run \`npx sandcastle init\` here first.`,
    );
  }
}

/**
 * VA-356: explicit-by-intent "swallow this failure" runner for
 * best-effort Linear calls (revert paths, HITL follow-up notes). The
 * pre-Effect code used `.catch(() => undefined)`, which made the
 * decision-to-ignore invisible. Here we log a one-liner so a failed
 * label apply or transition leaves a trail without aborting the drain.
 */
function runSwallow(
  effect: Effect.Effect<unknown, LinearError>,
  label: string,
): Promise<void> {
  return Effect.runPromise(
    effect.pipe(
      Effect.catchAll((err) =>
        Effect.sync(() => {
          console.warn(
            `[runway] ${label}: best-effort call failed (${err._tag}): ${err.message}`,
          );
        }),
      ),
      Effect.asVoid,
    ),
  );
}

/**
 * Drains the Linear queue until empty (or until --max is hit). One
 * issue at a time in v1; parallel runs are a follow-up.
 */
export async function drainQueue(
  deps: OrchestratorDeps,
  opts: { max?: number; allowPaths?: readonly string[] } = {},
): Promise<OrchestratorResult> {
  const { config, linear } = deps;
  const max = opts.max ?? Number.POSITIVE_INFINITY;
  let attempts = 0;
  let opened = 0;
  let hitl = 0;
  let errored = 0;

  // Resolve the base branch once at startup so every issue in the
  // drain sees the same answer (and so a misconfigured repo fails
  // fast, before we touch any Linear state).
  const baseBranch = config.baseBranch ?? (await detectBaseBranch(deps.cwd));
  console.log(`[runway] base branch resolved to "${baseBranch}"`);
  const policy = loadPolicy(deps.cwd, { allowPathsOverride: opts.allowPaths });
  console.log(`[runway] policy: ${policy.source}`);
  const runDeps = { ...deps, baseBranch, policy };

  // VA-344: never re-pick an issue in the same invocation, even if
  // VA-342 reverted it to `Todo`. Without this, a deterministic
  // startup failure (broken .env.schema, missing image, expired token)
  // would loop on the same issue until --max was exhausted.
  const seen = new Set<string>();
  const outcomes: IssueOutcome[] = [];

  while (attempts < max) {
    const queue = await Effect.runPromise(linear.fetchReady());
    const issue = queue.find((i) => !seen.has(i.id));
    if (!issue) break;
    seen.add(issue.id);
    attempts += 1;

    try {
      const result = await processIssue(issue, runDeps);
      if (result.kind === "opened") opened += 1;
      if (result.kind === "hitl") hitl += 1;
      outcomes.push({
        identifier: issue.identifier,
        kind: result.kind,
        detail: result.detail,
      });
    } catch (err) {
      errored += 1;
      console.error(`[runway] error on ${issue.identifier}:`, err);

      // If the agent crashed before producing any commits (missing
      // image, varlock validation, container failed to boot, etc.),
      // it's an infrastructure failure — not a HITL. Revert the issue
      // to the ready state and skip the HITL label so the next run can
      // pick it up cleanly. `In Progress` is reserved for "agent has
      // committed to the branch".
      const branch = `agent/${issue.identifier.toLowerCase()}`;
      const startedRealWork = await hasCommits(deps.cwd, baseBranch, branch);
      const errDetail = err instanceof Error ? err.message : String(err);

      if (!startedRealWork) {
        await runSwallow(
          linear.transition(issue.id, config.readyStatus),
          `${issue.identifier}: revert transition to ${config.readyStatus}`,
        );
        await runSwallow(
          linear.comment(
            issue.id,
            `Runway hit a startup failure before the agent produced any commits — reverting to \`${config.readyStatus}\` for retry:\n\n\`\`\`\n${errDetail}\n\`\`\``,
          ),
          `${issue.identifier}: revert-comment`,
        );
        outcomes.push({
          identifier: issue.identifier,
          kind: "reverted",
          detail: errDetail,
        });
      } else {
        // VA-355: comment first with the substantive reason, label
        // second (best-effort). If we labeled first and the label
        // didn't exist (Flightplan workspaces hitting the
        // `needs-human` default — see VA-354), the orchestrator's
        // catch would never get to the reason and the operator would
        // see an infrastructure error in Linear with no clue what
        // the agent actually found.
        await flagHitl(
          issue,
          runDeps,
          `Runway hit an unrecoverable error and flagged for human review: ${errDetail}`,
        );
        outcomes.push({
          identifier: issue.identifier,
          kind: "errored",
          detail: errDetail,
        });
      }
    }
  }

  printExitSummary(outcomes);

  return { attempts, opened, hitl, errored, outcomes };
}

interface ProcessOutcome {
  readonly kind: "opened" | "hitl";
  /** PR URL for "opened", or the rejection/HITL reason for "hitl". */
  readonly detail: string;
}

interface ResolvedDeps extends OrchestratorDeps {
  /** Default branch of the cwd repo. Resolved once in drainQueue. */
  readonly baseBranch: string;
  /** Effective write-path policy (VA-352). Resolved once in drainQueue. */
  readonly policy: Policy;
}

async function processIssue(
  issue: RunwayIssue,
  deps: ResolvedDeps,
): Promise<ProcessOutcome> {
  const { config, linear, github, cwd, baseBranch } = deps;
  const branch = `agent/${issue.identifier.toLowerCase()}`;

  await Effect.runPromise(linear.transition(issue.id, config.inProgressStatus));
  await Effect.runPromise(
    linear.comment(
      issue.id,
      `Runway picked up this issue. Branch: \`${branch}\`.`,
    ),
  );

  // 1. Implementation pass.
  //
  // VA-349 + VA-350: run iterations one at a time so we can (a) inject
  // a summary of the previous iteration into the next prompt — no more
  // "I'll start by understanding the current state of the repository"
  // 5x per issue — and (b) break early on IMPL: DONE/BLOCKED parsed
  // from our own code rather than relying on sandcastle's substring
  // completionSignal.
  const implementTemplate = await loadImplementPrompt();
  const maxIters = Math.max(1, config.maxIterations);
  let prevSummary = "";
  let implementResult: Awaited<ReturnType<typeof run>> | undefined;
  let implVerdict: ReturnType<typeof parseImplVerdict> = { kind: "missing" };

  for (let iter = 1; iter <= maxIters; iter += 1) {
    const implementPrompt = renderPrompt(
      implementTemplate,
      implementVars(issue, {
        previousIterations: prevSummary,
        policy: deps.policy,
      }),
    );
    implementResult = await run({
      agent: claudeCode("claude-opus-4-6"),
      sandbox: docker({
        env: dockerEnv(config),
      }),
      cwd,
      prompt: implementPrompt,
      branchStrategy: { type: "branch", branch },
      maxIterations: 1,
      completionSignal: [...IMPL_COMPLETION_SIGNALS],
      name: `impl-${issue.identifier}-iter-${iter}`,
    });

    implVerdict = parseImplVerdict(implementResult);
    if (implVerdict.kind === "done" || implVerdict.kind === "blocked") break;

    // CONTINUE / missing — build the summary that the NEXT iteration
    // will see at the top of its prompt.
    const commits = await captureCommitLog(cwd, baseBranch, branch).catch(
      () => "",
    );
    prevSummary = buildIterationSummary({
      iterationsRun: iter,
      commits,
      finalMessageTail: tailOfMessage(implementResult.stdout ?? ""),
    });
  }

  // implementResult is set after the first iteration. The `!` is safe
  // because maxIters >= 1.
  const finalResult = implementResult!;

  // VA-350: BLOCKED short-circuits straight to HITL — no reviewer pass
  // for a self-declared blocker.
  if (implVerdict.kind === "blocked") {
    const reason = `Implementation pass blocked: ${implVerdict.reason}`;
    await flagHitl(issue, deps, reason);
    return { kind: "hitl", detail: reason };
  }
  if (implVerdict.kind === "missing") {
    console.warn(
      `[runway] ${issue.identifier}: impl agent ended without an IMPL: marker after ${maxIters} iteration(s); proceeding to review for back-compat.`,
    );
  }

  if (finalResult.commits.length === 0) {
    const reason =
      "Agent produced no commits — the issue may need clarification or human input.";
    await flagHitl(issue, deps, reason);
    return { kind: "hitl", detail: reason };
  }

  // 2. Review pass — read-only-ish, just looking at the diff.
  const diff = await captureDiff(cwd, baseBranch, branch);
  const commitLog = await captureCommitLog(cwd, baseBranch, branch);
  const reviewPrompt = renderPrompt(
    await loadReviewPrompt(),
    reviewVars({ issue, diff, commits: commitLog }),
  );
  const reviewResult = await run({
    agent: claudeCode("claude-opus-4-6"),
    sandbox: docker({
      env: dockerEnv(config),
    }),
    cwd,
    prompt: reviewPrompt,
    branchStrategy: { type: "head" },
    maxIterations: 1,
    name: `review-${issue.identifier}`,
  });

  const verdict = parseReviewVerdict(reviewResult);
  if (verdict.kind === "rejected") {
    const reason = `Sub-agent review rejected: ${verdict.reason}`;
    await flagHitl(issue, deps, reason);
    return { kind: "hitl", detail: reason };
  }

  // 3. Push + PR.
  await Effect.runPromise(github.pushBranch(cwd, branch));
  const prBody = buildPrBody(issue);
  const prUrl = await Effect.runPromise(
    github.openPullRequest({
      repoPath: cwd,
      branch,
      base: baseBranch,
      issue,
      body: prBody,
    }),
  );
  await Effect.runPromise(linear.transition(issue.id, config.inReviewStatus));
  await Effect.runPromise(
    linear.comment(issue.id, `Runway opened a PR for review: ${prUrl}`),
  );
  return { kind: "opened", detail: prUrl };
}

/**
 * VA-355: comment is the load-bearing artifact, label is metadata.
 * Post the comment FIRST so the substantive reason lands on the issue
 * even if the label apply later fails (Flightplan workspaces hitting
 * the `needs-human` default, transient Linear errors, etc.). On full
 * failure (comment didn't even post), dump the reason to stderr with
 * a clear banner so the operator sees it terminal-side.
 */
async function flagHitl(
  issue: RunwayIssue,
  deps: ResolvedDeps,
  reason: string,
): Promise<void> {
  const { config, linear } = deps;
  const body = `Runway flagged for human review: ${reason}`;

  let commentPosted = false;
  try {
    await Effect.runPromise(linear.comment(issue.id, body));
    commentPosted = true;
  } catch (err) {
    console.error(
      `[runway] ${issue.identifier}: failed to post HITL comment:`,
      errMsg(err),
    );
  }

  try {
    await Effect.runPromise(linear.applyLabel(issue.id, config.hitlLabel));
  } catch (err) {
    const detail = errMsg(err);
    console.error(
      `[runway] ${issue.identifier}: failed to apply HITL label "${config.hitlLabel}":`,
      detail,
    );
    if (commentPosted) {
      // Best-effort follow-up note; the real reason is already on the
      // issue from the first comment.
      await runSwallow(
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
  }
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message.split("\n")[0] ?? err.message;
  return String(err);
}

/**
 * VA-355: render a per-issue verdict trail at the end of the drain so
 * the operator can scan results without opening Linear. Skipped when
 * no issues were attempted.
 */
function printExitSummary(outcomes: readonly IssueOutcome[]): void {
  if (outcomes.length === 0) return;
  console.log("\n[runway] per-issue outcomes:");
  for (const o of outcomes) {
    const tag =
      o.kind === "opened"
        ? "APPROVED → PR opened"
        : o.kind === "hitl"
          ? "HITL"
          : o.kind === "reverted"
            ? "REVERTED → Todo"
            : "INFRA_ERROR";
    console.log(`  ${o.identifier}  ${tag}  ${o.detail}`);
  }
}

/**
 * Whether the agent branch has any commits beyond `base`. Used by the
 * drain loop to distinguish "agent crashed mid-run, after producing
 * real work" (→ HITL) from "agent crashed during startup, no work
 * done" (→ revert to Todo). If the branch doesn't exist or git fails,
 * treat as "no commits" so we revert rather than strand the issue.
 */
async function hasCommits(
  repoPath: string,
  base: string,
  branch: string,
): Promise<boolean> {
  try {
    const { stdout } = await execa(
      "git",
      ["rev-list", "--count", `${base}..${branch}`],
      { cwd: repoPath, reject: false },
    );
    return Number.parseInt(stdout.trim(), 10) > 0;
  } catch {
    return false;
  }
}

async function captureDiff(
  repoPath: string,
  base: string,
  branch: string,
): Promise<string> {
  const { stdout } = await execa("git", ["diff", `${base}...${branch}`], {
    cwd: repoPath,
  });
  // Truncate to keep the review prompt under the model's context budget.
  return stdout.length > 60_000 ? `${stdout.slice(0, 60_000)}\n…(truncated)` : stdout;
}

async function captureCommitLog(
  repoPath: string,
  base: string,
  branch: string,
): Promise<string> {
  const { stdout } = await execa(
    "git",
    ["log", "--oneline", `${base}..${branch}`],
    { cwd: repoPath },
  );
  return stdout;
}

interface ParsedVerdict {
  readonly kind: "approved" | "rejected";
  readonly reason: string;
}

type ImplVerdict =
  | { readonly kind: "done" }
  | { readonly kind: "continue" }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "missing" };

/**
 * Pulls the last `IMPL:` marker line out of the agent's output. The
 * orchestrator uses this to distinguish a clean completion (DONE) from
 * a self-declared block (BLOCKED — reason) from a multi-iteration
 * in-progress signal (CONTINUE). A missing marker is treated as
 * CONTINUE-with-warning for back-compat.
 */
export function parseImplVerdict(result: unknown): ImplVerdict {
  const text = stringifyResult(result);
  // Take the LAST match — later iterations override earlier ones if
  // the agent emitted multiple markers across an iteration loop.
  const matches = [...text.matchAll(IMPL_VERDICT_RE)];
  const last = matches[matches.length - 1];
  if (!last) return { kind: "missing" };
  if (last[1] === "DONE") return { kind: "done" };
  if (last[1] === "CONTINUE") return { kind: "continue" };
  return {
    kind: "blocked",
    reason: last[2]?.trim() || "no reason given",
  };
}

/**
 * Sandcastle's `RunResult` shape varies by version; defensively dig out
 * the last assistant message text. We only need to match the
 * `REVIEW: APPROVED` / `REVIEW: REJECTED — …` line at the tail.
 */
/**
 * VA-353: parse the reviewer's final `REVIEW: APPROVED` /
 * `REVIEW: REJECTED — <reason>` marker. Scans the agent's combined
 * stdout for *all* matches and returns the LAST one, since sandcastle
 * appends its own wrapper output ("Agent stopped", "Capturing
 * session", "Reached max iterations (N).", "Run complete: …") after
 * the agent's final message. A missing marker is itself a rejection —
 * a reviewer pass that didn't terminate cleanly is not trustworthy.
 */
export function parseReviewVerdict(result: unknown): ParsedVerdict {
  const text = stringifyResult(result);
  const matches = [...text.matchAll(REVIEW_VERDICT_RE)];
  const last = matches[matches.length - 1];
  if (!last) {
    return {
      kind: "rejected",
      reason: "review output did not contain a REVIEW: verdict line",
    };
  }
  if (last[1] === "APPROVED") return { kind: "approved", reason: "" };
  return {
    kind: "rejected",
    reason: last[2]?.trim() || "no reason given",
  };
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const r = result as {
      stdout?: string;
      iterations?: Array<{ output?: string; text?: string }>;
      output?: string;
    };
    // VA-353: sandcastle's RunResult carries the combined agent output
    // on `stdout`. Prefer it — falling through to JSON.stringify (the
    // old behavior) replaces real newlines with `\n` escapes and
    // breaks `^…$/m` line anchoring, which is the exact reason the
    // reviewer's verdict was being silently dropped for issues like
    // VA-312 tonight. The iterations/output fallbacks remain for
    // back-compat with older shapes and inline test fixtures.
    if (typeof r.stdout === "string" && r.stdout.length > 0) return r.stdout;
    if (r.iterations?.length) {
      return r.iterations
        .map((i) => i.output ?? i.text ?? "")
        .filter(Boolean)
        .join("\n");
    }
    if (typeof r.output === "string") return r.output;
    return JSON.stringify(result);
  }
  return String(result);
}

/**
 * Env vars to inject into every sandcastle container. Today this is
 * just OP_SERVICE_ACCOUNT_TOKEN (when present) so the in-container
 * varlock shim can authenticate with 1Password and resolve
 * ANTHROPIC_API_KEY / GH_TOKEN at agent run time. See
 * docs/secrets-with-varlock.md for the full flow.
 */
function dockerEnv(config: Config): Record<string, string> {
  const env: Record<string, string> = {};
  if (config.opServiceAccountToken) {
    env.OP_SERVICE_ACCOUNT_TOKEN = config.opServiceAccountToken;
  }
  return env;
}

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
