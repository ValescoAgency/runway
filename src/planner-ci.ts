import { claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { Effect } from "effect";
import type { Config } from "./config.js";
import {
  PLANNER_ACTION_COMPLETED_LOG,
  PLANNER_ACTION_FAILED_LOG,
  PLANNER_ACTION_STARTED_LOG,
  PLANNER_RECOMMENDATION_PROPOSED_LOG,
} from "./dashboard/projector.js";
import {
  autoAcceptIfEligible,
  resolveCapabilityMode,
} from "./planner-capability-mode.js";
import type { CheckRun, GithubGateway } from "./github.js";
import type { RunwayIssue } from "./linear.js";
import type {
  OpenShepherdedPrRow,
  PlannerReadClient,
} from "./planner-storage.js";
import { renderShepherdCiFixPrompt } from "./prompts.js";
import {
  dockerEnv,
  runSandcastle,
  stringifyResult,
} from "./sandcastle.js";
/**
 * VA-478 + VA-482: CI capability for the planner harness. The
 * dispatcher polls each open shepherded PR's check-runs intersected
 * with the branch's required checks and emits a planner
 * recommendation per failure flavor. Recommendation IDs encode
 * `(PR, sanitised check name, errorHash)`:
 *
 *   - Same failure on a new tick → same `recommendation_id` → the
 *     dashboard's `INSERT OR IGNORE` absorbs it. No re-emit.
 *   - Different log-tail hash → new `recommendation_id` → fresh
 *     recommendation row, ready for operator review.
 *
 * VA-482 retired the inline-shepherd `makeCiWatcher` factory and the
 * Subscription / ShepherdContext abstraction it consumed; this
 * dispatcher is now the only call site.
 */

export const CI_CAPABILITY = "shepherd-ci";

// ---------------------------------------------------------------------------
// CI-fix agent primitives.
// ---------------------------------------------------------------------------

export type CiFixAgentResult =
  | { readonly kind: "done" }
  | { readonly kind: "blocked"; readonly reason: string };

export interface CiFixAgentInvocation {
  readonly issue: RunwayIssue;
  readonly branch: string;
  readonly checkName: string;
  readonly logTail: string;
  readonly cwd: string;
  readonly config: Config;
}

/**
 * Production CI-fix invocation: render the prompt, run one sandcastle
 * iteration, parse the verdict. Tests stub via the watcher deps.
 */
export const defaultInvokeCiFixAgent = (
  args: CiFixAgentInvocation,
): Effect.Effect<CiFixAgentResult, { readonly message: string }> =>
  Effect.gen(function* () {
    const prompt = yield* Effect.promise(() =>
      renderShepherdCiFixPrompt({
        issue: args.issue,
        branch: args.branch,
        checkName: args.checkName,
        logTail: args.logTail,
      }),
    );
    const result = yield* runSandcastle({
      agent: claudeCode("claude-opus-4-7"),
      sandbox: docker({ env: dockerEnv(args.config) }),
      cwd: args.cwd,
      prompt,
      branchStrategy: { type: "branch", branch: args.branch },
      maxIterations: 1,
      name: `shepherd-ci-fix-${args.issue.identifier}-${sanitiseCheckName(args.checkName)}`,
    });
    return parseCiFixVerdict(stringifyResult(result));
  });

/**
 * Parse the CI-fix agent's verdict. Mirrors `parseRebaseVerdict` — same
 * IMPL: DONE / IMPL: BLOCKED markers, same fallback to BLOCKED when
 * no marker fires.
 */
export function parseCiFixVerdict(output: string): CiFixAgentResult {
  const blocked = output.match(/^IMPL:\s*BLOCKED(?:\s*[—-]\s*(.*))?$/im);
  if (blocked) {
    return { kind: "blocked", reason: (blocked[1] ?? "").trim() };
  }
  if (/^IMPL:\s*DONE\b/im.test(output)) {
    return { kind: "done" };
  }
  return {
    kind: "blocked",
    reason: "ci-fix agent produced no IMPL: marker",
  };
}

/**
 * Stable hash for a log tail used as the de-dup key. Just a cheap
 * DJB2 — collisions don't cause correctness issues here (worst case
 * is one extra re-impl), and we want determinism without a crypto
 * import.
 */
export function hashLogTail(s: string): string {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return String(hash);
}

export function sanitiseCheckName(name: string): string {
  return name.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 40);
}

export function lastNonEmptyLine(s: string): string {
  const lines = s.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.length > 0) return line;
  }
  return "(empty log)";
}

// ---------------------------------------------------------------------------
// Capability dispatcher (VA-478).
// ---------------------------------------------------------------------------

export interface CiCapabilityContext {
  readonly readClient: PlannerReadClient;
  readonly github: GithubGateway;
  readonly config: Config;
  /** Working-tree path the CI-fix agent runs against. */
  readonly cwd: string;
  /** Base branch — used to look up required-status-checks. */
  readonly baseBranch: string;
  /** Same override surface as the watcher. */
  readonly invokeCiFixAgent?: typeof defaultInvokeCiFixAgent;
  /** Unix-nano string generator. */
  readonly now: () => string;
}

export interface CiEvalResult {
  readonly proposed: readonly string[];
  readonly actionsCompleted: readonly string[];
  readonly actionsFailed: readonly string[];
}

const EMPTY: CiEvalResult = {
  proposed: [],
  actionsCompleted: [],
  actionsFailed: [],
};

const stableRecommendationId = (
  prNumber: number,
  checkName: string,
  errorHash: string,
): string =>
  `${CI_CAPABILITY}:PR-${prNumber}:${sanitiseCheckName(checkName)}:${errorHash}`;

const actionIdFor = (
  prNumber: number,
  checkName: string,
  nowNano: string,
): string =>
  `${CI_CAPABILITY}:PR-${prNumber}:${sanitiseCheckName(checkName)}:${nowNano}`;

const rowToRunwayIssue = (row: OpenShepherdedPrRow): RunwayIssue => ({
  id: row.issueId ?? "",
  identifier: row.issueIdentifier,
  title: row.issueTitle ?? row.issueIdentifier,
  description: "",
  labels: row.issueLabels,
});

/** Tail-of-log excerpt for the recommendation evidence. */
const logTailExcerpt = (logTail: string): string => {
  const last = lastNonEmptyLine(logTail);
  if (last === "(empty log)") return "";
  // Cap evidence at a sane size — the dashboard renders the field
  // verbatim and JSON-stringifies it.
  return last.slice(0, 240);
};

export const evaluateCi = (
  ctx: CiCapabilityContext,
): Effect.Effect<CiEvalResult> =>
  Effect.gen(function* () {
    const mode = resolveCapabilityMode(ctx.readClient, CI_CAPABILITY);
    if (mode === "manual") return EMPTY;

    const prs = ctx.readClient.listOpenShepherdedPrs();
    if (prs.length === 0) return EMPTY;

    const proposed: string[] = [];
    const actionsCompleted: string[] = [];
    const actionsFailed: string[] = [];

    for (const row of prs) {
      yield* evaluateOnePr({
        ctx,
        row,
        mode,
        proposed,
        actionsCompleted,
        actionsFailed,
      }).pipe(
        Effect.catchAllCause((cause) =>
          Effect.logError("planner.capability.error").pipe(
            Effect.annotateLogs({
              capability: CI_CAPABILITY,
              target: `PR-${row.prNumber}`,
              cause: cause.toString(),
            }),
          ),
        ),
      );
    }

    return { proposed, actionsCompleted, actionsFailed };
  });

interface EvaluateOnePrArgs {
  readonly ctx: CiCapabilityContext;
  readonly row: OpenShepherdedPrRow;
  readonly mode: import("./dashboard/storage.js").PlannerCapabilityMode;
  readonly proposed: string[];
  readonly actionsCompleted: string[];
  readonly actionsFailed: string[];
}

const evaluateOnePr = (
  args: EvaluateOnePrArgs,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const { ctx, row } = args;

    const pr = yield* ctx.github.getPullRequest({
      repoPath: ctx.cwd,
      prNumber: row.prNumber,
    });
    if (pr.merged) return;

    const checkRuns = yield* ctx.github.getCheckRuns({
      repoPath: ctx.cwd,
      sha: pr.headSha,
    });
    const failing = checkRuns.filter(
      (c) => c.status === "completed" && c.conclusion === "failure",
    );
    if (failing.length === 0) return;

    const required = yield* ctx.github.getRequiredChecks({
      repoPath: ctx.cwd,
      baseBranch: ctx.baseBranch,
    });
    const requiredFailing: readonly CheckRun[] =
      required === null
        ? failing
        : failing.filter((c) => required.includes(c.name));

    if (requiredFailing.length === 0) {
      // Optional-only failures — mirror the inline watcher's log
      // emission so an operator tailing telemetry sees the failure
      // without it consuming planner budget.
      const names = failing.map((c) => c.name).join(", ");
      yield* Effect.logInfo("planner.ci.optional_failure").pipe(
        Effect.annotateLogs({
          target: `PR-${row.prNumber}`,
          checks: names,
        }),
      );
      return;
    }

    const first = requiredFailing[0]!;
    const logTail =
      first.runId !== null
        ? yield* ctx.github.getCheckRunLogTail({
            repoPath: ctx.cwd,
            runId: first.runId,
            lines: 50,
          })
        : "";

    const errorHash = hashLogTail(logTail);
    const recommendationId = stableRecommendationId(
      row.prNumber,
      first.name,
      errorHash,
    );
    const existing = ctx.readClient.getRecommendation(recommendationId);

    // Status gates — same shape as VA-477.
    if (existing && existing.status !== "accepted") return;

    if (existing?.status === "accepted") {
      const priorActions =
        ctx.readClient.getActionsForRecommendation(recommendationId);
      if (priorActions.length > 0) return;
      // Accepted + not yet acted → run the CI fix agent.
      yield* runAcceptedAction({
        ctx,
        row,
        checkName: first.name,
        headSha: pr.headSha,
        logTail,
        recommendationId,
        actionsCompleted: args.actionsCompleted,
        actionsFailed: args.actionsFailed,
      });
      return;
    }

    // No existing recommendation — emit one. CI fixes are auto-
    // approve-eligible: the failing required check + log-tail hash
    // uniquely identify the fix flavor, so the planner can
    // fast-forward to accept under `auto` mode.
    const autoApproveEligible = true;
    yield* emitProposed({
      recommendationId,
      prNumber: row.prNumber,
      checkName: first.name,
      headSha: pr.headSha,
      logTail,
      nowNano: ctx.now(),
      autoApproveEligible,
    });
    yield* autoAcceptIfEligible({
      mode: args.mode,
      recommendationId,
      autoApproveEligible,
      now: ctx.now,
    });
    args.proposed.push(recommendationId);
  });

interface EmitProposedArgs {
  readonly recommendationId: string;
  readonly prNumber: number;
  readonly checkName: string;
  readonly headSha: string;
  readonly logTail: string;
  readonly nowNano: string;
  readonly autoApproveEligible: boolean;
}

const emitProposed = (args: EmitProposedArgs): Effect.Effect<void> => {
  const evidence = {
    prNumber: args.prNumber,
    checkName: args.checkName,
    headSha: args.headSha,
    logTailExcerpt: logTailExcerpt(args.logTail),
  };
  return Effect.logInfo(PLANNER_RECOMMENDATION_PROPOSED_LOG).pipe(
    Effect.annotateLogs({
      recommendationId: args.recommendationId,
      capability: CI_CAPABILITY,
      target: `PR-${args.prNumber}`,
      summary: `Re-impl after CI failure in \`${args.checkName}\``,
      evidence: JSON.stringify(evidence),
      autoApproveEligible: String(args.autoApproveEligible),
      timestampUnixNano: args.nowNano,
    }),
  );
};

interface RunAcceptedActionArgs {
  readonly ctx: CiCapabilityContext;
  readonly row: OpenShepherdedPrRow;
  readonly checkName: string;
  readonly headSha: string;
  readonly logTail: string;
  readonly recommendationId: string;
  readonly actionsCompleted: string[];
  readonly actionsFailed: string[];
}

const runAcceptedAction = (
  args: RunAcceptedActionArgs,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const { ctx, row } = args;
    const startNano = ctx.now();
    const actionId = actionIdFor(row.prNumber, args.checkName, startNano);
    const invoke = ctx.invokeCiFixAgent ?? defaultInvokeCiFixAgent;

    yield* Effect.logInfo(PLANNER_ACTION_STARTED_LOG).pipe(
      Effect.annotateLogs({
        actionId,
        recommendationId: args.recommendationId,
        capability: CI_CAPABILITY,
        target: `PR-${row.prNumber}`,
        timestampUnixNano: startNano,
      }),
    );

    const result = yield* invoke({
      issue: rowToRunwayIssue(row),
      branch: row.branch,
      checkName: args.checkName,
      logTail: args.logTail,
      cwd: ctx.cwd,
      config: ctx.config,
    }).pipe(
      Effect.matchEffect({
        onFailure: (err) =>
          Effect.succeed({
            kind: "blocked" as const,
            reason: "message" in err ? err.message : String(err),
          }),
        onSuccess: (out) => Effect.succeed(out),
      }),
    );

    if (result.kind === "done") {
      yield* Effect.logInfo(PLANNER_ACTION_COMPLETED_LOG).pipe(
        Effect.annotateLogs({
          actionId,
          outcome: `Re-impl after \`${args.checkName}\` failure`,
          timestampUnixNano: ctx.now(),
        }),
      );
      args.actionsCompleted.push(actionId);
      return;
    }

    yield* Effect.logInfo(PLANNER_ACTION_FAILED_LOG).pipe(
      Effect.annotateLogs({
        actionId,
        error: `CI fix BLOCKED in \`${args.checkName}\`: ${result.reason}`,
        timestampUnixNano: ctx.now(),
      }),
    );
    args.actionsFailed.push(actionId);
  });
