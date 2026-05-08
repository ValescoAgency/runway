import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { execa } from "execa";
import type { Config } from "./config.js";
import type { LinearGateway, RunwayIssue } from "./linear.js";
import type { GithubGateway } from "./github.js";
import {
  implementPromptArgs,
  loadImplementPrompt,
  loadReviewPrompt,
  reviewPromptArgs,
} from "./prompts.js";

export interface OrchestratorDeps {
  readonly config: Config;
  readonly linear: LinearGateway;
  readonly github: GithubGateway;
}

export interface OrchestratorResult {
  readonly processed: number;
  readonly opened: number;
  readonly hitl: number;
  readonly errored: number;
}

const REVIEW_VERDICT_RE = /^REVIEW:\s*(APPROVED|REJECTED)(?:\s+—\s+(.*))?$/m;

/**
 * Drains the Linear queue until empty (or until --max is hit). One
 * issue at a time in v1; parallel runs are a follow-up.
 */
export async function drainQueue(
  deps: OrchestratorDeps,
  opts: { max?: number } = {},
): Promise<OrchestratorResult> {
  const { config, linear, github } = deps;
  const max = opts.max ?? Number.POSITIVE_INFINITY;
  let processed = 0;
  let opened = 0;
  let hitl = 0;
  let errored = 0;

  while (processed < max) {
    const queue = await linear.fetchReady();
    if (queue.length === 0) break;
    const issue = queue[0]!;

    try {
      const verdict = await processIssue(issue, deps);
      processed += 1;
      if (verdict === "opened") opened += 1;
      if (verdict === "hitl") hitl += 1;
    } catch (err) {
      errored += 1;
      console.error(`[runway] error on ${issue.identifier}:`, err);
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

  return { processed, opened, hitl, errored };
}

type Verdict = "opened" | "hitl";

async function processIssue(
  issue: RunwayIssue,
  deps: OrchestratorDeps,
): Promise<Verdict> {
  const { config, linear, github } = deps;
  const branch = `agent/${issue.identifier.toLowerCase()}`;

  await linear.transition(issue.id, config.inProgressStatus);
  await linear.comment(
    issue.id,
    `Runway picked up this issue. Branch: \`${branch}\`.`,
  );

  // 1. Implementation pass.
  const implementPrompt = await loadImplementPrompt();
  const implementResult = await run({
    agent: claudeCode("claude-opus-4-6"),
    sandbox: docker(),
    cwd: config.targetRepo,
    prompt: implementPrompt,
    promptArgs: implementPromptArgs(issue),
    branchStrategy: { type: "branch", branch },
    maxIterations: config.maxIterations,
    name: `impl-${issue.identifier}`,
  });

  if (implementResult.commits.length === 0) {
    await flagHitl(
      issue,
      deps,
      "Agent produced no commits — the issue may need clarification or human input.",
    );
    return "hitl";
  }

  // 2. Review pass — read-only-ish, just looking at the diff.
  const diff = await captureDiff(config.targetRepo, branch);
  const commitLog = await captureCommitLog(config.targetRepo, branch);
  const reviewPrompt = await loadReviewPrompt();
  const reviewResult = await run({
    agent: claudeCode("claude-opus-4-6"),
    sandbox: docker(),
    cwd: config.targetRepo,
    prompt: reviewPrompt,
    promptArgs: reviewPromptArgs({ issue, diff, commits: commitLog }),
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
  await github.pushBranch(config.targetRepo, branch);
  const prBody = buildPrBody(issue);
  const prUrl = await github.openPullRequest({
    repoPath: config.targetRepo,
    branch,
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
  deps: OrchestratorDeps,
  reason: string,
): Promise<void> {
  const { config, linear } = deps;
  await linear.applyLabel(issue.id, config.hitlLabel);
  await linear.comment(issue.id, `Runway flagged for human review: ${reason}`);
}

async function captureDiff(repoPath: string, branch: string): Promise<string> {
  const { stdout } = await execa("git", ["diff", `main...${branch}`], {
    cwd: repoPath,
  });
  // Truncate to keep the review prompt under the model's context budget.
  return stdout.length > 60_000 ? `${stdout.slice(0, 60_000)}\n…(truncated)` : stdout;
}

async function captureCommitLog(
  repoPath: string,
  branch: string,
): Promise<string> {
  const { stdout } = await execa(
    "git",
    ["log", "--oneline", `main..${branch}`],
    { cwd: repoPath },
  );
  return stdout;
}

interface ParsedVerdict {
  readonly kind: "approved" | "rejected";
  readonly reason: string;
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
    // Try a few likely shapes without locking us to a specific
    // sandcastle internal type.
    const r = result as {
      iterations?: Array<{ output?: string; text?: string }>;
      output?: string;
    };
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
