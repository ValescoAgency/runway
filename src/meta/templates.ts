import { Either, ParseResult, Schema } from "effect";

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
 *
 * VA-397: validation library is Effect `Schema` to match the rest of
 * the codebase (`src/linear.ts`). Extra properties on a struct are
 * silently stripped by default — matches the prior zod `strip` mode
 * the forward-compat tests rely on.
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

const PerAcSelfCheckSchema = Schema.Struct({
  ac: Schema.NonEmptyString,
  verdict: Schema.Literal("PASS", "FAIL", "NOT_ATTEMPTED"),
  justification: Schema.String,
});

export type PerAcSelfCheck = typeof PerAcSelfCheckSchema.Type;

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
const CodingAgentTelemetrySchema = Schema.Struct({
  model: Schema.String,
  tool_call_count: Schema.Number.pipe(Schema.greaterThanOrEqualTo(0)),
  wall_time_ms: Schema.Number.pipe(Schema.greaterThanOrEqualTo(0)),
});

export type CodingAgentTelemetry = typeof CodingAgentTelemetrySchema.Type;

const CodingAgentReportSchema = Schema.Struct({
  template_version: Schema.String,
  issue_identifier: Schema.NonEmptyString,
  approach: Schema.String,
  files_modified: Schema.Array(Schema.String),
  tests_added_or_modified: Schema.Array(Schema.String),
  per_ac_self_check: Schema.Array(PerAcSelfCheckSchema),
  risks_unknowns: Schema.Array(Schema.String),
  // PRD verdict alphabet — note that this is the *report* verdict
  // (the agent's view of their work product), distinct from the
  // `IMPL:` marker that drives orchestrator control flow. Mapping:
  //   IMPL: DONE      → DONE     (work is complete)
  //   IMPL: BLOCKED   → BLOCKED  (cannot proceed without human input)
  //   IMPL: CONTINUE  → PARTIAL  (made progress; not complete this iter)
  // The agent emits both — the prompt spells out the mapping so they
  // stay in sync. A divergence between marker and verdict is itself
  // a signal the IRA can grade on.
  verdict: Schema.Literal("DONE", "BLOCKED", "PARTIAL"),
  verdict_reason: Schema.String,
  telemetry: Schema.optional(CodingAgentTelemetrySchema),
});

export type CodingAgentReport = typeof CodingAgentReportSchema.Type;

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

const PerAcValidationSchema = Schema.Struct({
  ac: Schema.NonEmptyString,
  agent_claim: Schema.Literal("PASS", "FAIL", "NOT_ATTEMPTED"),
  my_verdict: Schema.Literal("PASS", "FAIL", "NOT_ATTEMPTED"),
  justification: Schema.String,
});

export type PerAcValidation = typeof PerAcValidationSchema.Type;

const ReviewerReportSchema = Schema.Struct({
  template_version: Schema.String,
  issue_identifier: Schema.NonEmptyString,
  per_ac_validation: Schema.Array(PerAcValidationSchema),
  code_quality_concerns: Schema.Array(Schema.String),
  test_adequacy_concerns: Schema.Array(Schema.String),
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
  verdict: Schema.Literal("APPROVE", "REJECT", "HITL"),
  verdict_reason: Schema.String,
  // Guidance is optional — only required (by convention) on rejection,
  // but a reviewer that wants to leave forward-looking notes on an
  // approved diff is allowed to.
  guidance_to_coding_agent: Schema.optional(Schema.String),
});

export type ReviewerReport = typeof ReviewerReportSchema.Type;

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
 * (BETTER / STEADY / WORSE vs. recent norms), which lives in the
 * top-level `<dim>_quality_relative` fields on `RunReviewSchema`.
 */
const QualityAbsoluteSchema = Schema.Literal(
  "STRONG",
  "ADEQUATE",
  "WEAK",
  "FAILED",
);

const QualityRelativeSchema = Schema.Literal("BETTER", "STEADY", "WORSE");

/**
 * Each quality dimension carries an absolute grade plus a one-sentence
 * justification. The relative axis (BETTER / STEADY / WORSE) lives in
 * the named top-level `<dim>_quality_relative` fields per the VA-405
 * AC — flat field names are easier to surface on the dashboard and
 * group on for the Weekly Review promoter.
 *
 * v1.0.0 / v1.1.0 payloads may include a legacy `relative: null` key
 * inside this object; Effect Schema's default decode mode silently
 * strips unknown properties so forward-compat still works.
 */
const QualitySectionSchema = Schema.Struct({
  absolute: QualityAbsoluteSchema,
  justification: Schema.String,
});

export type QualityAbsolute = typeof QualityAbsoluteSchema.Type;
export type QualityRelative = typeof QualityRelativeSchema.Type;
export type QualitySection = typeof QualitySectionSchema.Type;

/**
 * VA-402: PRD-spec target taxonomy for IRA recommendations. The
 * Weekly Review's promoter (VA-408) groups recommendations by this
 * field as the structural pattern key — bumping the alphabet here
 * needs a coordinated change in the promoter.
 */
const RecommendationTargetSchema = Schema.Literal(
  "prompt",
  "workflow",
  "sandcastle",
  "issue-body",
  "tooling",
);

const RecommendationConfidenceSchema = Schema.Literal("LOW", "MEDIUM", "HIGH");

const RecommendationSchema = Schema.Struct({
  target: RecommendationTargetSchema,
  change: Schema.NonEmptyString,
  confidence: RecommendationConfidenceSchema,
});

export type RecommendationTarget = typeof RecommendationTargetSchema.Type;
export type Recommendation = typeof RecommendationSchema.Type;

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
const HindsightPrSchema = Schema.Struct({
  url: Schema.NonEmptyString,
  state: Schema.Literal("open", "merged", "closed"),
  merged_at: Schema.NullOr(Schema.String),
});

const HindsightHumanVerdictSchema = Schema.Struct({
  // Coarse sentiment over the human review-thread comments. The IRA
  // summarises rather than echoing every comment so the Run Review
  // body stays bounded; the raw comments live in the user prompt.
  sentiment: Schema.Literal("approving", "neutral", "rejecting"),
  comment_count: Schema.Number.pipe(Schema.greaterThanOrEqualTo(0)),
  summary: Schema.String,
});

const HindsightFollowUpIssueSchema = Schema.Struct({
  identifier: Schema.NonEmptyString,
  title: Schema.String,
});

const HindsightSignalsObjectSchema = Schema.Struct({
  pr: Schema.NullOr(HindsightPrSchema),
  human_verdict: Schema.NullOr(HindsightHumanVerdictSchema),
  follow_up_issues: Schema.Array(HindsightFollowUpIssueSchema),
});

const HindsightSignalsSchema = Schema.NullOr(HindsightSignalsObjectSchema);

export type HindsightPr = typeof HindsightPrSchema.Type;
export type HindsightHumanVerdict = typeof HindsightHumanVerdictSchema.Type;
export type HindsightFollowUpIssue = typeof HindsightFollowUpIssueSchema.Type;
export type HindsightSignals = typeof HindsightSignalsObjectSchema.Type;

const RunReviewSchema = Schema.Struct({
  template_version: Schema.String,
  issue_identifier: Schema.NonEmptyString,
  drain_trace_id: Schema.NonEmptyString,
  final_outcome: Schema.NonEmptyString,
  // Five quality dimensions per PRD. The absolute grade lives in
  // each section (STRONG/ADEQUATE/WEAK/FAILED); the relative grade
  // lives in the top-level fields below.
  issue_quality: QualitySectionSchema,
  prompt_quality: QualitySectionSchema,
  agent_quality: QualitySectionSchema,
  reviewer_quality: QualitySectionSchema,
  orchestration_quality: QualitySectionSchema,
  // VA-405 v1.2.0: top-level relative-axis fields per the AC. Each
  // is a `BETTER | STEADY | WORSE` enum, optional so v1.0.0 / v1.1.0
  // payloads (which don't emit them — and may carry a legacy nested
  // `relative` slot Effect Schema strips silently) still parse. The
  // IRA populates these when norms were available and omits them
  // when not (category has < 5 runs in the window, or norms gateway
  // error).
  issue_quality_relative: Schema.optional(QualityRelativeSchema),
  prompt_quality_relative: Schema.optional(QualityRelativeSchema),
  agent_quality_relative: Schema.optional(QualityRelativeSchema),
  reviewer_quality_relative: Schema.optional(QualityRelativeSchema),
  orchestration_quality_relative: Schema.optional(QualityRelativeSchema),
  recommendations: Schema.Array(RecommendationSchema),
  hindsight_signals: HindsightSignalsSchema,
});

export type RunReview = typeof RunReviewSchema.Type;

export function parseRunReview(text: string): ReportParseResult<RunReview> {
  return parseReport(text, {
    fenceTag: RUN_REVIEW_FENCE_TAG,
    schema: RunReviewSchema,
    expectedMajor: parseMajor(RUN_REVIEW_VERSION),
  });
}

// ---------------------------------------------------------------------------
// Drain Review (v1.0.0) — IRA's per-drain retrospective verdict
// ---------------------------------------------------------------------------

export const DRAIN_REVIEW_VERSION = "1.0.0";
export const DRAIN_REVIEW_FENCE_TAG = "runway-drain-review";

/**
 * VA-406: outcome rollup for the drain. Counts mirror the run-review
 * outcome alphabet plus the IRA-specific `meta-failed` / `meta-skipped`
 * kinds so the operator can read drain composition from a single
 * section. Open shape (`Schema.Record`) so a future outcome variant
 * (e.g. "skipped-claim-race" from VA-423) lands without a schema bump.
 */
const DrainOutcomeSummarySchema = Schema.Record({
  key: Schema.String,
  value: Schema.Number,
});

/**
 * VA-406: one notable per-issue event for the drain review body. The
 * IRA picks events that say something interesting about the drain
 * (severe HITL escapes, retried-and-recovered runs, outlier
 * wall-times). `run_review_url` is the cross-link into runway-meta so
 * the operator can drill from the drain summary into the per-issue
 * review without searching.
 */
const NotableEventSchema = Schema.Struct({
  issue_identifier: Schema.NonEmptyString,
  event: Schema.NonEmptyString,
  run_review_url: Schema.NullOr(Schema.String),
});

/**
 * VA-406: severity gate. `critical` triggers the runway-repo
 * escalation path (a Linear issue in the team's runway-repo project
 * with `Bug` + `runway-meta-promoted` labels). `routine` (default)
 * stops at runway-meta. Gate criteria live in the IRA's system
 * prompt: "only mark critical if this finding makes the next drain
 * unsafe or loses captured data."
 */
const SeveritySchema = Schema.Literal("critical", "routine");

const DrainReviewSchema = Schema.Struct({
  template_version: Schema.String,
  drain_trace_id: Schema.NonEmptyString,
  issue_count: Schema.Number.pipe(Schema.greaterThanOrEqualTo(0)),
  outcomes_summary: DrainOutcomeSummarySchema,
  sequencing_assessment: Schema.String,
  cross_issue_patterns: Schema.Array(Schema.String),
  notable_events: Schema.Array(NotableEventSchema),
  recommendations: Schema.Array(RecommendationSchema),
  severity: SeveritySchema,
  // Required when severity === "critical" — gives the operator the
  // line of reasoning behind the escalation. The IRA's prompt
  // instructs the model to write this even for `routine` (one line
  // explaining why it's not critical) so a future audit can read
  // the model's confidence either way.
  severity_justification: Schema.String,
});

export type DrainOutcomeSummary = typeof DrainOutcomeSummarySchema.Type;
export type NotableEvent = typeof NotableEventSchema.Type;
export type Severity = typeof SeveritySchema.Type;
export type DrainReview = typeof DrainReviewSchema.Type;

export function parseDrainReview(text: string): ReportParseResult<DrainReview> {
  return parseReport(text, {
    fenceTag: DRAIN_REVIEW_FENCE_TAG,
    schema: DrainReviewSchema,
    expectedMajor: parseMajor(DRAIN_REVIEW_VERSION),
  });
}

// ---------------------------------------------------------------------------
// Weekly Review (v1.1.0) — IRA's weekly cadence pass (VA-408)
// + attribution loop ("What we shipped" verdicts) (VA-409)
// ---------------------------------------------------------------------------

/**
 * VA-409: v1.1.0 minor bump adds `shipped_promotions` ("What we shipped"
 * verdicts) plus optional `attribution` on `PredictedEffectSchema`. Both
 * are forward-compatible:
 *   - v1.0.0 reviews lacked `shipped_promotions` entirely; the schema
 *     defaults the field to `[]` so legacy payloads still parse.
 *   - v1.0.0 promotions stamped only the free-text claim into runway-repo
 *     issue bodies; reading them back yields `attribution === undefined`,
 *     which the attribution loop maps to a `QUALITATIVE` verdict.
 */
export const WEEKLY_REVIEW_VERSION = "1.1.0";
export const WEEKLY_REVIEW_FENCE_TAG = "runway-weekly-review";

/**
 * VA-408: rates block shared by `WeeklyReviewSchema.rates` and the
 * delta-vs-prior-week shape. Throughput is a count (not a percentage),
 * the rest are 0–100% values. The delta variant carries SIGNED numbers —
 * a `-3.2` in `success_pct` means the success rate dropped 3.2
 * percentage points vs last week. Delta is nullable because the first
 * Weekly Review for a fresh workspace has no prior week to diff against.
 */
const WeeklyRatesSchema = Schema.Struct({
  throughput: Schema.Number.pipe(Schema.greaterThanOrEqualTo(0)),
  success_pct: Schema.Number.pipe(Schema.between(0, 100)),
  hitl_pct: Schema.Number.pipe(Schema.between(0, 100)),
  revert_pct: Schema.Number.pipe(Schema.between(0, 100)),
  infra_error_pct: Schema.Number.pipe(Schema.between(0, 100)),
});

const WeeklyRatesDeltaSchema = Schema.Struct({
  throughput: Schema.Number,
  success_pct: Schema.Number,
  hitl_pct: Schema.Number,
  revert_pct: Schema.Number,
  infra_error_pct: Schema.Number,
});

/**
 * VA-408: PRD-spec promotion category. Mirrors the Linear label set the
 * runway-repo project uses to triage new issues.
 */
const PromotionCategorySchema = Schema.Literal("Bug", "Feature", "Improvement");

/**
 * VA-409: machine-readable metrics the attribution loop can grade
 * against. Names mirror VA-399's `evaluator_aggregates_v1` columns
 * (snake_case) so the IRA's stamped attribution and the dashboard
 * read-model reference the same fields by name — see
 * `src/dashboard/read-model.md`. The enum is closed so the IRA can't
 * smuggle in a metric name we can't actually read post-ship.
 */
const AttributionMetricSchema = Schema.Literal(
  "median_iteration_count",
  "p95_iteration_count",
  "median_wall_time_ms",
  "p95_wall_time_ms",
  "reviewer_rejection_rate",
  "revert_rate",
  "hitl_escape_rate",
  "infra_error_rate",
);

/**
 * VA-409: structured attribution block on a promotion's predicted
 * effect. Optional at the schema layer because some predictions are
 * qualitative (no measurable post-ship metric) — those fall through to
 * the `QUALITATIVE` verdict per the AC.
 *
 * Semantics of the four fields, all required when `attribution` is
 * present so the verdict logic doesn't have to defend against partial
 * shapes:
 *   - `metric` — which `evaluator_aggregates_v1` column to read
 *     post-ship.
 *   - `baseline_value` — the IRA's recorded pre-ship value (sourced
 *     from VA-405's rolling norms at the time the promotion was
 *     written). Carried for transparency + for the PARTIAL bucket: if
 *     the metric moved past `baseline_value` toward `threshold_value`
 *     but didn't reach the threshold, the verdict is PARTIAL.
 *   - `direction` — which way the IRA predicts the metric should move
 *     to count as improvement. Drives the verdict comparison
 *     (`decrease` → HELD when `observed <= threshold_value`;
 *     `increase` → HELD when `observed >= threshold_value`).
 *   - `threshold_value` — the post-ship value the IRA predicts the
 *     metric must reach to count the claim as held. The "load-bearing
 *     falsifiability" number.
 */
const PredictedEffectAttributionSchema = Schema.Struct({
  metric: AttributionMetricSchema,
  baseline_value: Schema.Number,
  direction: Schema.Literal("decrease", "increase"),
  threshold_value: Schema.Number,
});

/**
 * VA-408: predicted-effect block per promotion. Falsifiability is the
 * load-bearing contract — every promotion declares the claim it makes
 * and the minimum sample of post-ship runs needed to validate it.
 * VA-409: the optional `attribution` block lets the IRA name a
 * specific VA-399 metric + direction + threshold so the next Weekly
 * Review's attribution loop can grade HELD / PARTIAL / MISSED
 * mechanically. When `attribution` is absent the verdict falls through
 * to `QUALITATIVE` and an operator reads the post-ship evidence
 * narrative themselves.
 */
const PredictedEffectSchema = Schema.Struct({
  claim: Schema.NonEmptyString,
  min_sample_size: Schema.Int.pipe(Schema.greaterThan(0)),
  // Free-text description of the sample — e.g. "post-ship runs of
  // refactor-class issues". The attribution loop reads this to know
  // which runs count toward the n=X threshold.
  sample_description: Schema.NonEmptyString,
  // VA-409: optional structured attribution block. Present → numeric
  // verdict path. Absent → QUALITATIVE.
  attribution: Schema.optional(PredictedEffectAttributionSchema),
});

/**
 * VA-408: machine-readable marker the promoter stamps into every
 * promoted runway-repo issue body. The next Weekly Review's queue-
 * defer logic reads it back to match new themes against open
 * promotions without re-running the LLM.
 */
export const RUNWAY_META_THEME_KEY_MARKER = "runway-meta-theme-key";

/**
 * VA-409: machine-readable marker carrying the full `predicted_effect`
 * JSON blob. Stamped into every promoted runway-repo issue body
 * alongside the theme-key marker so the next Weekly Review's
 * attribution loop can read the prediction back without trying to
 * parse the human-readable markdown body. Falls back to a markdown
 * regex parse for legacy issues that predate the marker (see
 * `parsePredictedEffectFromBody` in `src/meta/attribution.ts`).
 */
export const RUNWAY_META_PREDICTED_EFFECT_MARKER =
  "runway-meta-predicted-effect";

const PromotionSchema = Schema.Struct({
  // The promoter's stable theme key, echoed back in the parsed payload.
  // Stamped into the runway-repo issue body so the next Weekly Review
  // can match against the open promoted queue.
  theme_key: Schema.NonEmptyString,
  target: RecommendationTargetSchema,
  category: PromotionCategorySchema,
  // Short title for the runway-repo issue (the LLM's job — turning a
  // recommendation into a shippable phrasing).
  title: Schema.NonEmptyString,
  // Multi-line change spec for the issue body. Markdown.
  change_spec: Schema.NonEmptyString,
  // Acceptance criteria as a list of bullet strings. The runway-repo
  // issue body renders these as a markdown checklist.
  acceptance_criteria: Schema.Array(Schema.NonEmptyString).pipe(
    Schema.minItems(1),
  ),
  // VA-NNN identifiers of the Run / Drain Reviews that corroborated
  // this theme. The promoter computed this; the LLM echoes it back.
  source_meta_review_identifiers: Schema.Array(Schema.NonEmptyString),
  predicted_effect: PredictedEffectSchema,
  corroboration_count: Schema.Int.pipe(Schema.greaterThanOrEqualTo(2)),
  recommendation_confidence: RecommendationConfidenceSchema,
});

/**
 * VA-408: one entry in the *Noted but not promoted* overflow block.
 * `reason` discriminates between the cases — operators triaging the
 * Weekly Review want to know which themes are pending vs which lost
 * the ranking vs which match a prior rejection.
 */
const NotedThemeReasonSchema = Schema.Literal(
  "budget-cap",
  "deferred-open-promotion",
  "out-of-scope",
  "low-confidence",
);

const NotedThemeSchema = Schema.Struct({
  theme_key: Schema.NonEmptyString,
  target: RecommendationTargetSchema,
  description: Schema.NonEmptyString,
  corroboration_count: Schema.Int.pipe(Schema.greaterThanOrEqualTo(1)),
  reason: NotedThemeReasonSchema,
  // Populated when `reason === "deferred-open-promotion"` — the
  // identifier of the open promoted issue the new theme is deferring
  // behind. Null otherwise.
  deferred_behind: Schema.NullOr(Schema.String),
});

/**
 * VA-408: one recurring-theme observation the IRA surfaces in prose.
 * Lighter shape than `PromotionSchema` — themes that didn't reach the
 * corroboration threshold (>= 2 Run Reviews) still get a one-liner so
 * the operator can spot pre-emergent patterns before they harden.
 */
const RecurringThemeSchema = Schema.Struct({
  target: RecommendationTargetSchema,
  description: Schema.NonEmptyString,
  corroboration_count: Schema.Int.pipe(Schema.greaterThanOrEqualTo(1)),
});

/**
 * VA-409: the alphabet of verdicts the attribution loop emits per
 * shipped promotion. The first four are the AC-named numeric branches;
 * `QUALITATIVE` is the catch-all for predictions without a structured
 * attribution block (legacy v1.0.0 promotions, or current v1.1.0
 * promotions where the IRA couldn't name a measurable metric).
 *
 * Verdict semantics, with `observed` the post-ship aggregate value and
 * `attribution.threshold_value` the prediction:
 *   - `HELD` — observed met or exceeded the threshold in the predicted
 *     direction.
 *   - `PARTIAL` — observed moved past `baseline_value` toward
 *     `threshold_value` but didn't reach it.
 *   - `MISSED` — observed didn't move, or moved in the wrong direction.
 *   - `PENDING` — fewer post-ship runs than the prediction's declared
 *     `min_sample_size`; verdict is "not enough data yet" and the next
 *     Weekly Review re-grades.
 *   - `QUALITATIVE` — no attribution block to grade against; the IRA
 *     quotes the observable post-ship evidence and an operator decides.
 */
const VerdictSchema = Schema.Literal(
  "HELD",
  "PARTIAL",
  "MISSED",
  "PENDING",
  "QUALITATIVE",
);

/**
 * VA-409: post-ship observation alongside a shipped promotion. The
 * mechanical attribution loop fills `value` + `sample_size` from
 * VA-399's read-model filtered to runs after the promotion shipped.
 * `metric` echoes the predicted-effect attribution metric (or `null`
 * when the verdict is `QUALITATIVE`) so a reader of the *What we
 * shipped* section sees what was measured.
 */
const ObservedMetricSchema = Schema.Struct({
  metric: Schema.NullOr(AttributionMetricSchema),
  value: Schema.NullOr(Schema.Number),
  sample_size: Schema.Int.pipe(Schema.greaterThanOrEqualTo(0)),
});

/**
 * VA-409: one shipped promotion row in the *What we shipped* section.
 * Echoed from the predicted-effect block stamped on the runway-repo
 * issue body when the promotion was filed; cross-linked back to the
 * issue identifier + url so the operator can navigate to source.
 *
 * The LLM authors `comment` (one sentence — the IRA's qualitative
 * read on the verdict). Everything else is mechanical: the attribution
 * loop reads the predicted effect off the issue body, queries the
 * post-ship metric, computes the verdict, and hands the LLM the
 * structured row to write narrative around.
 */
const ShippedPromotionSchema = Schema.Struct({
  theme_key: Schema.NonEmptyString,
  linear_identifier: Schema.NonEmptyString,
  linear_url: Schema.NonEmptyString,
  linear_title: Schema.NonEmptyString,
  source_meta_review_identifiers: Schema.Array(Schema.NonEmptyString),
  predicted_effect: PredictedEffectSchema,
  observed: ObservedMetricSchema,
  verdict: VerdictSchema,
  comment: Schema.String,
});

const WeeklyReviewSchema = Schema.Struct({
  template_version: Schema.String,
  // ISO8601 boundaries of the week. The cron-driven cadence sets the
  // window; ad-hoc `runway review weekly` invocations may pick custom
  // windows for backfill / replay.
  time_window: Schema.Struct({
    start_iso: Schema.NonEmptyString,
    end_iso: Schema.NonEmptyString,
  }),
  // Aggregates: throughput, success / HITL / revert / infra-error
  // rates. The LLM computes these off the raw Reviews surface — the
  // model has qualitative grounding for "what counts as a HITL escape"
  // that a mechanical denominator could miss.
  rates: WeeklyRatesSchema,
  // Delta vs prior week. Null on the first weekly review for a fresh
  // workspace (no prior week to diff against).
  rates_delta_vs_prior_week: Schema.NullOr(WeeklyRatesDeltaSchema),
  // Free-form prose summarizing the week. The operator reads this on
  // a Sunday evening — readability matters more than rigid structure.
  narrative: Schema.String,
  recurring_themes: Schema.Array(RecurringThemeSchema),
  // Top-5 promotions per the PRD's hard cap. Enforced at the schema
  // level so a malformed LLM response can't slip 6+ promotions past.
  promotions: Schema.Array(PromotionSchema).pipe(Schema.maxItems(5)),
  noted_but_not_promoted: Schema.Array(NotedThemeSchema),
  // VA-409: *What we shipped* section. Each row is one promotion that
  // moved to Done since the prior Weekly Review, with the mechanical
  // verdict the attribution loop graded. Defaults to `[]` so v1.0.0
  // payloads (which omit the field entirely) still parse under v1.1.0.
  shipped_promotions: Schema.optionalWith(
    Schema.Array(ShippedPromotionSchema),
    { default: () => [] },
  ),
});

export type WeeklyRates = typeof WeeklyRatesSchema.Type;
export type WeeklyRatesDelta = typeof WeeklyRatesDeltaSchema.Type;
export type PromotionCategory = typeof PromotionCategorySchema.Type;
export type AttributionMetric = typeof AttributionMetricSchema.Type;
export type PredictedEffectAttribution =
  typeof PredictedEffectAttributionSchema.Type;
export type PredictedEffect = typeof PredictedEffectSchema.Type;
export type Promotion = typeof PromotionSchema.Type;
export type NotedThemeReason = typeof NotedThemeReasonSchema.Type;
export type NotedTheme = typeof NotedThemeSchema.Type;
export type RecurringTheme = typeof RecurringThemeSchema.Type;
export type Verdict = typeof VerdictSchema.Type;
export type ObservedMetric = typeof ObservedMetricSchema.Type;
export type ShippedPromotion = typeof ShippedPromotionSchema.Type;
export type WeeklyReview = typeof WeeklyReviewSchema.Type;

export function parseWeeklyReview(
  text: string,
): ReportParseResult<WeeklyReview> {
  return parseReport(text, {
    fenceTag: WEEKLY_REVIEW_FENCE_TAG,
    schema: WeeklyReviewSchema,
    expectedMajor: parseMajor(WEEKLY_REVIEW_VERSION),
  });
}

// ---------------------------------------------------------------------------
// Generic parser — fence extraction → JSON parse → version handshake
// → schema validation
// ---------------------------------------------------------------------------

interface ParseSpec<A, I> {
  readonly fenceTag: string;
  // Two generics so each call site can keep its natural `A` (decoded
  // type) and `I` (encoded type) — Effect Schema is invariant in both,
  // so a single-generic `Schema.Schema<T>` would force every schema to
  // its decoded form for both slots. We start from `unknown` via
  // `decodeUnknownEither` anyway, so the `I` shape isn't load-bearing
  // here — but we need to let it vary so the schemas with a non-trivial
  // encoded shape (e.g. `optionalWith({ default })`) type-check.
  readonly schema: Schema.Schema<A, I, never>;
  readonly expectedMajor: number;
}

function parseReport<A, I>(
  text: string,
  spec: ParseSpec<A, I>,
): ReportParseResult<A> {
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
  // payload doesn't get rejected for unrelated reasons.
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

  const result = Schema.decodeUnknownEither(spec.schema)(parsed);
  if (Either.isLeft(result)) {
    return err({
      kind: "schema-mismatch",
      message: `${spec.fenceTag}: ${summariseSchemaError(result.left)}`,
    });
  }
  return ok(result.right);
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

function summariseSchemaError(error: ParseResult.ParseError): string {
  // Project Effect's tree-shaped ParseError into a compact line so the
  // payload fits a span attribute without ballooning the trace. Path +
  // issue tag per leaf, truncated to the first 5 — same shape the prior
  // zod summariser produced, with `_tag` standing in for zod's `code`.
  const issues = ParseResult.ArrayFormatter.formatErrorSync(error);
  return issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.length === 0 ? "<root>" : issue.path.join(".");
      return `${path}: ${issue._tag}`;
    })
    .join("; ");
}
