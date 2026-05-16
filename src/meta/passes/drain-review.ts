import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { META_REVIEW_KIND, type Storage } from "../../dashboard/storage.js";
import {
  loadContextFor,
  type DrainReviewContext,
} from "../context.js";
import type {
  CapturedIssueProcess,
  DrainMetaRow,
  MetaDashboardRead,
} from "../dashboard-read.js";
import {
  formatAnthropicError,
  formatParseError,
  messageOf,
  nowIso,
  shortenTrace,
} from "../format.js";
import type { MetaLinearGateway } from "../linear-meta.js";
import { callDrainReview } from "../llm.js";
import {
  DRAIN_REVIEW_VERSION,
  type DrainReview,
} from "../templates.js";

/**
 * VA-406: per-drain IRA pass. Loads every issue_process for the
 * drain plus every per-issue meta_reviews row (Run Review / skip /
 * failed). Asks the configured Anthropic model to grade composition,
 * sequencing, and cross-issue patterns. On `severity: critical`,
 * escalates to a runway-repo Linear issue with the
 * `["Bug", "runway-meta-promoted"]` label pair from the AC.
 *
 * Failure handling mirrors Run Review (VA-402): one retry inside
 * `applyAnthropicPolicy`, then stub-and-continue (meta-failed row +
 * Linear stub in runway-meta) so an Anthropic outage doesn't cascade
 * across drains.
 */

// ---------------------------------------------------------------------------
// Pass input + output
// ---------------------------------------------------------------------------

export interface DrainReviewPassDeps {
  readonly anthropicApiKey: string;
  readonly metaReviewModel: string;
  readonly dashboardRead: MetaDashboardRead;
  readonly metaLinear: MetaLinearGateway;
  readonly storage: Storage;
}

export interface DrainReviewPassArgs {
  readonly traceId: string;
}

export type DrainReviewPassOutcome =
  | {
      readonly kind: "review";
      readonly metaReviewId: string;
      readonly linearIdentifier: string;
      readonly linearUrl: string;
      readonly severity: "critical" | "routine";
      /**
       * Set when severity === "critical" and the runway-repo
       * escalation issue was filed successfully. Null when escalation
       * skipped (severity routine) OR when the escalation write itself
       * failed (best-effort — the drain review still landed).
       */
      readonly escalationIdentifier: string | null;
      readonly escalationUrl: string | null;
    }
  | {
      readonly kind: "failed";
      readonly metaReviewId: string;
      readonly reason: string;
    }
  | {
      // VA-406: the drain has no per-issue meta_reviews yet, so there's
      // nothing to grade. Returned when the trigger fires too early
      // (defensive — the trigger condition should already guard) OR
      // when an operator runs `runway review drain --id X` against a
      // drain whose Run Reviews haven't been triggered yet.
      readonly kind: "no-run-reviews";
      readonly reason: string;
    };

// ---------------------------------------------------------------------------
// Pass body
// ---------------------------------------------------------------------------

export const runDrainReviewPass = (
  args: DrainReviewPassArgs,
  deps: DrainReviewPassDeps,
): Effect.Effect<DrainReviewPassOutcome, never, never> =>
  Effect.gen(function* () {
    // 1) Load the captured context.
    const contextResult = yield* loadContextFor(
      { pass: "drain-review", traceId: args.traceId },
      deps.dashboardRead,
    ).pipe(Effect.either);
    if (contextResult._tag === "Left") {
      return yield* writeFailedStub(
        args,
        deps,
        `failed to load context: ${
          messageOf(contextResult.left)
        }`,
      );
    }
    if (contextResult.right.pass !== "drain-review") {
      // Defensive — narrowing for the type system. The loader's switch
      // ensures this branch is unreachable in practice.
      return yield* writeFailedStub(
        args,
        deps,
        `context loader returned unexpected pass kind: ${contextResult.right.pass}`,
      );
    }
    const ctx: DrainReviewContext = contextResult.right.context;

    // 2) If the drain has no Run Reviews at all, skip — the IRA has
    //    nothing to grade. The trigger condition normally prevents
    //    this, but manual `runway review drain --id X` invocations
    //    on a fresh drain can race ahead.
    if (ctx.metaRows.length === 0) {
      return {
        kind: "no-run-reviews",
        reason: `no completed Run Reviews for drain ${shortenTrace(args.traceId)} — nothing to grade`,
      };
    }

    // 3) Call the IRA LLM with the drain-review structured prompt.
    const llmResult = yield* callDrainReview({
      apiKey: deps.anthropicApiKey,
      model: deps.metaReviewModel,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: composeUserPrompt(args, ctx),
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

    // 4) Persist: Linear meta-project issue first, then SQLite row
    //    (so the cross-link lands), then conditionally the runway-repo
    //    escalation on severity: critical.
    const issueResult = yield* deps.metaLinear
      .createDrainReviewIssue({
        title: `Drain Review: ${shortenTrace(args.traceId)} (${ctx.issueProcesses.length} issues)`,
        body: renderDrainReviewMarkdown(parsed.report, args, ctx),
      })
      .pipe(Effect.either);

    if (issueResult._tag === "Left") {
      return yield* writeFailedStub(
        args,
        deps,
        `Linear issue create failed: ${
          messageOf(issueResult.left)
        }`,
        parsed.report,
      );
    }

    // 5) Critical-severity escalation. Best-effort — a failure here
    //    does NOT downgrade the drain review outcome (it still landed
    //    in runway-meta). The operator sees both signals: the
    //    drain-review issue is filed, and the escalation gap is
    //    recorded in the meta_reviews content_json for debugging.
    const escalation = yield* maybeEscalate(
      args,
      deps,
      parsed.report,
      issueResult.right,
    );

    const metaReviewId = randomUUID();
    deps.storage.saveMetaReview({
      id: metaReviewId,
      kind: META_REVIEW_KIND.DRAIN,
      scope: args.traceId,
      drainId: args.traceId,
      issueId: null,
      contentJson: JSON.stringify({
        review: parsed.report,
        linear_issue_identifier: issueResult.right.identifier,
        linear_url: issueResult.right.url,
        escalation_identifier: escalation.identifier,
        escalation_url: escalation.url,
        escalation_error: escalation.error,
      }),
      templateVersion: parsed.report.template_version,
      createdAt: nowIso(),
    });

    return {
      kind: "review",
      metaReviewId,
      linearIdentifier: issueResult.right.identifier,
      linearUrl: issueResult.right.url,
      severity: parsed.report.severity,
      escalationIdentifier: escalation.identifier,
      escalationUrl: escalation.url,
    };
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface EscalationResult {
  readonly identifier: string | null;
  readonly url: string | null;
  readonly error: string | null;
}

const maybeEscalate = (
  args: DrainReviewPassArgs,
  deps: DrainReviewPassDeps,
  review: DrainReview,
  drainReviewLinear: { readonly identifier: string; readonly url: string },
): Effect.Effect<EscalationResult, never, never> =>
  Effect.gen(function* () {
    if (review.severity !== "critical") {
      return { identifier: null, url: null, error: null };
    }
    const result = yield* deps.metaLinear
      .createRunwayRepoIssue({
        title: `runway: ${truncate(deriveEscalationTitle(review), 80)}`,
        body: renderEscalationMarkdown(review, args, drainReviewLinear),
        // VA-406 AC: "with `Bug` category label + `runway-meta-promoted`
        // label". Labels are auto-created on the team if missing.
        labels: ["Bug", "runway-meta-promoted"],
      })
      .pipe(Effect.either);
    if (result._tag === "Right") {
      return {
        identifier: result.right.identifier,
        url: result.right.url,
        error: null,
      };
    }
    return {
      identifier: null,
      url: null,
      error: `escalation write failed: ${
        messageOf(result.left)
      }`,
    };
  });

const writeFailedStub = (
  args: DrainReviewPassArgs,
  deps: DrainReviewPassDeps,
  reason: string,
  preservedReview?: DrainReview,
): Effect.Effect<DrainReviewPassOutcome, never, never> =>
  Effect.gen(function* () {
    const metaReviewId = randomUUID();
    // Same shape as Run Review's stub-and-continue: write a Linear
    // stub in runway-meta so the operator sees the gap, then write the
    // SQLite row with cross-link info. Best-effort on the Linear write
    // — if it fails too, the SQLite row records the secondary failure.
    const linearResult = yield* deps.metaLinear
      .createDrainReviewIssue({
        title: `Drain Review FAILED: ${shortenTrace(args.traceId)}`,
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
            messageOf(linearResult.left)
          }`
        : null;
    deps.storage.saveMetaReview({
      id: metaReviewId,
      kind: META_REVIEW_KIND.FAILED,
      scope: args.traceId,
      drainId: args.traceId,
      issueId: null,
      contentJson: JSON.stringify({
        reason,
        pass: "drain-review",
        preserved_review: preservedReview ?? null,
        linear_stub_identifier: linearIdentifier,
        linear_stub_url: linearUrl,
        secondary_linear_error: secondaryLinearError,
      }),
      templateVersion: DRAIN_REVIEW_VERSION,
      createdAt: nowIso(),
    });
    return { kind: "failed", metaReviewId, reason };
  });

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  "You are the Independent Review Agent (IRA) — a retrospective evaluator",
  "for the runway coding-agent orchestrator. You are reviewing one DRAIN",
  "(a single end-to-end run of `runway run` that processed N Linear issues).",
  "",
  "Your job is to grade composition, sequencing, and cross-issue patterns —",
  "NOT to re-grade individual issues (the Run Review pass already did that;",
  "you read those reviews as input). Look for emergent patterns: did one",
  "issue's HITL block another? Did a schema migration land before the UI",
  "fix that depends on it? Did three runs in a row hit the same failure",
  "mode that suggests a systemic prompt or workflow issue?",
  "",
  "Output exactly one fenced block, tagged `runway-drain-review`, containing",
  "a JSON object matching the schema below. The fence must be on its own",
  "line; the body must be valid JSON. You may emit a short preamble before",
  "the fence, but nothing after the closing fence.",
  "",
  "Schema (template_version 1.0.0):",
  "  {",
  "    \"template_version\": \"1.0.0\",",
  "    \"drain_trace_id\": \"<echo of input>\",",
  "    \"issue_count\": <number>,",
  "    \"outcomes_summary\": { \"<outcome-kind>\": <count>, ... },",
  "    \"sequencing_assessment\": \"<2-4 sentences on the order issues ran in>\",",
  "    \"cross_issue_patterns\": [\"<observation>\", ...],",
  "    \"notable_events\": [",
  "      { \"issue_identifier\": \"<id>\", \"event\": \"<description>\",",
  "        \"run_review_url\": \"<linear url or null>\" }",
  "    ],",
  "    \"recommendations\": [",
  "      { \"target\": <prompt|workflow|sandcastle|issue-body|tooling>,",
  "        \"change\": \"<concrete change>\",",
  "        \"confidence\": <LOW|MEDIUM|HIGH> }",
  "    ],",
  "    \"severity\": <critical|routine>,",
  "    \"severity_justification\": \"<1-2 sentences explaining why>\"",
  "  }",
  "",
  "Severity gate — read carefully. Default to `routine`. Mark `critical`",
  "ONLY when at least one of these holds:",
  "  - The orchestration bug makes the NEXT drain unsafe (e.g. data loss,",
  "    silent state corruption, drain-blocking deadlock).",
  "  - The drain LOST captured agent or reviewer output (e.g. spans flushed",
  "    but bodies dropped, mid-run crash with no preserved artifact).",
  "  - A pattern emerged that, if not fixed before the next drain, will",
  "    waste real human reviewer time at scale (e.g. systematic false-",
  "    rejection by the reviewer agent across multiple unrelated issues).",
  "",
  "DO NOT mark `critical` for:",
  "  - One bad agent run (that's a Run Review concern).",
  "  - Slow wall-time on a single issue (norms, not severity).",
  "  - HITL escapes that the system handled correctly (HITL is the safety",
  "    valve working, not a critical failure).",
  "  - Reviewer disagreements that converged within the retry budget.",
  "",
  "Always write `severity_justification` — even for `routine`, give a one-",
  "line reason. Future audits read your reasoning either way.",
  "",
  "Recommendations should be concrete and actionable, NOT 'consider thinking",
  "about X.' Target taxonomy matches the Run Review one so the Weekly",
  "promoter (a later slice) can group by structural kind.",
].join("\n");

const composeUserPrompt = (
  args: DrainReviewPassArgs,
  ctx: DrainReviewContext,
): string => {
  const lines: string[] = [];
  lines.push(`Drain trace id: ${args.traceId}`);
  lines.push(`Issue process count: ${ctx.issueProcesses.length}`);
  lines.push("");
  lines.push("# Issue Processes (in start-time order)");
  lines.push("");
  for (const ip of ctx.issueProcesses) {
    lines.push(renderIssueProcessLine(ip));
  }
  lines.push("");
  lines.push("# Per-issue meta_reviews");
  lines.push("");
  lines.push(
    "(One row per issue. `meta-skipped` = heuristic filter decided not to grade;",
    " `meta-failed` = IRA Run Review pass failed for that issue. Both count as",
    " \"complete\" for triggering THIS drain review — note the absence of grade",
    " where it matters.)",
  );
  lines.push("");
  for (const row of ctx.metaRows) {
    lines.push(renderMetaRowBlock(row));
    lines.push("");
  }
  lines.push("");
  lines.push(
    [
      "Emit a `runway-drain-review` JSON block grading this drain.",
      "Echo the drain trace id back in the JSON.",
      "Choose severity carefully per the gate above.",
    ].join(" "),
  );
  return lines.join("\n");
};

const renderIssueProcessLine = (ip: CapturedIssueProcess): string => {
  const labels = ip.issueLabels.length === 0 ? "" : ` [${ip.issueLabels.join(", ")}]`;
  const outcome = ip.outcomeKind ?? "in-flight";
  const detail = ip.outcomeDetail ? ` — ${ip.outcomeDetail}` : "";
  return `- **${ip.issueIdentifier}** (${outcome})${labels}${detail}`;
};

const renderMetaRowBlock = (row: DrainMetaRow): string => {
  const header = `## ${row.issueId ?? "(unknown issue)"} — ${row.kind}`;
  return [
    header,
    "",
    "```json",
    row.contentJson,
    "```",
  ].join("\n");
};

// ---------------------------------------------------------------------------
// Markdown renderers — for Linear bodies (meta-project + runway-repo)
// ---------------------------------------------------------------------------

const renderDrainReviewMarkdown = (
  review: DrainReview,
  args: DrainReviewPassArgs,
  ctx: DrainReviewContext,
): string => {
  const outcomeLines = Object.entries(review.outcomes_summary).map(
    ([kind, count]) => `- ${kind}: ${count}`,
  );
  const patternLines =
    review.cross_issue_patterns.length === 0
      ? ["(none)"]
      : review.cross_issue_patterns.map((p) => `- ${p}`);
  const notableLines =
    review.notable_events.length === 0
      ? ["(none)"]
      : review.notable_events.map((e) => {
          const link = e.run_review_url ? ` ([review](${e.run_review_url}))` : "";
          return `- **${e.issue_identifier}**: ${e.event}${link}`;
        });
  const recLines =
    review.recommendations.length === 0
      ? ["(none)"]
      : review.recommendations.map(
          (r) => `- (\`${r.target}\`, confidence ${r.confidence}) ${r.change}`,
        );
  return [
    `**Drain**: \`${args.traceId}\``,
    `**Issue count**: ${ctx.issueProcesses.length}`,
    `**Severity**: \`${review.severity}\` — ${review.severity_justification}`,
    "",
    "## Outcomes",
    ...outcomeLines,
    "",
    "## Sequencing assessment",
    review.sequencing_assessment,
    "",
    "## Cross-issue patterns",
    ...patternLines,
    "",
    "## Notable events",
    ...notableLines,
    "",
    "## Recommendations",
    ...recLines,
    "",
    "## Raw Review",
    "```json",
    JSON.stringify(review, null, 2),
    "```",
  ].join("\n");
};

const renderEscalationMarkdown = (
  review: DrainReview,
  args: DrainReviewPassArgs,
  drainReviewLinear: { readonly identifier: string; readonly url: string },
): string =>
  [
    `**Source**: [${drainReviewLinear.identifier}](${drainReviewLinear.url}) (Drain Review for drain \`${shortenTrace(args.traceId)}\`)`,
    `**Severity**: \`critical\` — ${review.severity_justification}`,
    "",
    "## Why this is a runway-repo issue",
    "",
    "The IRA's Drain Review flagged this drain `critical` per the gate",
    "criteria (next drain unsafe OR captured data lost OR systemic",
    "reviewer pattern). Severity-critical findings escalate directly to",
    "the runway-repo project rather than waiting for the Weekly Review",
    "cadence — this is the bypass for urgent orchestration bugs.",
    "",
    "## Recommendations (from the Drain Review)",
    "",
    review.recommendations.length === 0
      ? "(none — Drain Review marked critical but emitted no recommendations. Investigate.)"
      : review.recommendations
          .map(
            (r) =>
              `- (\`${r.target}\`, confidence ${r.confidence}) ${r.change}`,
          )
          .join("\n"),
    "",
    "## Cross-issue patterns",
    "",
    review.cross_issue_patterns.length === 0
      ? "(none)"
      : review.cross_issue_patterns.map((p) => `- ${p}`).join("\n"),
    "",
    "Full drain review (with notable events + outcome breakdown):",
    `→ ${drainReviewLinear.url}`,
  ].join("\n");

const renderFailedStubMarkdown = (
  args: DrainReviewPassArgs,
  reason: string,
  preservedReview?: DrainReview,
): string =>
  [
    `**Drain**: \`${args.traceId}\``,
    "",
    "## Why this is a stub",
    "",
    "The IRA's Drain Review pass failed before producing a graded review.",
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
          "The LLM produced a parseable Drain Review before downstream",
          "persistence failed. Preserved here so a manual re-run is not",
          "required.",
          "",
          "```json",
          JSON.stringify(preservedReview, null, 2),
          "```",
        ].join("\n")
      : "",
  ]
    .filter((line) => line !== "")
    .join("\n");

const deriveEscalationTitle = (review: DrainReview): string => {
  // Prefer the highest-confidence recommendation's `change` text as a
  // concise headline. Falls back to the severity justification when
  // there are no recommendations (a critical-with-no-recs case is
  // unusual but the title still needs to say something).
  const recs = [...review.recommendations].sort((a, b) => {
    const order = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
    return order[a.confidence] - order[b.confidence];
  });
  return recs[0]?.change ?? review.severity_justification;
};

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : s.slice(0, max - 1) + "…";

