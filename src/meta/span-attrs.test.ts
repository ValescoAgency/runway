import { describe, expect, it } from "vitest";
import {
  codingAgentReportSpanAttrs,
  reviewerReportSpanAttrs,
} from "./span-attrs.js";
import {
  CODING_AGENT_REPORT_VERSION,
  REVIEWER_REPORT_VERSION,
  type CodingAgentReport,
  type ReportParseResult,
  type ReviewerReport,
} from "./templates.js";

// VA-401: the span-attribute projection is the integration seam
// between (a) the parsers in templates.ts and (b) the dashboard's
// event store. The dashboard projector reads these attribute keys
// directly; a rename here is a wire-protocol break. The tests pin:
//
//   - successful parse → `runway.<role>.report.*` typed counts +
//     `.payload` JSON string
//   - parse failure → `.error.kind` + `.error.message` + the typed
//     payload is ABSENT (so consumers can use absence-of-payload as
//     the "shape drift" signal)
//   - reviewer divergence-count derives from per-AC agent_claim vs
//     my_verdict comparison

const validAgentReport: CodingAgentReport = {
  template_version: CODING_AGENT_REPORT_VERSION,
  issue_identifier: "VA-401",
  approach: "Wired the report into span attrs.",
  files_modified: ["src/meta/span-attrs.ts", "src/implement.ts"],
  tests_added_or_modified: ["src/meta/span-attrs.test.ts"],
  per_ac_self_check: [
    {
      ac: "ac one",
      verdict: "PASS",
      justification: "covered",
    },
    {
      ac: "ac two",
      verdict: "FAIL",
      justification: "missing",
    },
    {
      ac: "ac three",
      verdict: "NOT_ATTEMPTED",
      justification: "out of scope",
    },
  ],
  risks_unknowns: ["one risk", "another risk"],
  verdict: "DONE",
  verdict_reason: "all green",
};

const okAgent: ReportParseResult<CodingAgentReport> = {
  ok: true,
  report: validAgentReport,
};

const validReviewerReport: ReviewerReport = {
  template_version: REVIEWER_REPORT_VERSION,
  issue_identifier: "VA-401",
  per_ac_validation: [
    {
      ac: "ac one",
      agent_claim: "PASS",
      my_verdict: "PASS",
      justification: "verified",
    },
    {
      ac: "ac two",
      agent_claim: "PASS",
      my_verdict: "FAIL",
      justification: "agent over-claimed",
    },
    {
      ac: "ac three",
      agent_claim: "NOT_ATTEMPTED",
      my_verdict: "FAIL",
      justification: "should have been attempted",
    },
  ],
  code_quality_concerns: ["nit"],
  test_adequacy_concerns: [],
  // PRD verdict alphabet: APPROVE / REJECT / HITL.
  verdict: "REJECT",
  verdict_reason: "two ACs failed",
  guidance_to_coding_agent: "address ac two and ac three",
};

const okReviewer: ReportParseResult<ReviewerReport> = {
  ok: true,
  report: validReviewerReport,
};

describe("codingAgentReportSpanAttrs (VA-401)", () => {
  it("projects a parsed report into typed counts + payload", () => {
    const attrs = codingAgentReportSpanAttrs(okAgent);
    expect(attrs["runway.impl.report.template_version"]).toBe(
      CODING_AGENT_REPORT_VERSION,
    );
    expect(attrs["runway.impl.report.verdict"]).toBe("DONE");
    expect(attrs["runway.impl.report.files_modified_count"]).toBe(2);
    expect(attrs["runway.impl.report.tests_changed_count"]).toBe(1);
    expect(attrs["runway.impl.report.ac_count"]).toBe(3);
    expect(attrs["runway.impl.report.ac_pass_count"]).toBe(1);
    expect(attrs["runway.impl.report.ac_fail_count"]).toBe(1);
    expect(attrs["runway.impl.report.risks_count"]).toBe(2);
    // Payload round-trip — IRA + dashboard consume this.
    const payload = JSON.parse(String(attrs["runway.impl.report.payload"]));
    expect(payload).toEqual(validAgentReport);
  });

  it("projects a parse error into a typed error tag (no payload)", () => {
    const attrs = codingAgentReportSpanAttrs({
      ok: false,
      error: {
        kind: "version-mismatch",
        expectedMajor: 1,
        observed: "2.0.0",
        message: "expected 1.x.x, observed 2.0.0",
      },
    });
    expect(attrs["runway.impl.report.error.kind"]).toBe("version-mismatch");
    expect(attrs["runway.impl.report.error.message"]).toContain("2.0.0");
    expect(attrs["runway.impl.report.expected_version"]).toBe(
      CODING_AGENT_REPORT_VERSION,
    );
    // Absence-of-payload is the dashboard's signal that the report
    // is unavailable for this row. Lock it in.
    expect(attrs["runway.impl.report.payload"]).toBeUndefined();
    expect(attrs["runway.impl.report.verdict"]).toBeUndefined();
  });

  it("projects a missing-block error distinctly from a version mismatch", () => {
    const attrs = codingAgentReportSpanAttrs({
      ok: false,
      error: {
        kind: "missing-block",
        message: "no runway-agent-report block found",
      },
    });
    expect(attrs["runway.impl.report.error.kind"]).toBe("missing-block");
    expect(attrs["runway.impl.report.payload"]).toBeUndefined();
  });

  it("projects orchestrator-stamped telemetry into typed attrs when present", () => {
    // Telemetry is the IRA's first-class signal for "did this run cost
    // the right amount of wall-time / model spend?" — lifted out of
    // the JSON payload so SQL queries don't need json_extract on every
    // row.
    const augmented: ReportParseResult<CodingAgentReport> = {
      ok: true,
      report: {
        ...validAgentReport,
        telemetry: {
          model: "claude-opus-4-7",
          tool_call_count: 17,
          wall_time_ms: 62000,
        },
      },
    };
    const attrs = codingAgentReportSpanAttrs(augmented);
    expect(attrs["runway.impl.report.telemetry.model"]).toBe(
      "claude-opus-4-7",
    );
    expect(attrs["runway.impl.report.telemetry.tool_call_count"]).toBe(17);
    expect(attrs["runway.impl.report.telemetry.wall_time_ms"]).toBe(62000);
  });

  it("omits telemetry attrs when the report has no telemetry block (pre-augment)", () => {
    const attrs = codingAgentReportSpanAttrs(okAgent);
    expect(attrs["runway.impl.report.telemetry.model"]).toBeUndefined();
    expect(attrs["runway.impl.report.telemetry.tool_call_count"]).toBeUndefined();
    expect(attrs["runway.impl.report.telemetry.wall_time_ms"]).toBeUndefined();
  });
});

describe("reviewerReportSpanAttrs (VA-401)", () => {
  it("projects a parsed report and derives the divergence count", () => {
    const attrs = reviewerReportSpanAttrs(okReviewer);
    expect(attrs["runway.review.report.template_version"]).toBe(
      REVIEWER_REPORT_VERSION,
    );
    expect(attrs["runway.review.report.verdict"]).toBe("REJECT");
    expect(attrs["runway.review.report.ac_count"]).toBe(3);
    // Two of the three per-AC entries have agent_claim !== my_verdict.
    // This is the load-bearing signal for "did the reviewer catch
    // what the agent over-claimed?" — the IRA grades on it.
    expect(attrs["runway.review.report.ac_divergence_count"]).toBe(2);
    expect(attrs["runway.review.report.code_concerns_count"]).toBe(1);
    expect(attrs["runway.review.report.test_concerns_count"]).toBe(0);
    const payload = JSON.parse(String(attrs["runway.review.report.payload"]));
    expect(payload).toEqual(validReviewerReport);
  });

  it("projects a parse error into the reviewer-namespaced error tag", () => {
    const attrs = reviewerReportSpanAttrs({
      ok: false,
      error: {
        kind: "schema-mismatch",
        message: "per_ac_validation.0.my_verdict: invalid_enum_value",
      },
    });
    expect(attrs["runway.review.report.error.kind"]).toBe("schema-mismatch");
    expect(attrs["runway.review.report.error.message"]).toContain(
      "invalid_enum_value",
    );
    expect(attrs["runway.review.report.expected_version"]).toBe(
      REVIEWER_REPORT_VERSION,
    );
    expect(attrs["runway.review.report.payload"]).toBeUndefined();
  });
});
