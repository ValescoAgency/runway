import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { Storage } from "../../dashboard/storage.js";
import { loadContextFor, type HindsightWiring, type RunReviewContext } from "../context.js";
import type {
  CapturedCodingAgentReport,
  CapturedIssueProcess,
  CapturedNorms,
  CapturedReviewerReport,
  MetaDashboardRead,
} from "../dashboard-read.js";
import {
  shouldRunIRA,
  type MetaFilterThresholds,
} from "../heuristic-filter.js";
import type { MetaLinearGateway } from "../linear-meta.js";
import { callRunReview, type AnthropicError } from "../llm.js";
import {
  RUN_REVIEW_VERSION,
  type HindsightSignals,
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
  /**
   * VA-403: optional hindsight wiring. When present, the loaded
   * `RunReviewContext.hindsightSignals` is populated and the user
   * prompt includes the captured PR state + Linear follow-ups.
   * When absent, the pass behaves like the v1.0.0 tracer (no
   * hindsight in the prompt; v1.1.0 schema still accepts the null
   * sentinel emitted in that case).
   */
  readonly hindsight?: HindsightWiring;
  /**
   * VA-403: how stale the drain must be before the IRA grades it.
   * Compared against `loadDrainEndTime` — the latest end_time
   * across the trace's issue_processes. Default 18h per PRD.
   * `0` disables the gate (alias for the `--force` CLI flag).
   */
  readonly delayHours?: number;
  /**
   * VA-403: bypass the delay gate. Set when the operator passed
   * `--force` on the CLI. The gate still computes drain age and
   * logs it via the outcome's `delayed` reason for audit trail —
   * we just don't act on it.
   */
  readonly force?: boolean;
  /**
   * Override "now" for tests. Defaults to `Date.now()`. Production
   * callers leave this unset.
   */
  readonly now?: () => number;
  // VA-404: optional override of the heuristic-filter thresholds.
  // Undefined → DEFAULT_META_FILTER_THRESHOLDS.
  readonly metaFilterThresholds?: MetaFilterThresholds;
  /**
   * VA-405: rolling-norm window in drains. When set + non-zero, the
   * context loader queries `loadNorms(category, normsWindow)` from
   * the VA-399 read-model and the IRA's user prompt grows a `# Norms`
   * section. When omitted / zero, norms stay null (v1.1.0 back-compat).
   */
  readonly normsWindow?: number;
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
    }
  | {
      // VA-403: drain too fresh (younger than `delayHours`). The
      // pass exits without calling Anthropic / Linear / SQLite —
      // operator re-runs after the delay window elapses. Distinct
      // from `failed` so the CLI can render a friendly retry hint
      // instead of a stub-and-continue notice.
      readonly kind: "delayed";
      readonly drainAgeHours: number;
      readonly thresholdHours: number;
      readonly retryAfterIso: string;
    }
  | {
      // VA-404: heuristic pre-filter trip. The run looked clean enough
      // (no retry, no HITL, no revert, no infra error, low iter count)
      // that paying for an IRA Anthropic call wouldn't add signal.
      // Writes a `meta-skipped` SQLite row; no LLM, no Linear.
      readonly kind: "skipped";
      readonly metaReviewId: string;
      readonly reason: string;
    };

const DEFAULT_DELAY_HOURS = 18;
const NS_PER_MS = 1_000_000;

// ---------------------------------------------------------------------------
// Pass body
// ---------------------------------------------------------------------------

export const runRunReviewPass = (
  args: RunReviewPassArgs,
  deps: RunReviewPassDeps,
): Effect.Effect<RunReviewPassOutcome, never, never> =>
  Effect.gen(function* () {
    // 0) VA-403 delay gate. Hindsight has to land before we judge —
    //    PR merge / human comments / follow-up issues all need real
    //    time to accumulate. Default 18h. `--force` bypasses but we
    //    still compute the age so the CLI can log what was skipped.
    const delayHours = deps.delayHours ?? DEFAULT_DELAY_HOURS;
    if (delayHours > 0 && !deps.force) {
      const endNanoResult = yield* deps.dashboardRead
        .loadDrainEndTime(args.traceId)
        .pipe(Effect.either);
      const endNano =
        endNanoResult._tag === "Right" ? endNanoResult.right : null;
      const nowMs = (deps.now ?? Date.now)();
      // Unknown drain age is treated as "fresh" — the conservative
      // default. An unfound drain may also be a typo / wrong db, but
      // the operator's explicit recovery is `--force`.
      const ageHours =
        endNano !== null ? hoursBetween(endNano, nowMs) : 0;
      if (ageHours < delayHours) {
        const retryAfterMs =
          nowMs + Math.ceil((delayHours - ageHours) * 60 * 60 * 1000);
        return {
          kind: "delayed",
          drainAgeHours: round1(ageHours),
          thresholdHours: delayHours,
          retryAfterIso: new Date(retryAfterMs).toISOString(),
        } satisfies RunReviewPassOutcome;
      }
    }

    // 1) Load the captured context via the `meta/context` seam.
    //    Discriminated by pass — VA-403 / VA-405 widen the shape
    //    without editing this pass.
    const contextResult = yield* loadContextFor(
      {
        pass: "run-review",
        traceId: args.traceId,
        issueIdentifier: args.issueIdentifier,
        hindsight: deps.hindsight,
        normsWindow: deps.normsWindow,
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

    // 1.5) VA-404: heuristic pre-filter. Uneventful runs (clean
    //      one-iteration merges) skip the LLM call entirely — write a
    //      `meta-skipped` row and exit. No Linear issue. Saves spend
    //      and noise on the meta-project view.
    const decision = shouldRunIRA(ctx, deps.metaFilterThresholds);
    if (!decision.run) {
      return yield* writeSkippedRow(args, deps, decision.reason);
    }

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
        ctx.hindsightSignals,
        ctx.norms,
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

const writeSkippedRow = (
  args: RunReviewPassArgs,
  deps: RunReviewPassDeps,
  reason: string,
): Effect.Effect<RunReviewPassOutcome, never, never> =>
  Effect.sync(() => {
    const metaReviewId = randomUUID();
    deps.storage.saveMetaReview({
      id: metaReviewId,
      kind: "meta-skipped",
      scope: args.issueIdentifier,
      drainId: args.traceId,
      issueId: args.issueIdentifier,
      contentJson: JSON.stringify({ reason }),
      templateVersion: RUN_REVIEW_VERSION,
      createdAt: nowIso(),
    });
    return { kind: "skipped", metaReviewId, reason };
  });

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
  "Schema (template_version 1.2.0):",
  "  {",
  "    \"template_version\": \"1.2.0\",",
  "    \"issue_identifier\": \"<echo of input>\",",
  "    \"drain_trace_id\": \"<echo of input>\",",
  "    \"final_outcome\": \"<one of: opened | hitl | reverted | errored | unknown>\",",
  "    \"issue_quality\":        {\"absolute\": <STRONG|ADEQUATE|WEAK|FAILED>, \"justification\": \"<1 sentence>\"},",
  "    \"prompt_quality\":       {\"absolute\": <STRONG|ADEQUATE|WEAK|FAILED>, \"justification\": \"<1 sentence>\"},",
  "    \"agent_quality\":        {\"absolute\": <STRONG|ADEQUATE|WEAK|FAILED>, \"justification\": \"<1 sentence>\"},",
  "    \"reviewer_quality\":     {\"absolute\": <STRONG|ADEQUATE|WEAK|FAILED>, \"justification\": \"<1 sentence>\"},",
  "    \"orchestration_quality\":{\"absolute\": <STRONG|ADEQUATE|WEAK|FAILED>, \"justification\": \"<1 sentence>\"},",
  "    \"issue_quality_relative\":         <BETTER|STEADY|WORSE>,  // omit when norms unavailable",
  "    \"prompt_quality_relative\":        <BETTER|STEADY|WORSE>,",
  "    \"agent_quality_relative\":         <BETTER|STEADY|WORSE>,",
  "    \"reviewer_quality_relative\":      <BETTER|STEADY|WORSE>,",
  "    \"orchestration_quality_relative\": <BETTER|STEADY|WORSE>,",
  "    \"recommendations\": [",
  "      {\"target\": <prompt|workflow|sandcastle|issue-body|tooling>, \"change\": \"<concrete change>\", \"confidence\": <LOW|MEDIUM|HIGH>}",
  "    ],",
  "    \"hindsight_signals\": null | {",
  "      \"pr\": null | {\"url\": \"<echo>\", \"state\": <open|merged|closed>, \"merged_at\": null | \"<iso>\"},",
  "      \"human_verdict\": null | {\"sentiment\": <approving|neutral|rejecting>, \"comment_count\": <number>, \"summary\": \"<1-2 sentences>\"},",
  "      \"follow_up_issues\": [{\"identifier\": \"<id>\", \"title\": \"<title>\"}]",
  "    }",
  "  }",
  "",
  "Absolute-axis grading:",
  "  - STRONG: dimension was notably good vs typical runway behaviour",
  "  - ADEQUATE: dimension met expectations, nothing notable",
  "  - WEAK: dimension fell short but didn't break the run",
  "  - FAILED: dimension caused the run to fail or required HITL escape",
  "",
  "Hindsight reading (VA-403):",
  "  - When the user prompt provides a `# Hindsight signals` section,",
  "    your `hindsight_signals` MUST be a populated object echoing what",
  "    you observed. Otherwise emit `null`.",
  "  - Reflect hindsight in your grades. A run that LOOKED clean in-band",
  "    but produced a closed-without-merge PR or attracted rejecting",
  "    human comments is NOT a STRONG agent_quality run — downgrade.",
  "  - A clean merge with no follow-up issues should bias toward STRONG",
  "    even if the in-band reports were noisy.",
  "  - Follow-up issues filed within the 48h window are evidence the run",
  "    didn't fully address the problem; weight them in agent_quality",
  "    and prompt_quality.",
  "",
  "Relative-axis grading (VA-405):",
  "  - When the user prompt provides a `# Norms` section, populate ALL FIVE",
  "    top-level `*_quality_relative` fields with one of BETTER / STEADY /",
  "    WORSE — these are the v1.2.0 contract field names. Otherwise (no",
  "    `# Norms` section, or you decline to grade on a small sample) omit",
  "    every `*_quality_relative` field entirely.",
  "  - BETTER: this run beat the typical cohort on the dimension's signals",
  "    (fewer iterations than the median, faster wall-time, no HITL/revert/",
  "    infra-error compared to a category that often hits those).",
  "  - STEADY: this run was within the typical band — close to median, no",
  "    notable outcome differences.",
  "  - WORSE: this run did worse than typical (iterations near/above p95,",
  "    wall-time near/above p95, hit a rejection/revert/HITL in a category",
  "    that usually doesn't).",
  "  - Match the relative grade to the SAME signal the absolute grade rests",
  "    on. e.g. an `agent_quality: ADEQUATE` graded on iteration count must",
  "    use the iteration-count percentiles for its relative axis.",
  "  - When norms exist but `sample_size < 5`, you may still grade relative",
  "    but call out the small sample in the dimension's `justification`",
  "    (\"vs 3-run sample, small-sample caveat\"). When sample_size is 0 the",
  "    gateway omits the `# Norms` section entirely — omit the top-level",
  "    `*_quality_relative` fields.",
  "",
  "Be honest. The IRA's value is in calling out real weaknesses, not in",
  "pretending every run was fine.",
].join("\n");

const composeUserPrompt = (
  args: RunReviewPassArgs,
  ip: CapturedIssueProcess,
  agentReport: CapturedCodingAgentReport,
  reviewerReport: CapturedReviewerReport,
  hindsight: HindsightSignals | null,
  norms: CapturedNorms | null,
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
  if (hindsight !== null) {
    lines.push("");
    lines.push("# Hindsight signals");
    lines.push(
      "(captured ~18h after the drain — these are real-world reactions",
      " to the run, not in-band agent claims; weight them appropriately)",
    );
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(hindsight, null, 2));
    lines.push("```");
  }
  if (norms !== null) {
    lines.push("");
    lines.push("# Norms");
    lines.push(
      `(rolling aggregates over the last ${norms.windowDrains} drains for`,
      ` issue-category \`${norms.category}\`; sample size ${norms.sampleSize}.`,
      " Use these for the `relative` axis on each grading section.)",
    );
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(norms, null, 2));
    lines.push("```");
  }
  lines.push("");
  lines.push(
    [
      "Emit a `runway-run-review` JSON block grading this run.",
      hindsight !== null
        ? "Echo the hindsight signals back in your `hindsight_signals` field."
        : "No hindsight available — set `hindsight_signals` to null.",
      norms !== null
        ? "Norms are present — populate every `relative` slot with BETTER/STEADY/WORSE."
        : "No norms available — leave every `relative` slot as null.",
    ].join(" "),
  );
  return lines.join("\n");
};

const renderReviewMarkdown = (
  review: RunReview,
  args: RunReviewPassArgs,
  ip: CapturedIssueProcess,
): string => {
  const grade = (
    label: string,
    section: RunReview["agent_quality"],
    relative: "BETTER" | "STEADY" | "WORSE" | undefined,
  ): string =>
    `- **${label}**: \`${section.absolute}\`${
      relative ? ` (${relative} vs norms)` : ""
    } — ${section.justification}`;

  return [
    `**Issue**: ${args.issueIdentifier} — ${ip.issueTitle ?? "(unknown)"}`,
    `**Drain**: \`${args.traceId}\``,
    `**Final outcome**: ${review.final_outcome}`,
    "",
    "## Grading",
    grade("Issue quality", review.issue_quality, review.issue_quality_relative),
    grade("Prompt quality", review.prompt_quality, review.prompt_quality_relative),
    grade("Agent quality", review.agent_quality, review.agent_quality_relative),
    grade("Reviewer quality", review.reviewer_quality, review.reviewer_quality_relative),
    grade("Orchestration quality", review.orchestration_quality, review.orchestration_quality_relative),
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

const hoursBetween = (endNanoStr: string, nowMs: number): number => {
  // end_time_unix_nano arrives as a string-encoded int64 (the OTel
  // SDK keeps it that way to avoid JS number precision drift).
  // Comparison is cheap if we drop to ms resolution — the delay
  // window is in hours, sub-millisecond precision is irrelevant.
  const endMs = Number(BigInt(endNanoStr) / BigInt(NS_PER_MS));
  const ageMs = nowMs - endMs;
  return ageMs / 3_600_000;
};

const round1 = (n: number): number => Math.round(n * 10) / 10;

const nowIso = (): string => new Date().toISOString().replace("T", " ").slice(0, 19);
