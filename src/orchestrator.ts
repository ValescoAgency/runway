import { existsSync } from "node:fs";
import { join } from "node:path";
import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { execa } from "execa";
import type { Config } from "./config.js";
import type { LinearGateway, RunwayIssue } from "./linear.js";
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
}

const REVIEW_VERDICT_RE = /^REVIEW:\s*(APPROVED|REJECTED)(?:\s+—\s+(.*))?$/m;

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

  while (attempts < max) {
    const queue = await linear.fetchReady();
    const issue = queue.find((i) => !seen.has(i.id));
    if (!issue) break;
    seen.add(issue.id);
    attempts += 1;

    try {
      const verdict = await processIssue(issue, runDeps);
      if (verdict === "opened") opened += 1;
      if (verdict === "hitl") hitl += 1;
    } catch (err) {
      errored += 1;
      console.error(`[runway] error on ${issue.identifier}:`, err);

      // If the agent crashed before producing any commits (missing
      // image, varlock validation, container failed to boot, etc.),
      // it's an infrastructure failure — not a HITL. Revert the issue
      // to `Todo` and skip the `needs-human` label so the next run
      // can pick it up cleanly. `In Progress` is reserved for "agent
      // has committed to the branch".
      const branch = `agent/${issue.identifier.toLowerCase()}`;
      const startedRealWork = await hasCommits(deps.cwd, baseBranch, branch);

      if (!startedRealWork) {
        await linear
          .transition(issue.id, config.readyStatus)
          .catch(() => undefined);
        await linear
          .comment(
            issue.id,
            `Runway hit a startup failure before the agent produced any commits — reverting to \`${config.readyStatus}\` for retry:\n\n\`\`\`\n${
              err instanceof Error ? err.message : String(err)
            }\n\`\`\``,
          )
          .catch(() => undefined);
      } else {
        await linear
          .applyLabel(issue.id, config.hitlLabel)
          .catch(() => undefined);
        await linear
          .comment(
            issue.id,
            `Runway hit an unrecoverable error and flagged for human review:\n\n\`\`\`\n${
              err instanceof Error ? err.message : String(err)
            }\n\`\`\``,
          )
          .catch(() => undefined);
      }
    }
  }

  return { attempts, opened, hitl, errored };
}

type Verdict = "opened" | "hitl";

interface ResolvedDeps extends OrchestratorDeps {
  /** Default branch of the cwd repo. Resolved once in drainQueue. */
  readonly baseBranch: string;
  /** Effective write-path policy (VA-352). Resolved once in drainQueue. */
  readonly policy: Policy;
}

async function processIssue(
  issue: RunwayIssue,
  deps: ResolvedDeps,
): Promise<Verdict> {
  const { config, linear, github, cwd, baseBranch } = deps;
  const branch = `agent/${issue.identifier.toLowerCase()}`;

  await linear.transition(issue.id, config.inProgressStatus);
  await linear.comment(
    issue.id,
    `Runway picked up this issue. Branch: \`${branch}\`.`,
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
    await flagHitl(
      issue,
      deps,
      `Implementation pass blocked: ${implVerdict.reason}`,
    );
    return "hitl";
  }
  if (implVerdict.kind === "missing") {
    console.warn(
      `[runway] ${issue.identifier}: impl agent ended without an IMPL: marker after ${maxIters} iteration(s); proceeding to review for back-compat.`,
    );
  }

  if (finalResult.commits.length === 0) {
    await flagHitl(
      issue,
      deps,
      "Agent produced no commits — the issue may need clarification or human input.",
    );
    return "hitl";
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
    await flagHitl(
      issue,
      deps,
      `Sub-agent review rejected: ${verdict.reason}`,
    );
    return "hitl";
  }

  // 3. Push + PR.
  await github.pushBranch(cwd, branch);
  const prBody = buildPrBody(issue);
  const prUrl = await github.openPullRequest({
    repoPath: cwd,
    branch,
    base: baseBranch,
    issue,
    body: prBody,
  });
  await linear.transition(issue.id, config.inReviewStatus);
  await linear.comment(
    issue.id,
    `Runway opened a PR for review: ${prUrl}`,
  );
  return "opened";
}

async function flagHitl(
  issue: RunwayIssue,
  deps: ResolvedDeps,
  reason: string,
): Promise<void> {
  const { config, linear } = deps;
  await linear.applyLabel(issue.id, config.hitlLabel);
  await linear.comment(issue.id, `Runway flagged for human review: ${reason}`);
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
function parseReviewVerdict(result: unknown): ParsedVerdict {
  const text = stringifyResult(result);
  const match = text.match(REVIEW_VERDICT_RE);
  if (!match) {
    return {
      kind: "rejected",
      reason: "review output did not contain a REVIEW: verdict line",
    };
  }
  if (match[1] === "APPROVED") return { kind: "approved", reason: "" };
  return {
    kind: "rejected",
    reason: match[2]?.trim() || "no reason given",
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
    // Sandcastle's RunResult carries the combined agent output on
    // `stdout`. Prefer it; the iterations/output fallbacks are kept
    // for back-compat with older shapes and inline test fixtures.
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
