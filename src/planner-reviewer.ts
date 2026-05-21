import Anthropic from "@anthropic-ai/sdk";
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
import type { GithubGateway, PrComment } from "./github.js";
import type { RunwayIssue } from "./linear.js";
import type {
  OpenShepherdedPrRow,
  PlannerReadClient,
} from "./planner-storage.js";
import {
  renderShepherdReviewFixPrompt,
  renderShepherdReviewRespondPrompt,
} from "./prompts.js";
import {
  dockerEnv,
  runSandcastle,
  stringifyResult,
} from "./sandcastle.js";
import type { Subscription, SubscriptionSignal, ShepherdContext } from "./shepherd.js";

/**
 * VA-479: reviewer-comment capability for the planner harness.
 *
 * Relocates the watcher + agent primitives from `src/shepherd.ts`
 * unchanged (`makeReviewerWatcher`, `parsePrReviewVerdict`,
 * `defaultInvokeReviewerResponseAgent`, etc.); shepherd.ts re-exports
 * for the legacy inline path. The planner-side dispatcher
 * (`evaluateReviewer`) iterates open shepherded PRs from the
 * read-projection, scans new comments, and emits planner OTLP events.
 *
 * Two branches per comment:
 *
 *   - Bot author + `REVIEW: CHANGES-REQUESTED — <fix>` parses cleanly
 *     → recommendation summary = parsed fix line. Mode in evidence:
 *     `fix-request`.
 *   - Anything else from a human + bot NEEDS-DISCUSSION / no marker
 *     → consult LLM (ADR 0004 § Smartness — consult point #2) to
 *     interpret the comment as a short actionable fix. The LLM's
 *     summary becomes the recommendation summary; evidence carries
 *     the raw comment body + the LLM's rationale so the operator
 *     can override.
 *
 * Bot APPROVED / NONE → skipped (positive signal, no action needed).
 *
 * Dedup is via stable recommendation IDs that encode the comment ID:
 * `shepherd-reviewer:PR-<n>:comment-<id>`. The dashboard's
 * `INSERT OR IGNORE` absorbs re-emits across ticks.
 *
 * On `accept`, the dispatcher reconstructs the
 * `ReviewerResponseInvocation.mode` from the recommendation's evidence
 * and invokes `defaultInvokeReviewerResponseAgent`, then emits
 * `action.started` → `action.completed` / `action.failed`.
 */

export const REVIEWER_CAPABILITY = "shepherd-reviewer";

// ---------------------------------------------------------------------------
// Relocated VA-463 primitives — verbatim from shepherd.ts.
// ---------------------------------------------------------------------------

export type PrReviewVerdict =
  | { readonly kind: "approved" }
  | { readonly kind: "changes-requested"; readonly fix: string }
  | { readonly kind: "needs-discussion"; readonly decision: string }
  | { readonly kind: "none" };

/**
 * Parse a PR-reviewer-bot comment for its `REVIEW: ...` line. Returns
 * `{ kind: "none" }` when the body has no marker. The regex matches
 * the LAST occurrence — the prompt structure has the verdict line at
 * the end of the comment body.
 */
export function parsePrReviewVerdict(body: string): PrReviewVerdict {
  const matches = Array.from(
    body.matchAll(
      /^REVIEW:\s*(APPROVED|CHANGES-REQUESTED|NEEDS-DISCUSSION)(?:\s*[—-]\s*(.*))?$/gim,
    ),
  );
  if (matches.length === 0) return { kind: "none" };
  const last = matches[matches.length - 1]!;
  const kind = last[1]!.toUpperCase();
  const detail = (last[2] ?? "").trim();
  if (kind === "APPROVED") return { kind: "approved" };
  if (kind === "CHANGES-REQUESTED") {
    return { kind: "changes-requested", fix: detail };
  }
  return { kind: "needs-discussion", decision: detail };
}

export type ReviewerResponseResult =
  | { readonly kind: "done" }
  | { readonly kind: "blocked"; readonly reason: string };

export interface ReviewerResponseInvocation {
  readonly issue: RunwayIssue;
  readonly branch: string;
  readonly cwd: string;
  readonly config: Config;
  /** Distinguishes the two prompt templates. */
  readonly mode:
    | { readonly kind: "fix-request"; readonly fix: string }
    | {
        readonly kind: "verbatim";
        readonly commentAuthor: string;
        readonly commentSource: string;
        readonly commentBody: string;
      };
}

/**
 * Production reviewer-response invocation: pick the right template
 * (parsed CHANGES-REQUESTED fix vs. verbatim human comment), run one
 * sandcastle iteration, parse the IMPL: verdict.
 */
export const defaultInvokeReviewerResponseAgent = (
  args: ReviewerResponseInvocation,
): Effect.Effect<ReviewerResponseResult, { readonly message: string }> =>
  Effect.gen(function* () {
    const prompt = yield* Effect.promise(() =>
      args.mode.kind === "fix-request"
        ? renderShepherdReviewFixPrompt({
            issue: args.issue,
            branch: args.branch,
            fixRequest: args.mode.fix,
          })
        : renderShepherdReviewRespondPrompt({
            issue: args.issue,
            branch: args.branch,
            commentAuthor: args.mode.commentAuthor,
            commentSource: args.mode.commentSource,
            commentBody: args.mode.commentBody,
          }),
    );
    const result = yield* runSandcastle({
      agent: claudeCode("claude-opus-4-7"),
      sandbox: docker({ env: dockerEnv(args.config) }),
      cwd: args.cwd,
      prompt,
      branchStrategy: { type: "branch", branch: args.branch },
      maxIterations: 1,
      name: `shepherd-review-${args.issue.identifier}-${args.mode.kind}`,
    });
    return parseReviewerResponseVerdict(stringifyResult(result));
  });

export function parseReviewerResponseVerdict(
  output: string,
): ReviewerResponseResult {
  const blocked = output.match(/^IMPL:\s*BLOCKED(?:\s*[—-]\s*(.*))?$/im);
  if (blocked) {
    return { kind: "blocked", reason: (blocked[1] ?? "").trim() };
  }
  if (/^IMPL:\s*DONE\b/im.test(output)) {
    return { kind: "done" };
  }
  return {
    kind: "blocked",
    reason: "reviewer-response agent produced no IMPL: marker",
  };
}

export interface ReviewerWatcherDeps {
  readonly github: GithubGateway;
  readonly config: Config;
  /** Production default; tests inject a stub. */
  readonly invokeReviewerResponseAgent?: typeof defaultInvokeReviewerResponseAgent;
}

/**
 * Legacy inline-shepherd reviewer-comment watcher. Verbatim relocation
 * of the VA-463 implementation. The planner-side capability does NOT
 * call this — it re-implements the per-PR scan inline so the
 * recommendation / action emission can fall out cleanly without
 * round-tripping through the `Subscription` ADT.
 */
export function makeReviewerWatcher(deps: ReviewerWatcherDeps): Subscription {
  const invoke =
    deps.invokeReviewerResponseAgent ?? defaultInvokeReviewerResponseAgent;
  const respondedTo = new Set<number>();
  let primed = false;

  return (ctx) =>
    Effect.gen(function* () {
      const pr = yield* deps.github.getPullRequest({
        repoPath: ctx.cwd,
        prNumber: ctx.prNumber,
      });
      if (pr.merged) return { kind: "quiet" } as const;

      const comments = yield* deps.github.getPullRequestComments({
        repoPath: ctx.cwd,
        prNumber: ctx.prNumber,
      });

      // Initial-snapshot priming: on the first poll, snapshot every
      // existing comment ID into the responded set so we only act on
      // NEW comments posted during this shepherd loop's lifetime.
      if (!primed) {
        for (const c of comments) respondedTo.add(c.id);
        primed = true;
        return { kind: "quiet" } as const;
      }

      const next = comments.find((c) => !respondedTo.has(c.id));
      if (!next) return { kind: "quiet" } as const;
      respondedTo.add(next.id);

      const botLogin = deps.config.prReviewerBotLogin?.trim();
      const isBot = Boolean(botLogin) && next.authorLogin === botLogin;

      if (isBot) {
        const verdict = parsePrReviewVerdict(next.body);
        if (verdict.kind === "approved" || verdict.kind === "none") {
          return { kind: "quiet" } as const;
        }
        if (verdict.kind === "needs-discussion") {
          return {
            kind: "hitl",
            reason: `Reviewer flagged needs-discussion: ${verdict.decision || "(no detail provided)"}`,
          } as const;
        }
        return buildFixSignal(
          ctx,
          deps,
          invoke,
          { kind: "fix-request", fix: verdict.fix },
          next,
        );
      }

      return buildFixSignal(
        ctx,
        deps,
        invoke,
        {
          kind: "verbatim",
          commentAuthor: next.authorLogin,
          commentSource: next.source,
          commentBody: next.body,
        },
        next,
      );
    });
}

function buildFixSignal(
  ctx: ShepherdContext,
  deps: ReviewerWatcherDeps,
  invoke: typeof defaultInvokeReviewerResponseAgent,
  mode: ReviewerResponseInvocation["mode"],
  comment: PrComment,
): SubscriptionSignal {
  const summary =
    mode.kind === "fix-request"
      ? `CHANGES-REQUESTED — ${truncate(mode.fix, 60)}`
      : `${comment.authorLogin || "unknown"} (${comment.source})`;
  return {
    kind: "fix",
    description: `Respond to PR comment: ${summary}`,
    action: Effect.gen(function* () {
      const result = yield* invoke({
        issue: ctx.issue,
        branch: ctx.branch,
        cwd: ctx.cwd,
        config: deps.config,
        mode,
      });
      if (result.kind === "blocked") {
        return {
          kind: "hitl",
          reason:
            mode.kind === "fix-request"
              ? `Reviewer CHANGES-REQUESTED BLOCKED: ${result.reason}`
              : `Reviewer comment BLOCKED (${comment.authorLogin || "unknown"}): ${result.reason}`,
        } as const;
      }
      return {
        kind: "fixed",
        detail:
          mode.kind === "fix-request"
            ? `Addressed reviewer fix-request`
            : `Responded to ${comment.authorLogin || "reviewer"} comment`,
      } as const;
    }),
  };
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= n) return flat;
  return `${flat.slice(0, n - 1)}…`;
}

// ---------------------------------------------------------------------------
// LLM consult point (ADR 0004 § Smartness #2): interpret ambiguous
// human comments into a short actionable summary.
// ---------------------------------------------------------------------------

export interface CommentInterpretation {
  /** Short actionable fix instruction (≤ ~120 chars). */
  readonly summary: string;
  /** One-sentence rationale explaining how the LLM read the comment. */
  readonly rationale: string;
}

export interface InterpretCommentArgs {
  readonly commentBody: string;
  readonly commentAuthor: string;
  readonly commentSource: string;
}

export type InterpretComment = (
  args: InterpretCommentArgs,
) => Effect.Effect<CommentInterpretation>;

/**
 * Default LLM interpreter. Calls Anthropic's Haiku model with a
 * deliberately small prompt + max_tokens budget so a tick of the
 * planner that hits 5 unhandled comments doesn't take minutes. On
 * any API failure (network, rate-limit, parse error), falls back to
 * a verbatim-comment summary with an explicit rationale — the
 * operator still sees the comment in evidence and can decide.
 *
 * Cost envelope: Haiku 4.5 is the cheapest current Anthropic SKU;
 * ~200 input tokens + ~80 output tokens per call. At one planner
 * tick per 30s a normal day's traffic costs cents.
 */
export const makeAnthropicCommentInterpreter = (opts: {
  readonly apiKey: string;
  readonly model?: string;
}): InterpretComment => {
  const client = new Anthropic({ apiKey: opts.apiKey });
  const model = opts.model ?? "claude-haiku-4-5-20251001";

  return (args) =>
    Effect.tryPromise({
      try: async () => {
        const res = await client.messages.create({
          model,
          max_tokens: 256,
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: renderUserPrompt(args),
            },
          ],
        });
        return parseInterpretationResponse(res, args);
      },
      catch: (err) => err,
    }).pipe(
      // Any failure → graceful fallback. The planner cannot stall on
      // the LLM round-trip; the operator still sees the raw comment.
      Effect.catchAll(() =>
        Effect.succeed<CommentInterpretation>({
          summary: truncate(args.commentBody, 120),
          rationale:
            "LLM interpretation unavailable; operator sees the raw comment body in evidence.",
        }),
      ),
    );
};

const SYSTEM_PROMPT = `You read pull-request review comments and summarize each as ONE short, imperative fix instruction (≤120 chars). Output EXACTLY two lines:
SUMMARY: <short fix instruction>
RATIONALE: <one sentence explaining how you read the comment>
No preamble, no markdown, no extra lines.`;

const renderUserPrompt = (args: InterpretCommentArgs): string =>
  `Reviewer: ${args.commentAuthor || "unknown"} (${args.commentSource || "comment"})\n\nComment body:\n---\n${args.commentBody}\n---`;

function parseInterpretationResponse(
  res: Anthropic.Messages.Message,
  args: InterpretCommentArgs,
): CommentInterpretation {
  const text = res.content
    .filter((b) => b.type === "text")
    .map((b) => ("text" in b ? b.text : ""))
    .join("\n");
  const summaryMatch = text.match(/^SUMMARY:\s*(.+)$/im);
  const rationaleMatch = text.match(/^RATIONALE:\s*(.+)$/im);
  const summary = (summaryMatch?.[1] ?? "").trim();
  const rationale = (rationaleMatch?.[1] ?? "").trim();
  if (summary.length === 0) {
    return {
      summary: truncate(args.commentBody, 120),
      rationale:
        "LLM produced no SUMMARY line; falling back to verbatim comment.",
    };
  }
  return {
    summary,
    rationale:
      rationale.length > 0
        ? rationale
        : "LLM produced no RATIONALE line; summary verbatim from model.",
  };
}

// ---------------------------------------------------------------------------
// Capability dispatcher (VA-479).
// ---------------------------------------------------------------------------

export interface ReviewerCapabilityContext {
  readonly readClient: PlannerReadClient;
  readonly github: GithubGateway;
  readonly config: Config;
  readonly cwd: string;
  readonly baseBranch: string;
  /** Reviewer-response agent override. */
  readonly invokeReviewerResponseAgent?: typeof defaultInvokeReviewerResponseAgent;
  /**
   * LLM interpreter for ambiguous human comments. When unset, the
   * dispatcher uses a built-in fallback that just truncates the
   * comment as the summary — the recommendation is still emitted so
   * the operator sees the comment in evidence and can act.
   */
  readonly interpretComment?: InterpretComment;
  readonly now: () => string;
}

export interface ReviewerEvalResult {
  readonly proposed: readonly string[];
  readonly actionsCompleted: readonly string[];
  readonly actionsFailed: readonly string[];
}

const EMPTY: ReviewerEvalResult = {
  proposed: [],
  actionsCompleted: [],
  actionsFailed: [],
};

const recommendationIdFor = (prNumber: number, commentId: number): string =>
  `${REVIEWER_CAPABILITY}:PR-${prNumber}:comment-${commentId}`;

const actionIdFor = (
  prNumber: number,
  commentId: number,
  nowNano: string,
): string =>
  `${REVIEWER_CAPABILITY}:PR-${prNumber}:comment-${commentId}:${nowNano}`;

const rowToRunwayIssue = (row: OpenShepherdedPrRow): RunwayIssue => ({
  id: row.issueId ?? "",
  identifier: row.issueIdentifier,
  title: row.issueTitle ?? row.issueIdentifier,
  description: "",
  labels: row.issueLabels,
});

/**
 * Built-in fallback interpreter for when no LLM is configured. The
 * operator still sees the comment in evidence; the summary is just
 * the truncated body.
 */
const VERBATIM_INTERPRETER: InterpretComment = (args) =>
  Effect.succeed({
    summary: truncate(args.commentBody, 120),
    rationale: "No LLM interpreter configured; summary is the truncated comment body.",
  });

export const evaluateReviewer = (
  ctx: ReviewerCapabilityContext,
): Effect.Effect<ReviewerEvalResult> =>
  Effect.gen(function* () {
    const mode = resolveCapabilityMode(ctx.readClient, REVIEWER_CAPABILITY);
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
              capability: REVIEWER_CAPABILITY,
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
  readonly ctx: ReviewerCapabilityContext;
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

    const comments = yield* ctx.github.getPullRequestComments({
      repoPath: ctx.cwd,
      prNumber: row.prNumber,
    });

    // Iterate every comment. The stable recommendation_id ensures
    // dedup via INSERT OR IGNORE so we never propose the same comment
    // twice. Per-tick we still bound the work to a single un-acted
    // comment to keep the planner responsive.
    for (const comment of comments) {
      const recommendationId = recommendationIdFor(row.prNumber, comment.id);
      const existing = ctx.readClient.getRecommendation(recommendationId);

      if (existing && existing.status !== "accepted") continue;

      if (existing?.status === "accepted") {
        const priorActions =
          ctx.readClient.getActionsForRecommendation(recommendationId);
        if (priorActions.length > 0) continue;
        yield* runAcceptedAction({
          ctx,
          row,
          comment,
          recommendationId,
          actionsCompleted: args.actionsCompleted,
          actionsFailed: args.actionsFailed,
        });
        // Only one accept-action per tick — keeps the planner snappy.
        return;
      }

      // No existing recommendation. Decide the mode + summary.
      const decided = yield* decideRecommendation({
        ctx,
        comment,
      });
      if (decided === null) continue; // bot APPROVED/NONE or NEEDS-DISCUSSION — skip emission

      yield* emitProposed({
        recommendationId,
        prNumber: row.prNumber,
        commentId: comment.id,
        commentAuthor: comment.authorLogin,
        commentSource: comment.source,
        commentBody: comment.body,
        mode: decided.mode,
        summary: decided.summary,
        rationale: decided.rationale,
        autoApproveEligible: decided.autoApproveEligible,
        nowNano: ctx.now(),
      });
      yield* autoAcceptIfEligible({
        mode: args.mode,
        recommendationId,
        autoApproveEligible: decided.autoApproveEligible,
        now: ctx.now,
      });
      args.proposed.push(recommendationId);

      // Only one new recommendation per PR per tick. Next tick picks
      // up the next unhandled comment.
      return;
    }
  });

interface DecideArgs {
  readonly ctx: ReviewerCapabilityContext;
  readonly comment: PrComment;
}

interface DecidedRecommendation {
  readonly mode:
    | { readonly kind: "fix-request"; readonly fix: string }
    | {
        readonly kind: "verbatim";
        readonly commentAuthor: string;
        readonly commentSource: string;
        readonly commentBody: string;
      };
  readonly summary: string;
  readonly rationale: string;
  /**
   * VA-481: bot CHANGES-REQUESTED (mechanical parsed-fix path) is
   * auto-approve-eligible; human-comment LLM interpretations are
   * NOT — the LLM might mis-read the intent, so the operator should
   * always click accept even in `auto` mode.
   */
  readonly autoApproveEligible: boolean;
}

const decideRecommendation = (
  args: DecideArgs,
): Effect.Effect<DecidedRecommendation | null> =>
  Effect.gen(function* () {
    const { ctx, comment } = args;
    const botLogin = ctx.config.prReviewerBotLogin?.trim();
    const isBot = Boolean(botLogin) && comment.authorLogin === botLogin;

    if (isBot) {
      const verdict = parsePrReviewVerdict(comment.body);
      if (verdict.kind === "approved" || verdict.kind === "none") {
        return null;
      }
      if (verdict.kind === "needs-discussion") {
        // ADR 0004 says the planner emits actionable recommendations;
        // NEEDS-DISCUSSION is an explicit "human, please look" signal,
        // not actionable. Skip emission; the comment is visible on
        // the PR anyway. (Logged so an operator tailing telemetry
        // sees it.)
        yield* Effect.logInfo("planner.reviewer.needs_discussion").pipe(
          Effect.annotateLogs({
            target: `PR-?`,
            commentId: String(comment.id),
            decision: verdict.decision || "(no detail)",
          }),
        );
        return null;
      }
      // CHANGES-REQUESTED → parsed fix path. Mechanical parse, safe
      // for auto-approve under VA-481.
      return {
        mode: { kind: "fix-request" as const, fix: verdict.fix },
        summary: `CHANGES-REQUESTED — ${truncate(verdict.fix, 100)}`,
        rationale:
          "Bot reviewer emitted REVIEW: CHANGES-REQUESTED with a parsed fix line.",
        autoApproveEligible: true,
      };
    }

    // Human path — consult the LLM. LLM interpretation is NOT
    // auto-approve-eligible: even in `auto` mode, the operator
    // accepts/rejects so a mis-interpretation doesn't run away.
    const interpreter = ctx.interpretComment ?? VERBATIM_INTERPRETER;
    const interpretation = yield* interpreter({
      commentBody: comment.body,
      commentAuthor: comment.authorLogin,
      commentSource: comment.source,
    });
    return {
      mode: {
        kind: "verbatim" as const,
        commentAuthor: comment.authorLogin,
        commentSource: comment.source,
        commentBody: comment.body,
      },
      summary: interpretation.summary,
      rationale: interpretation.rationale,
      autoApproveEligible: false,
    };
  });

interface EmitProposedArgs {
  readonly recommendationId: string;
  readonly prNumber: number;
  readonly commentId: number;
  readonly commentAuthor: string;
  readonly commentSource: string;
  readonly commentBody: string;
  readonly mode: DecidedRecommendation["mode"];
  readonly summary: string;
  readonly rationale: string;
  readonly autoApproveEligible: boolean;
  readonly nowNano: string;
}

const emitProposed = (args: EmitProposedArgs): Effect.Effect<void> => {
  const evidence = {
    prNumber: args.prNumber,
    commentId: args.commentId,
    commentAuthor: args.commentAuthor,
    commentSource: args.commentSource,
    mode: args.mode.kind,
    fix: args.mode.kind === "fix-request" ? args.mode.fix : null,
    commentBody:
      args.mode.kind === "verbatim" ? args.mode.commentBody : null,
    interpretationRationale: args.rationale,
  };
  return Effect.logInfo(PLANNER_RECOMMENDATION_PROPOSED_LOG).pipe(
    Effect.annotateLogs({
      recommendationId: args.recommendationId,
      capability: REVIEWER_CAPABILITY,
      target: `PR-${args.prNumber}`,
      summary: args.summary,
      evidence: JSON.stringify(evidence),
      autoApproveEligible: String(args.autoApproveEligible),
      timestampUnixNano: args.nowNano,
    }),
  );
};

interface RunAcceptedActionArgs {
  readonly ctx: ReviewerCapabilityContext;
  readonly row: OpenShepherdedPrRow;
  readonly comment: PrComment;
  readonly recommendationId: string;
  readonly actionsCompleted: string[];
  readonly actionsFailed: string[];
}

const runAcceptedAction = (
  args: RunAcceptedActionArgs,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const { ctx, row, comment, recommendationId } = args;
    const startNano = ctx.now();
    const actionId = actionIdFor(row.prNumber, comment.id, startNano);
    const invoke =
      ctx.invokeReviewerResponseAgent ?? defaultInvokeReviewerResponseAgent;

    yield* Effect.logInfo(PLANNER_ACTION_STARTED_LOG).pipe(
      Effect.annotateLogs({
        actionId,
        recommendationId,
        capability: REVIEWER_CAPABILITY,
        target: `PR-${row.prNumber}`,
        timestampUnixNano: startNano,
      }),
    );

    // Reconstruct the invocation mode from the accepted recommendation
    // evidence. The recommendation row carries everything we need,
    // but the dispatcher re-derives it from the live comment here to
    // avoid coupling the action to the recommendation's stored JSON
    // shape (which the dashboard owns).
    const mode = reconstructMode(comment, ctx.config);

    const result = yield* invoke({
      issue: rowToRunwayIssue(row),
      branch: row.branch,
      cwd: ctx.cwd,
      config: ctx.config,
      mode,
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
      const outcome =
        mode.kind === "fix-request"
          ? "Addressed reviewer fix-request"
          : `Responded to ${comment.authorLogin || "reviewer"} comment`;
      yield* Effect.logInfo(PLANNER_ACTION_COMPLETED_LOG).pipe(
        Effect.annotateLogs({
          actionId,
          outcome,
          timestampUnixNano: ctx.now(),
        }),
      );
      args.actionsCompleted.push(actionId);
      return;
    }

    const errorMsg =
      mode.kind === "fix-request"
        ? `Reviewer CHANGES-REQUESTED BLOCKED: ${result.reason}`
        : `Reviewer comment BLOCKED (${comment.authorLogin || "unknown"}): ${result.reason}`;
    yield* Effect.logInfo(PLANNER_ACTION_FAILED_LOG).pipe(
      Effect.annotateLogs({
        actionId,
        error: errorMsg,
        timestampUnixNano: ctx.now(),
      }),
    );
    args.actionsFailed.push(actionId);
  });

function reconstructMode(
  comment: PrComment,
  config: Config,
): ReviewerResponseInvocation["mode"] {
  const botLogin = config.prReviewerBotLogin?.trim();
  const isBot = Boolean(botLogin) && comment.authorLogin === botLogin;
  if (isBot) {
    const verdict = parsePrReviewVerdict(comment.body);
    if (verdict.kind === "changes-requested") {
      return { kind: "fix-request", fix: verdict.fix };
    }
  }
  return {
    kind: "verbatim",
    commentAuthor: comment.authorLogin,
    commentSource: comment.source,
    commentBody: comment.body,
  };
}
