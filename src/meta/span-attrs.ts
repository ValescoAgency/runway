import {
  CODING_AGENT_REPORT_VERSION,
  REVIEWER_REPORT_VERSION,
  type CodingAgentReport,
  type ReportParseResult,
  type ReviewerReport,
} from "./templates.js";

/**
 * VA-401: project parsed reports into OTel span attribute shapes.
 *
 * Live in `meta/` because they're a single source of truth for how
 * each report's fields land on the dashboard's event store — the
 * dashboard projector reads these attribute keys to populate typed
 * columns + render the IRA-facing copy. Keeping the projection
 * separate from the modules that *parse* (templates.ts) and *emit*
 * the spans (implement.ts / review.ts) means a future schema change
 * touches one file, not three.
 *
 * Two contracts per projection:
 *
 *   - **Success** lands as `runway.<role>.report.*` attributes plus a
 *     `.payload` JSON string for the IRA to reason on the full body.
 *     Typed counts (ac_count, ac_pass_count, …) are lifted out for
 *     read-model queries that don't want to JSON-parse on every row.
 *   - **Parse failure** lands as `runway.<role>.report.error.kind`
 *     and `.message`, with `expected_version` for diagnostics. The
 *     absence of the typed payload tells the dashboard / IRA that
 *     this row's report is unavailable — the "shape drift" failure
 *     mode is visible, not silent.
 */

/** Span-attribute names allowed by Effect's `annotateCurrentSpan`. */
export type SpanAttrs = Record<string, string | number | boolean>;

export function codingAgentReportSpanAttrs(
  result: ReportParseResult<CodingAgentReport>,
): SpanAttrs {
  if (!result.ok) {
    return {
      "runway.impl.report.error.kind": result.error.kind,
      "runway.impl.report.error.message": result.error.message,
      "runway.impl.report.expected_version": CODING_AGENT_REPORT_VERSION,
    };
  }
  const report = result.report;
  return {
    "runway.impl.report.template_version": report.template_version,
    "runway.impl.report.verdict": report.verdict,
    "runway.impl.report.verdict_reason": report.verdict_reason,
    "runway.impl.report.files_modified_count": report.files_modified.length,
    "runway.impl.report.tests_changed_count":
      report.tests_added_or_modified.length,
    "runway.impl.report.ac_count": report.per_ac_self_check.length,
    "runway.impl.report.ac_pass_count": report.per_ac_self_check.filter(
      (a) => a.verdict === "PASS",
    ).length,
    "runway.impl.report.ac_fail_count": report.per_ac_self_check.filter(
      (a) => a.verdict === "FAIL",
    ).length,
    "runway.impl.report.risks_count": report.risks_unknowns.length,
    // Full payload so the IRA can reason on the original fields —
    // serialised because OTLP span attrs are flat primitives, not
    // nested structures. The dashboard's `raw_spans` table carries
    // it through JSON-as-string without ever inspecting the body.
    "runway.impl.report.payload": JSON.stringify(report),
  };
}

export function reviewerReportSpanAttrs(
  result: ReportParseResult<ReviewerReport>,
): SpanAttrs {
  if (!result.ok) {
    return {
      "runway.review.report.error.kind": result.error.kind,
      "runway.review.report.error.message": result.error.message,
      "runway.review.report.expected_version": REVIEWER_REPORT_VERSION,
    };
  }
  const report = result.report;
  // Count of ACs where reviewer disagreed with agent — the load-
  // bearing signal for reviewer quality. A reviewer that always
  // agrees with the agent isn't doing their job; one that disagrees
  // on something the agent over-claimed is the proof of work.
  const divergences = report.per_ac_validation.filter(
    (v) => v.agent_claim !== v.my_verdict,
  ).length;
  return {
    "runway.review.report.template_version": report.template_version,
    "runway.review.report.verdict": report.verdict,
    "runway.review.report.verdict_reason": report.verdict_reason,
    "runway.review.report.ac_count": report.per_ac_validation.length,
    "runway.review.report.ac_divergence_count": divergences,
    "runway.review.report.code_concerns_count":
      report.code_quality_concerns.length,
    "runway.review.report.test_concerns_count":
      report.test_adequacy_concerns.length,
    "runway.review.report.payload": JSON.stringify(report),
  };
}
