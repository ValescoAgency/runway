import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { Storage } from "../../dashboard/storage.js";
import { loadContextFor, type RunReviewContext } from "../context.js";
import type {
  CapturedCodingAgentReport,
  CapturedIssueProcess,
  CapturedReviewerReport,
  MetaDashboardRead,
} from "../dashboard-read.js";
import type { MetaLinearGateway } from "../linear-meta.js";
import { callRunReview, type AnthropicError } from "../llm.js";
import {
  RUN_REVIEW_VERSION,
  type ReportParseError,
  type RunReview,
} from "../templates.js";

/**
 * VA-402: the per-issue IRA pass. Loads the captured Coding Agent +
 * Reviewer reports for one (drain, issue) pair, asks the configured
 * Anthropic model to grade them, writes the resulting Run Review to
 * Linear's meta-project AND to the dashboard's `meta_reviews` table.
 *
 * No hindsight, no rolling norms, no heuristic pre-filter — those
 * land in VA-403 / VA-404 / VA-405. This slice is the end-to-end
 * tracer: prove the data flows.
 *
 * Failure handling per PRD: a parse error on the model's response is
 * NOT retried — the LLM said something we don't understand, the
 * orchestration retry budget already covered the network-side
 * transient failures. We emit a `meta-failed` stub row + a
 * stub Linear issue and exit 0 from the subcommand.
 */

// ---------------------------------------------------------------------------
// Pass input + output
// ---------------------------------------------------------------------------

export interface RunReviewPassDeps {
  readonly anthropicApiKey: string;
  readonly metaReviewModel: string;
  readonly dashboardRead: MetaDashboardRead;
  readonly metaLinear: MetaLinearGateway;
  readonly storage: Storage;
}

export interface RunReviewPassArgs {
  readonly traceId: string;
  readonly issueIdentifier: string;
}

export type RunReviewPassOutcome =
  | {
      readonly kind: "review";
      readonly metaReviewId: string;
      readonly linearIdentifier: string;
      readonly linearUrl: string;
    }
  | {
      readonly kind: "failed";
      readonly metaReviewId: string;
      readonly reason: string;
    };

// ---------------------------------------------------------------------------
// Pass body
// ---------------------------------------------------------------------------

export const runRunReviewPass = (
  args: RunReviewPassArgs,
  deps: RunReviewPassDeps,
): Effect.Effect<RunReviewPassOutcome, never, never> =>
  Effect.gen(function* () {
    // 1) Load the captured context via the `meta/context` seam.
    //    Discriminated by pass — VA-403 / VA-405 widen the shape
    //    without editing this pass.
    const contextResult = yield* loadContextFor(
      {
        pass: "run-review",
        traceId: args.traceId,
        issueIdentifier: args.issueIdentifier,
      },
      deps.dashboardRead,
    ).pipe(Effect.either);
    if (contextResult._tag === "Left") {
      return yield* writeFailedStub(
        args,
        deps,
        `failed to load context: ${
          (contextResult.left as { message?: string }).message ??
          String(contextResult.left)
        }`,
      );
    }
    const ctx: RunReviewContext = contextResult.right.context;

    // 2) Call the IRA LLM with a structured prompt. The `callRunReview`
    //    helper bakes in the version-handshake parse. Errors that
    //    survive retry land as `meta-failed`.
    const llmResult = yield* callRunReview({
      apiKey: deps.anthropicApiKey,
      model: deps.metaReviewModel,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: composeUserPrompt(
        args,
        ctx.issueProcess,
        ctx.codingAgentReport,
        ctx.reviewerReport,
      ),
    }).pipe(Effect.either);

    if (llmResult._tag === "Left") {
      return yield* writeFailedStub(
        args,
        deps,
        `LLM call failed after retry: ${formatAnthropicError(llmResult.left)}`,
      );
    }
    const parsed = llmResult.right;
    if (!parsed.ok) {
      return yield* writeFailedStub(
        args,
        deps,
        `LLM response failed parse: ${formatParseError(parsed.error)}`,
      );
    }

    // 3) Persist: write the Linear issue first (so the meta_reviews
    //    row can cross-link to it), then the SQLite row. A Linear
    //    failure after the LLM succeeded is still a "failed" outcome,
    //    but the body the model produced is preserved in the stub so
    //    nothing is lost.
    const issueResult = yield* deps.metaLinear
      .createRunReviewIssue({
        title: `Run Review: ${args.issueIdentifier} (drain ${shortenTrace(args.traceId)})`,
        body: renderReviewMarkdown(parsed.report, args, ctx.issueProcess),
      })
      .pipe(Effect.either);

    if (issueResult._tag === "Left") {
      return yield* writeFailedStub(
        args,
        deps,
        `Linear issue create failed: ${
          (issueResult.left as { message?: string }).message ??
          String(issueResult.left)
        }`,
        parsed.report,
      );
    }

    const metaReviewId = randomUUID();
    deps.storage.saveMetaReview({
      id: metaReviewId,
      kind: "meta-run-review",
      scope: args.issueIdentifier,
      drainId: args.traceId,
      issueId: args.issueIdentifier,
      contentJson: JSON.stringify({
        review: parsed.report,
        linear_issue_identifier: issueResult.right.identifier,
        linear_url: issueResult.right.url,
      }),
      templateVersion: parsed.report.template_version,
      createdAt: nowIso(),
    });

    return {
      kind: "review",
      metaReviewId,
      linearIdentifier: issueResult.right.identifier,
      linearUrl: issueResult.right.url,
    };
  });

// ---------------------------------------------------------------------------
// Helpers — stub-and-continue, prompt assembly, error formatting
// ---------------------------------------------------------------------------

const writeFailedStub = (
  args: RunReviewPassArgs,
  deps: RunReviewPassDeps,
  reason: string,
  preservedReview?: RunReview,
): Effect.Effect<RunReviewPassOutcome, never, never> =>
  Effect.gen(function* () {
    const metaReviewId = randomUUID();
    // VA-402 per PRD: failure writes BOTH a `meta-failed` SQLite row
    // AND a corresponding Linear stub issue in `runway-meta`. The
    // Linear stub means the operator sees the gap in the meta-project
    // view rather than only on the dashboard. Best-effort: if the
    // Linear write itself fails (e.g. the API was down), the SQLite
    // row still lands so we don't lose the audit record.
    const linearResult = yield* deps.metaLinear
      .createRunReviewIssue({
        title: `Run Review FAILED: ${args.issueIdentifier} (drain ${shortenTrace(args.traceId)})`,
        body: renderFailedStubMarkdown(args, reason, preservedReview),
      })
      .pipe(Effect.either);
    const linearIdentifier =
      linearResult._tag === "Right" ? linearResult.right.identifier : null;
    const linearUrl =
      linearResult._tag === "Right" ? linearResult.right.url : null;
    const secondaryLinearError =
      linearResult._tag === "Left"
        ? `linear stub write also failed: ${
            (linearResult.left as { message?: string }).message ??
            String(linearResult.left)
          }`
        : null;
    deps.storage.saveMetaReview({
      id: metaReviewId,
      kind: "meta-failed",
      scope: args.issueIdentifier,
      drainId: args.traceId,
      issueId: args.issueIdentifier,
      contentJson: JSON.stringify({
        reason,
        // VA-402: when the LLM succeeded but downstream persistence
        // failed, the model's output is preserved here so a manual
        // re-run doesn't pay for the same call twice.
        preserved_review: preservedReview ?? null,
        linear_stub_identifier: linearIdentifier,
        linear_stub_url: linearUrl,
        secondary_linear_error: secondaryLinearError,
      }),
      templateVersion: RUN_REVIEW_VERSION,
      createdAt: nowIso(),
    });
    return { kind: "failed", metaReviewId, reason };
  });

const renderFailedStubMarkdown = (
  args: RunReviewPassArgs,
  reason: string,
  preservedReview?: RunReview,
): string =>
  [
    `**Issue**: ${args.issueIdentifier}`,
    `**Drain**: \`${args.traceId}\``,
    "",
    "## Why this is a stub",
    "",
    "The IRA's Run Review pass failed before producing a graded review.",
    "This issue records the gap so the meta-project view matches the",
    "dashboard's `meta_reviews` row of kind `meta-failed`.",
    "",
    "## Reason",
    "",
    "```",
    reason,
    "```",
    preservedReview
      ? [
          "",
          "## Preserved partial review",
          "",
          "The LLM produced a parseable Run Review before downstream",
          "persistence failed. Preserved here so a manual re-run is",
          "not required.",
          "",
          "```json",
          JSON.stringify(preservedReview, null, 2),
          "```",
        ].join("\n")
      : "",
  ]
    .filter((line) => line !== "")
    .join("\n");

const missingCodingReport = (msg: string): CapturedCodingAgentReport => ({
  ok: false,
  kind: "missing",
  message: msg,
});

const missingReviewerReport = (msg: string): CapturedReviewerReport => ({
  ok: false,
  kind: "missing",
  message: msg,
});

const SYSTEM_PROMPT = [
  "You are the Independent Review Agent (IRA) — a retrospective evaluator",
  "for the runway coding-agent orchestrator. You judge how well runway",
  "performed on one issue, NOT whether the code is correct.",
  "",
  "Output exactly one fenced block, tagged `runway-run-review`, containing",
  "a JSON object matching the schema below. The fence must be on its own",
  "line; the body must be valid JSON. You may emit a short preamble before",
  "the fence, but nothing after the closing fence.",
  "",
  "Schema (template_version 1.0.0):",
  "  {",
  "    \"template_version\": \"1.0.0\",",
  "    \"issue_identifier\": \"<echo of input>\",",
  "    \"drain_trace_id\": \"<echo of input>\",",
  "    \"final_outcome\": \"<one of: opened | hitl | reverted | errored | unknown>\",",
  "    \"issue_quality\":        {\"absolute\": <STRONG|ADEQUATE|WEAK|FAILED>, \"relative\": null, \"justification\": \"<1 sentence>\"},",
  "    \"prompt_quality\":       {\"absolute\": <STRONG|ADEQUATE|WEAK|FAILED>, \"relative\": null, \"justification\": \"<1 sentence>\"},",
  "    \"agent_quality\":        {\"absolute\": <STRONG|ADEQUATE|WEAK|FAILED>, \"relative\": null, \"justification\": \"<1 sentence>\"},",
  "    \"reviewer_quality\":     {\"absolute\": <STRONG|ADEQUATE|WEAK|FAILED>, \"relative\": null, \"justification\": \"<1 sentence>\"},",
  "    \"orchestration_quality\":{\"absolute\": <STRONG|ADEQUATE|WEAK|FAILED>, \"relative\": null, \"justification\": \"<1 sentence>\"},",
  "    \"recommendations\": [",
  "      {\"target\": <prompt|workflow|sandcastle|issue-body|tooling>, \"change\": \"<concrete change>\", \"confidence\": <LOW|MEDIUM|HIGH>}",
  "    ],",
  "    \"hindsight_signals\": null",
  "  }",
  "",
  "Grading guidance:",
  "  - STRONG: dimension was notably good vs typical runway behaviour",
  "  - ADEQUATE: dimension met expectations, nothing notable",
  "  - WEAK: dimension fell short but didn't break the run",
  "  - FAILED: dimension caused the run to fail or required HITL escape",
  "",
  "All `relative` slots stay `null` at this slice — rolling norms are not",
  "yet available. `hindsight_signals` stays `null` — hindsight is also a",
  "later slice. Be honest. The IRA's value is in calling out real",
  "weaknesses, not in pretending every run was fine.",
].join("\n");

const composeUserPrompt = (
  args: RunReviewPassArgs,
  ip: CapturedIssueProcess,
  agentReport: CapturedCodingAgentReport,
  reviewerReport: CapturedReviewerReport,
): string => {
  const lines: string[] = [];
  lines.push(`Drain trace id: ${args.traceId}`);
  lines.push(`Issue identifier: ${args.issueIdentifier}`);
  lines.push(`Issue title: ${ip.issueTitle ?? "(unknown)"}`);
  lines.push(
    `Issue labels: ${ip.issueLabels.length === 0 ? "(none)" : ip.issueLabels.join(", ")}`,
  );
  lines.push(`Final outcome: ${ip.outcomeKind ?? "unknown"}`);
  lines.push(
    `Outcome detail: ${ip.outcomeDetail ?? "(none)"}`,
  );
  lines.push("");
  lines.push("# Coding Agent Report");
  if (agentReport.ok) {
    lines.push(`(template_version ${agentReport.templateVersion}, iteration ${agentReport.iterationIndex})`);
    lines.push("");
    lines.push("```json");
    lines.push(agentReport.payload);
    lines.push("```");
  } else {
    lines.push(
      `(unavailable: ${agentReport.kind}${
        agentReport.kind === "error" ? ` — ${agentReport.errorKind}` : ""
      })`,
    );
    lines.push(agentReport.message);
  }
  lines.push("");
  lines.push("# Reviewer Report");
  if (reviewerReport.ok) {
    lines.push(`(template_version ${reviewerReport.templateVersion})`);
    lines.push("");
    lines.push("```json");
    lines.push(reviewerReport.payload);
    lines.push("```");
  } else {
    lines.push(
      `(unavailable: ${reviewerReport.kind}${
        reviewerReport.kind === "error" ? ` — ${reviewerReport.errorKind}` : ""
      })`,
    );
    lines.push(reviewerReport.message);
  }
  lines.push("");
  lines.push("Emit a `runway-run-review` JSON block grading this run.");
  return lines.join("\n");
};

const renderReviewMarkdown = (
  review: RunReview,
  args: RunReviewPassArgs,
  ip: CapturedIssueProcess,
): string => {
  const grade = (label: string, section: RunReview["agent_quality"]): string =>
    `- **${label}**: \`${section.absolute}\`${
      section.relative ? ` (${section.relative} vs norms)` : ""
    } — ${section.justification}`;

  return [
    `**Issue**: ${args.issueIdentifier} — ${ip.issueTitle ?? "(unknown)"}`,
    `**Drain**: \`${args.traceId}\``,
    `**Final outcome**: ${review.final_outcome}`,
    "",
    "## Grading",
    grade("Issue quality", review.issue_quality),
    grade("Prompt quality", review.prompt_quality),
    grade("Agent quality", review.agent_quality),
    grade("Reviewer quality", review.reviewer_quality),
    grade("Orchestration quality", review.orchestration_quality),
    "",
    "## Recommendations",
    review.recommendations.length === 0
      ? "(none)"
      : review.recommendations
          .map(
            (r) =>
              `- (\`${r.target}\`, confidence ${r.confidence}) ${r.change}`,
          )
          .join("\n"),
    "",
    "## Raw Review",
    "```json",
    JSON.stringify(review, null, 2),
    "```",
  ].join("\n");
};

const formatAnthropicError = (err: AnthropicError): string =>
  `${err._tag}: ${err.message}`;

const formatParseError = (err: ReportParseError): string => {
  if (err.kind === "version-mismatch") {
    return `version-mismatch (expected ${err.expectedMajor}.x.x, observed ${err.observed})`;
  }
  return `${err.kind}: ${err.message}`;
};

const shortenTrace = (traceId: string): string =>
  traceId.length > 8 ? traceId.slice(0, 8) : traceId;

const nowIso = (): string => new Date().toISOString().replace("T", " ").slice(0, 19);
