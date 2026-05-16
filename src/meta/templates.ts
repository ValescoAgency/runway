import { z } from "zod";

/**
 * VA-401 / VA-400: schemas + version-handshake parsers for every
 * structured report the runway → IRA pipeline relies on. Single
 * source of truth for shape — extending a template means bumping its
 * `template_version` here, updating the prompt that emits it, and
 * widening the schema. The version handshake makes silent shape
 * drift a loud, observable failure.
 *
 * Two parsing modes per template:
 *
 *   - **same major + minor**: parses cleanly under the current schema
 *     (the v1.x.x → v1.x.x case).
 *   - **same major + older minor**: still parses because the schema is
 *     intentionally forward-compatible inside a major (we tolerate
 *     missing optional fields, not missing required ones). A future
 *     v1.1.0 template won't break v1.0.0 callers.
 *   - **different major**: typed `version-mismatch` error. This is
 *     the failure mode the PRD's "silent shape drift" clause guards
 *     against — a major bump means the consumer must update before
 *     it can trust the new payload.
 *
 * Parsers never throw at the parse boundary; they return a tagged
 * result so callers can record the failure as a span attribute and
 * proceed with degraded data (vs crashing the whole drain on a single
 * malformed report). The PRD's "fails loudly" contract is satisfied
 * by surfacing the typed error to the dashboard, not by aborting the
 * orchestration.
 */

// ---------------------------------------------------------------------------
// Report parse result ADT — shared across every template
// ---------------------------------------------------------------------------

export type ReportParseResult<T> =
  | { readonly ok: true; readonly report: T }
  | { readonly ok: false; readonly error: ReportParseError };

export type ReportParseError =
  | { readonly kind: "missing-block"; readonly message: string }
  | {
      readonly kind: "version-mismatch";
      readonly expectedMajor: number;
      readonly observed: string;
      readonly message: string;
    }
  | { readonly kind: "malformed-json"; readonly message: string }
  | { readonly kind: "schema-mismatch"; readonly message: string };

const ok = <T>(report: T): ReportParseResult<T> => ({ ok: true, report });
const err = <T>(error: ReportParseError): ReportParseResult<T> => ({
  ok: false,
  error,
});

// ---------------------------------------------------------------------------
// Per-AC self-check shape — shared by CodingAgent + Reviewer reports
// ---------------------------------------------------------------------------

const PerAcSelfCheckSchema = z.object({
  ac: z.string().min(1),
  verdict: z.enum(["PASS", "FAIL", "NOT_ATTEMPTED"]),
  justification: z.string(),
});

export type PerAcSelfCheck = z.infer<typeof PerAcSelfCheckSchema>;

// ---------------------------------------------------------------------------
// Coding Agent Report (v1.0.0)
// ---------------------------------------------------------------------------

export const CODING_AGENT_REPORT_VERSION = "1.0.0";
export const CODING_AGENT_REPORT_FENCE_TAG = "runway-agent-report";

/**
 * Telemetry block in every Coding Agent Report — orchestrator-stamped
 * post-parse rather than agent-emitted. The agent has no reliable way
 * to know wall-time or its own model name, so we leave the slot
 * optional in the on-wire shape and `augmentCodingAgentReport` (in
 * the orchestrator) fills it in before the report is persisted to
 * spans / Linear / `meta_reviews`. The IRA reads telemetry alongside
 * the agent-emitted fields when grading the run.
 */
const CodingAgentTelemetrySchema = z.object({
  model: z.string(),
  tool_call_count: z.number().nonnegative(),
  wall_time_ms: z.number().nonnegative(),
});

export type CodingAgentTelemetry = z.infer<typeof CodingAgentTelemetrySchema>;

const CodingAgentReportSchema = z.object({
  template_version: z.string(),
  issue_identifier: z.string().min(1),
  approach: z.string(),
  files_modified: z.array(z.string()),
  tests_added_or_modified: z.array(z.string()),
  per_ac_self_check: z.array(PerAcSelfCheckSchema),
  risks_unknowns: z.array(z.string()),
  // PRD verdict alphabet — note that this is the *report* verdict
  // (the agent's view of their work product), distinct from the
  // `IMPL:` marker that drives orchestrator control flow. Mapping:
  //   IMPL: DONE      → DONE     (work is complete)
  //   IMPL: BLOCKED   → BLOCKED  (cannot proceed without human input)
  //   IMPL: CONTINUE  → PARTIAL  (made progress; not complete this iter)
  // The agent emits both — the prompt spells out the mapping so they
  // stay in sync. A divergence between marker and verdict is itself
  // a signal the IRA can grade on.
  verdict: z.enum(["DONE", "BLOCKED", "PARTIAL"]),
  verdict_reason: z.string(),
  telemetry: CodingAgentTelemetrySchema.optional(),
});

export type CodingAgentReport = z.infer<typeof CodingAgentReportSchema>;

export function parseCodingAgentReport(
  text: string,
): ReportParseResult<CodingAgentReport> {
  return parseReport(text, {
    fenceTag: CODING_AGENT_REPORT_FENCE_TAG,
    schema: CodingAgentReportSchema,
    expectedMajor: parseMajor(CODING_AGENT_REPORT_VERSION),
  });
}

/**
 * Orchestrator-side helper: stamp telemetry onto a parsed report
 * before it's projected into span attributes. Keeping the schema
 * field optional + an explicit augment seam means the on-wire
 * agent output stays small (agents only emit what they actually
 * know) and the durable record always has the runway-known facts.
 */
export function augmentCodingAgentReport(
  report: CodingAgentReport,
  telemetry: CodingAgentTelemetry,
): CodingAgentReport {
  return { ...report, telemetry };
}

// ---------------------------------------------------------------------------
// Reviewer Report (v1.0.0)
// ---------------------------------------------------------------------------

export const REVIEWER_REPORT_VERSION = "1.0.0";
export const REVIEWER_REPORT_FENCE_TAG = "runway-reviewer-report";

const PerAcValidationSchema = z.object({
  ac: z.string().min(1),
  agent_claim: z.enum(["PASS", "FAIL", "NOT_ATTEMPTED"]),
  my_verdict: z.enum(["PASS", "FAIL", "NOT_ATTEMPTED"]),
  justification: z.string(),
});

export type PerAcValidation = z.infer<typeof PerAcValidationSchema>;

const ReviewerReportSchema = z.object({
  template_version: z.string(),
  issue_identifier: z.string().min(1),
  per_ac_validation: z.array(PerAcValidationSchema),
  code_quality_concerns: z.array(z.string()),
  test_adequacy_concerns: z.array(z.string()),
  // PRD verdict alphabet — the *report* verdict (the reviewer's
  // judgment of the diff), distinct from the `REVIEW:` marker that
  // drives orchestrator control flow. Mapping:
  //   REVIEW: APPROVED        → APPROVE  (ship it)
  //   REVIEW: REJECTED-RETRY  → REJECT   (mechanically fixable)
  //   REVIEW: REJECTED-HITL   → HITL     (needs human judgment)
  // The reviewer emits both. The IRA grades on the report verdict;
  // the orchestrator routes on the marker. A marker / verdict
  // mismatch is a parseable signal of reviewer disagreement with
  // their own contract.
  verdict: z.enum(["APPROVE", "REJECT", "HITL"]),
  verdict_reason: z.string(),
  // Guidance is optional — only required (by convention) on rejection,
  // but a reviewer that wants to leave forward-looking notes on an
  // approved diff is allowed to.
  guidance_to_coding_agent: z.string().optional(),
});

export type ReviewerReport = z.infer<typeof ReviewerReportSchema>;

export function parseReviewerReport(
  text: string,
): ReportParseResult<ReviewerReport> {
  return parseReport(text, {
    fenceTag: REVIEWER_REPORT_FENCE_TAG,
    schema: ReviewerReportSchema,
    expectedMajor: parseMajor(REVIEWER_REPORT_VERSION),
  });
}

// ---------------------------------------------------------------------------
// Run Review (v1.0.0) — IRA's per-issue retrospective verdict
// ---------------------------------------------------------------------------

export const RUN_REVIEW_VERSION = "1.2.0";
export const RUN_REVIEW_FENCE_TAG = "runway-run-review";

/**
 * VA-402: PRD-spec absolute quality axis. STRONG / ADEQUATE / WEAK /
 * FAILED captures the IRA's view of how well runway performed each
 * dimension on this run. Paired with the VA-405 relative axis
 * (BETTER / STEADY / WORSE vs. recent norms) — each grading section
 * carries both.
 */
const QualityAbsoluteSchema = z.enum([
  "STRONG",
  "ADEQUATE",
  "WEAK",
  "FAILED",
]);

const QualityRelativeSchema = z.enum(["BETTER", "STEADY", "WORSE"]);

/**
 * Each quality dimension has an absolute axis + a relative axis. The
 * relative slot is populated when the IRA had rolling norms to
 * compare against (v1.2.0+ when norms were wired) and `null`
 * otherwise (v1.1.0 callers, or v1.2.0 runs where the category has
 * no rows in the configured window). Justification is one short
 * sentence — the IRA's reason for the absolute grade; ideally also
 * mentions how the relative grade was derived when populated.
 */
const QualitySectionSchema = z.object({
  absolute: QualityAbsoluteSchema,
  relative: QualityRelativeSchema.nullable(),
  justification: z.string(),
});

export type QualityAbsolute = z.infer<typeof QualityAbsoluteSchema>;
export type QualityRelative = z.infer<typeof QualityRelativeSchema>;
export type QualitySection = z.infer<typeof QualitySectionSchema>;

/**
 * VA-402: PRD-spec target taxonomy for IRA recommendations. The
 * Weekly Review's promoter (VA-408) groups recommendations by this
 * field as the structural pattern key — bumping the alphabet here
 * needs a coordinated change in the promoter.
 */
const RecommendationTargetSchema = z.enum([
  "prompt",
  "workflow",
  "sandcastle",
  "issue-body",
  "tooling",
]);

const RecommendationConfidenceSchema = z.enum(["LOW", "MEDIUM", "HIGH"]);

const RecommendationSchema = z.object({
  target: RecommendationTargetSchema,
  change: z.string().min(1),
  confidence: RecommendationConfidenceSchema,
});

export type RecommendationTarget = z.infer<typeof RecommendationTargetSchema>;
export type Recommendation = z.infer<typeof RecommendationSchema>;

/**
 * VA-403: hindsight signals captured ~18h after the drain so the IRA
 * grades against what the world said about the run, not just what the
 * agent and reviewer claimed in-band. Three orthogonal sources:
 *
 *   - PR state: did the PR runway opened actually merge? Closed
 *     without merge means a human pulled the plug.
 *   - human verdict: did a person comment on the PR review threads
 *     (excluding the runway bot's own automated chatter)?
 *   - follow-up issues: did anyone file new Linear issues in the 48h
 *     window referencing the source identifier? A flurry of follow-ups
 *     often signals a "looks fine, actually broke X" situation.
 *
 * Each sub-section is independently nullable — the gateway may have
 * partial data (no PR URL on the issue, GitHub token missing, etc.)
 * and the IRA grades on what's available rather than refusing to grade.
 *
 * Forward-compat on the minor bump: v1.0.0 wrote `hindsight_signals: null`
 * to the JSON; the v1.1.0 schema accepts `null` (the entire field absent
 * of structure) OR the populated object below. Old reviews still parse.
 */
const HindsightPrSchema = z.object({
  url: z.string().min(1),
  state: z.enum(["open", "merged", "closed"]),
  merged_at: z.string().nullable(),
});

const HindsightHumanVerdictSchema = z.object({
  // Coarse sentiment over the human review-thread comments. The IRA
  // summarises rather than echoing every comment so the Run Review
  // body stays bounded; the raw comments live in the user prompt.
  sentiment: z.enum(["approving", "neutral", "rejecting"]),
  comment_count: z.number().nonnegative(),
  summary: z.string(),
});

const HindsightFollowUpIssueSchema = z.object({
  identifier: z.string().min(1),
  title: z.string(),
});

const HindsightSignalsObjectSchema = z.object({
  pr: HindsightPrSchema.nullable(),
  human_verdict: HindsightHumanVerdictSchema.nullable(),
  follow_up_issues: z.array(HindsightFollowUpIssueSchema),
});

const HindsightSignalsSchema = z.union([
  z.null(),
  HindsightSignalsObjectSchema,
]);

export type HindsightPr = z.infer<typeof HindsightPrSchema>;
export type HindsightHumanVerdict = z.infer<typeof HindsightHumanVerdictSchema>;
export type HindsightFollowUpIssue = z.infer<typeof HindsightFollowUpIssueSchema>;
export type HindsightSignals = z.infer<typeof HindsightSignalsObjectSchema>;

const RunReviewSchema = z.object({
  template_version: z.string(),
  issue_identifier: z.string().min(1),
  drain_trace_id: z.string().min(1),
  final_outcome: z.string().min(1),
  // Five quality dimensions per PRD. Each is a QualitySection
  // (absolute + relative + justification). At this slice all
  // `relative` slots are `null` because no rolling norms exist yet.
  issue_quality: QualitySectionSchema,
  prompt_quality: QualitySectionSchema,
  agent_quality: QualitySectionSchema,
  reviewer_quality: QualitySectionSchema,
  orchestration_quality: QualitySectionSchema,
  recommendations: z.array(RecommendationSchema),
  hindsight_signals: HindsightSignalsSchema,
});

export type RunReview = z.infer<typeof RunReviewSchema>;

export function parseRunReview(text: string): ReportParseResult<RunReview> {
  return parseReport(text, {
    fenceTag: RUN_REVIEW_FENCE_TAG,
    schema: RunReviewSchema,
    expectedMajor: parseMajor(RUN_REVIEW_VERSION),
  });
}

// ---------------------------------------------------------------------------
// Generic parser — fence extraction → JSON parse → version handshake
// → schema validation
// ---------------------------------------------------------------------------

interface ParseSpec<T> {
  readonly fenceTag: string;
  readonly schema: z.ZodType<T>;
  readonly expectedMajor: number;
}

function parseReport<T>(
  text: string,
  spec: ParseSpec<T>,
): ReportParseResult<T> {
  const blockBody = extractFencedBlock(text, spec.fenceTag);
  if (blockBody === undefined) {
    return err({
      kind: "missing-block",
      message: `no \`\`\`${spec.fenceTag} … \`\`\` block found in output`,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(blockBody);
  } catch (e) {
    return err({
      kind: "malformed-json",
      message: `${spec.fenceTag} block body is not valid JSON: ${
        e instanceof Error ? e.message : String(e)
      }`,
    });
  }

  // VA-401: version handshake — major bump is a loud failure. Same
  // major (incl. older minor / patch) flows through to schema
  // validation. The version field is the FIRST gate so a v2.x.x
  // payload doesn't get rejected by zod for unrelated reasons.
  const versionField =
    parsed && typeof parsed === "object"
      ? (parsed as { template_version?: unknown }).template_version
      : undefined;
  if (typeof versionField !== "string" || versionField.length === 0) {
    return err({
      kind: "schema-mismatch",
      message: `${spec.fenceTag}: missing or non-string \`template_version\` field`,
    });
  }
  const observedMajor = parseMajor(versionField);
  if (observedMajor !== spec.expectedMajor) {
    return err({
      kind: "version-mismatch",
      expectedMajor: spec.expectedMajor,
      observed: versionField,
      message: `${spec.fenceTag}: expected template_version ${spec.expectedMajor}.x.x, observed ${versionField}`,
    });
  }

  const result = spec.schema.safeParse(parsed);
  if (!result.success) {
    return err({
      kind: "schema-mismatch",
      message: `${spec.fenceTag}: ${summariseZodIssues(result.error.issues)}`,
    });
  }
  return ok(result.data);
}

/**
 * Extract the contents of the LAST fenced block tagged `fenceTag`.
 * Multiple blocks → take the last one (the agent may have produced
 * draft reports on prior iterations within the same stdout when
 * sandcastle replays earlier output). Matches a fence that opens on
 * its own line with optional leading whitespace, ` ``` ` then the tag,
 * and closes on its own line with ` ``` `. The body between is
 * returned verbatim (trimmed of leading/trailing newlines so JSON
 * parsing isn't fragile).
 */
function extractFencedBlock(
  text: string,
  fenceTag: string,
): string | undefined {
  const re = new RegExp(
    `^[ \\t]*\`\`\`${escapeRegExp(fenceTag)}[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n[ \\t]*\`\`\`[ \\t]*$`,
    "gm",
  );
  let match: RegExpExecArray | null;
  let last: string | undefined;
  while ((match = re.exec(text)) !== null) {
    last = match[1];
  }
  return last;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseMajor(version: string): number {
  // Permissive: take the leading run of digits before the first `.`.
  // A version string we can't interpret falls back to NaN, which
  // never compares equal to `expectedMajor` — the caller surfaces
  // that as a version-mismatch error.
  const match = /^(\d+)/.exec(version);
  return match ? Number(match[1]) : Number.NaN;
}

function summariseZodIssues(issues: readonly z.core.$ZodIssue[]): string {
  // Keep the message compact so it fits as a span attribute without
  // ballooning the trace payload. Path + code per issue is enough to
  // diagnose; the full payload is in `raw_spans` anyway.
  return issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.length === 0 ? "<root>" : issue.path.join(".");
      return `${path}: ${issue.code}`;
    })
    .join("; ");
}
