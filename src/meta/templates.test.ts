import { describe, expect, it } from "vitest";
import {
  CODING_AGENT_REPORT_FENCE_TAG,
  CODING_AGENT_REPORT_VERSION,
  REVIEWER_REPORT_FENCE_TAG,
  REVIEWER_REPORT_VERSION,
  RUN_REVIEW_FENCE_TAG,
  RUN_REVIEW_VERSION,
  parseCodingAgentReport,
  parseReviewerReport,
  parseRunReview,
} from "./templates.js";

// VA-401 / VA-400: schema + version handshake tests for the two
// structured agent reports introduced in slice 1. The contract these
// tests pin:
//
//   - happy-path: a well-formed `runway-agent-report` / `runway-
//     reviewer-report` fenced block parses cleanly under the current
//     major version
//   - missing block: a typed `missing-block` error, never a silent
//     "use defaults" path
//   - major mismatch: a typed `version-mismatch` error — this is the
//     "silent shape drift" failure mode the PRD calls out
//   - schema mismatch: typed `schema-mismatch` with a compact summary
//   - malformed JSON inside the fence: typed `malformed-json`
//
// `version-mismatch` is checked BEFORE the schema gate, so a v2 payload
// doesn't surface as a generic schema failure. Tests that exercise
// the boundary verify that ordering.

const wrapAgent = (json: string): string =>
  ["```" + CODING_AGENT_REPORT_FENCE_TAG, json, "```"].join("\n");

const wrapReviewer = (json: string): string =>
  ["```" + REVIEWER_REPORT_FENCE_TAG, json, "```"].join("\n");

const wrapRunReview = (json: string): string =>
  ["```" + RUN_REVIEW_FENCE_TAG, json, "```"].join("\n");

const VALID_AGENT_REPORT = {
  template_version: CODING_AGENT_REPORT_VERSION,
  issue_identifier: "VA-401",
  approach: "Stamped the report templates into prompts and added a parser.",
  files_modified: ["src/meta/templates.ts", "prompts/implement.md"],
  tests_added_or_modified: ["src/meta/templates.test.ts"],
  per_ac_self_check: [
    {
      ac: "Coding Agent Report v1.0.0 stamped into prompts.ts",
      verdict: "PASS",
      justification: "Block added to prompts/implement.md.",
    },
  ],
  risks_unknowns: ["None observed."],
  // PRD verdict alphabet: DONE / BLOCKED / PARTIAL.
  verdict: "DONE",
  verdict_reason: "All ACs pass on this iteration.",
};

const VALID_REVIEWER_REPORT = {
  template_version: REVIEWER_REPORT_VERSION,
  issue_identifier: "VA-401",
  per_ac_validation: [
    {
      ac: "parser fails loudly on version mismatch",
      agent_claim: "PASS",
      my_verdict: "PASS",
      justification: "Major-bump test covers this.",
    },
  ],
  code_quality_concerns: [],
  test_adequacy_concerns: [],
  // PRD verdict alphabet: APPROVE / REJECT / HITL.
  verdict: "APPROVE",
  verdict_reason: "Schema gates are correct.",
};

describe("parseCodingAgentReport (VA-401)", () => {
  it("parses a well-formed report at the current version", () => {
    const stdout = [
      "Some preamble from the agent.",
      wrapAgent(JSON.stringify(VALID_AGENT_REPORT)),
      "",
      "IMPL: DONE",
    ].join("\n");
    const result = parseCodingAgentReport(stdout);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.issue_identifier).toBe("VA-401");
    expect(result.report.verdict).toBe("DONE");
    expect(result.report.files_modified).toEqual([
      "src/meta/templates.ts",
      "prompts/implement.md",
    ]);
  });

  it("returns missing-block when the fenced block is absent", () => {
    const result = parseCodingAgentReport("no report here\nIMPL: DONE");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("missing-block");
  });

  it("returns version-mismatch on a major bump (silent drift guard)", () => {
    const stdout = wrapAgent(
      JSON.stringify({ ...VALID_AGENT_REPORT, template_version: "2.0.0" }),
    );
    const result = parseCodingAgentReport(stdout);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("version-mismatch");
    if (result.error.kind !== "version-mismatch") return;
    expect(result.error.observed).toBe("2.0.0");
    expect(result.error.expectedMajor).toBe(1);
  });

  it("accepts a forward-compatible minor version inside the current major", () => {
    // v1.1.0 is wider than v1.0.0 but still v1.x — the schema must
    // tolerate it. The PRD's "minor-newer forward-compatible" contract.
    const stdout = wrapAgent(
      JSON.stringify({ ...VALID_AGENT_REPORT, template_version: "1.1.0" }),
    );
    const result = parseCodingAgentReport(stdout);
    expect(result.ok).toBe(true);
  });

  it("returns malformed-json when the fence body is not valid JSON", () => {
    const stdout = wrapAgent("{ not: valid, json }");
    const result = parseCodingAgentReport(stdout);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("malformed-json");
  });

  it("returns schema-mismatch when a required field is missing", () => {
    const incomplete = { ...VALID_AGENT_REPORT };
    delete (incomplete as Record<string, unknown>).issue_identifier;
    const stdout = wrapAgent(JSON.stringify(incomplete));
    const result = parseCodingAgentReport(stdout);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("schema-mismatch");
    if (result.error.kind !== "schema-mismatch") return;
    expect(result.error.message).toContain("issue_identifier");
  });

  it("takes the LAST fenced block when multiple appear", () => {
    // Sandcastle can replay earlier iteration output; if the agent
    // emitted a partial report on iter 1 and a complete one on iter 2,
    // the latter must win — same last-marker-wins rule as the verdict
    // parser.
    const draft = wrapAgent(
      JSON.stringify({
        ...VALID_AGENT_REPORT,
        approach: "DRAFT iteration 1",
        verdict: "PARTIAL",
      }),
    );
    const finalReport = wrapAgent(
      JSON.stringify({
        ...VALID_AGENT_REPORT,
        approach: "FINAL iteration 2",
        verdict: "DONE",
      }),
    );
    const stdout = [draft, "intervening prose", finalReport].join("\n");
    const result = parseCodingAgentReport(stdout);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.approach).toBe("FINAL iteration 2");
    expect(result.report.verdict).toBe("DONE");
  });

  it("accepts PARTIAL as the PRD-spec verdict (not the legacy CONTINUE marker name)", () => {
    // PRD VA-400 explicitly defines the report verdict alphabet as
    // DONE / BLOCKED / PARTIAL. CONTINUE is the orchestrator-control
    // marker name; the report verdict is the work-quality signal the
    // IRA grades on. They must NOT collapse — the marker / verdict
    // mapping lives in the prompt, not the schema.
    const stdout = wrapAgent(
      JSON.stringify({ ...VALID_AGENT_REPORT, verdict: "PARTIAL" }),
    );
    const result = parseCodingAgentReport(stdout);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.verdict).toBe("PARTIAL");
  });

  it("rejects the legacy CONTINUE marker name in the report verdict", () => {
    // Loud failure on the wrong vocabulary — if the agent emits the
    // marker name instead of the PRD verdict name, the IRA would
    // mis-grade the run. Better to surface the contract violation
    // than silently accept.
    const stdout = wrapAgent(
      JSON.stringify({ ...VALID_AGENT_REPORT, verdict: "CONTINUE" }),
    );
    const result = parseCodingAgentReport(stdout);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("schema-mismatch");
  });

  it("accepts an optional orchestrator-stamped telemetry block", () => {
    // Telemetry is auto-populated by the orchestrator after the
    // agent emits the report — the schema makes it optional so the
    // agent's wire output doesn't need to fabricate values it can't
    // know (wall-time, model name, tool-call count).
    const stdout = wrapAgent(
      JSON.stringify({
        ...VALID_AGENT_REPORT,
        telemetry: {
          model: "claude-opus-4-7",
          tool_call_count: 12,
          wall_time_ms: 45000,
        },
      }),
    );
    const result = parseCodingAgentReport(stdout);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.telemetry?.model).toBe("claude-opus-4-7");
    expect(result.report.telemetry?.tool_call_count).toBe(12);
    expect(result.report.telemetry?.wall_time_ms).toBe(45000);
  });

  it("parses without telemetry when the agent emits the report unaugmented", () => {
    // Default flow: the agent emits no telemetry, the orchestrator
    // augments after parsing. The schema must accept the bare form.
    const result = parseCodingAgentReport(
      wrapAgent(JSON.stringify(VALID_AGENT_REPORT)),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.telemetry).toBeUndefined();
  });
});

describe("parseReviewerReport (VA-401)", () => {
  it("parses a well-formed reviewer report at the current version", () => {
    const stdout = [
      "I reviewed the diff.",
      wrapReviewer(JSON.stringify(VALID_REVIEWER_REPORT)),
      "",
      "REVIEW: APPROVED",
    ].join("\n");
    const result = parseReviewerReport(stdout);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.verdict).toBe("APPROVE");
    expect(result.report.per_ac_validation).toHaveLength(1);
  });

  it("rejects the legacy REVIEW: marker name in the report verdict", () => {
    // PRD verdict alphabet is APPROVE / REJECT / HITL. APPROVED (the
    // marker name) must NOT parse — the IRA grades on the report
    // verdict and would mis-classify if the schema silently coerced.
    const stdout = wrapReviewer(
      JSON.stringify({ ...VALID_REVIEWER_REPORT, verdict: "APPROVED" }),
    );
    const result = parseReviewerReport(stdout);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("schema-mismatch");
  });

  it("accepts REJECT and HITL as PRD-spec verdicts", () => {
    for (const verdict of ["REJECT", "HITL"] as const) {
      const stdout = wrapReviewer(
        JSON.stringify({
          ...VALID_REVIEWER_REPORT,
          verdict,
          guidance_to_coding_agent: "fix the thing",
        }),
      );
      const result = parseReviewerReport(stdout);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.report.verdict).toBe(verdict);
    }
  });

  it("returns missing-block when the fenced block is absent", () => {
    const result = parseReviewerReport("REVIEW: APPROVED");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("missing-block");
  });

  it("rejects a major-bump payload before schema validation runs", () => {
    // A v2 payload may have a different shape but version handshake
    // fires first — the caller sees `version-mismatch`, not a noisy
    // `schema-mismatch` with a path that's irrelevant to the actual
    // problem.
    const stdout = wrapReviewer(
      JSON.stringify({
        template_version: "2.0.0",
        // Deliberately omit the v1.0.0 required fields so a schema
        // gate would fire if version handshake didn't pre-empt it.
      }),
    );
    const result = parseReviewerReport(stdout);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("version-mismatch");
  });

  it("accepts a forward-compatible minor version inside the current major", () => {
    const stdout = wrapReviewer(
      JSON.stringify({
        ...VALID_REVIEWER_REPORT,
        template_version: "1.5.0",
      }),
    );
    const result = parseReviewerReport(stdout);
    expect(result.ok).toBe(true);
  });

  it("returns schema-mismatch for an unknown verdict enum value", () => {
    const stdout = wrapReviewer(
      JSON.stringify({ ...VALID_REVIEWER_REPORT, verdict: "MAYBE" }),
    );
    const result = parseReviewerReport(stdout);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("schema-mismatch");
  });

  it("permits an optional guidance_to_coding_agent field on APPROVE", () => {
    const stdout = wrapReviewer(
      JSON.stringify({
        ...VALID_REVIEWER_REPORT,
        guidance_to_coding_agent: "Consider hoisting the helper next time.",
      }),
    );
    const result = parseReviewerReport(stdout);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.guidance_to_coding_agent).toContain("Consider");
  });
});

// ---------------------------------------------------------------------------
// VA-402: Run Review (v1.0.0) — the per-issue IRA verdict
// ---------------------------------------------------------------------------

const VALID_RUN_REVIEW = {
  template_version: RUN_REVIEW_VERSION,
  issue_identifier: "VA-401",
  drain_trace_id: "0123456789abcdef0123456789abcdef",
  final_outcome: "opened",
  // PRD's five quality dimensions, each absolute + (null relative at
  // this slice — VA-405 wires the rolling-norms axis).
  issue_quality: {
    absolute: "STRONG",
    relative: null,
    justification: "Issue body was specific and well-scoped.",
  },
  prompt_quality: {
    absolute: "ADEQUATE",
    relative: null,
    justification: "Prompt covered the requirement; could be tighter on edge cases.",
  },
  agent_quality: {
    absolute: "STRONG",
    relative: null,
    justification: "Agent satisfied every AC and produced surgical commits.",
  },
  reviewer_quality: {
    absolute: "STRONG",
    relative: null,
    justification: "Reviewer caught a real divergence and routed it correctly.",
  },
  orchestration_quality: {
    absolute: "STRONG",
    relative: null,
    justification: "Pipeline ran in 2 iterations, no infra retries.",
  },
  recommendations: [
    {
      target: "prompt",
      change: "Add an explicit instruction to verify report verdicts match markers.",
      confidence: "MEDIUM",
    },
  ],
  // VA-403 fills this in. v1.0.0 carries `null` as a stable marker.
  hindsight_signals: null,
};

describe("parseRunReview (VA-402)", () => {
  it("parses a well-formed Run Review at the current version", () => {
    const stdout = [
      "Preamble from the IRA's response.",
      wrapRunReview(JSON.stringify(VALID_RUN_REVIEW)),
      "",
    ].join("\n");
    const result = parseRunReview(stdout);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.issue_identifier).toBe("VA-401");
    expect(result.report.final_outcome).toBe("opened");
    expect(result.report.issue_quality.absolute).toBe("STRONG");
    expect(result.report.recommendations).toHaveLength(1);
    expect(result.report.recommendations[0]?.target).toBe("prompt");
    // Hindsight slot is `null` at v1.0.0 — VA-403 will widen.
    expect(result.report.hindsight_signals).toBeNull();
  });

  it("returns missing-block when no runway-run-review fence is present", () => {
    const result = parseRunReview("opening preamble, no JSON block");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("missing-block");
  });

  it("rejects an absolute-quality value outside the PRD alphabet", () => {
    const stdout = wrapRunReview(
      JSON.stringify({
        ...VALID_RUN_REVIEW,
        agent_quality: {
          ...VALID_RUN_REVIEW.agent_quality,
          absolute: "EXCELLENT",
        },
      }),
    );
    const result = parseRunReview(stdout);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("schema-mismatch");
  });

  it("rejects a recommendation target outside the PRD taxonomy", () => {
    const stdout = wrapRunReview(
      JSON.stringify({
        ...VALID_RUN_REVIEW,
        recommendations: [
          {
            target: "everything",
            change: "fix it all",
            confidence: "HIGH",
          },
        ],
      }),
    );
    const result = parseRunReview(stdout);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("schema-mismatch");
  });

  it("accepts a forward-compatible minor version inside the current major", () => {
    const stdout = wrapRunReview(
      JSON.stringify({ ...VALID_RUN_REVIEW, template_version: "1.5.0" }),
    );
    const result = parseRunReview(stdout);
    expect(result.ok).toBe(true);
  });

  it("rejects a major-version bump as version-mismatch", () => {
    const stdout = wrapRunReview(
      JSON.stringify({ template_version: "2.0.0" }),
    );
    const result = parseRunReview(stdout);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("version-mismatch");
  });

  // VA-403: Run Review v1.1.0 widens hindsight_signals from `null`
  // to `null | { pr, human_verdict, follow_up_issues }`. The schema
  // must continue to accept the v1.0.0 null payload (forward-compat
  // on the minor bump) while also accepting the new populated shape.

  it("v1.0.0 payloads with hindsight_signals: null still parse under the v1.1.0 schema", () => {
    // Locked v1.0.0 fixture (template_version stamped explicitly to
    // the prior minor) with hindsight_signals as the legacy null.
    const v100 = {
      ...VALID_RUN_REVIEW,
      template_version: "1.0.0",
      hindsight_signals: null,
    };
    const result = parseRunReview(wrapRunReview(JSON.stringify(v100)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.hindsight_signals).toBeNull();
  });

  it("accepts a populated hindsight_signals object at v1.1.0", () => {
    const v110 = {
      ...VALID_RUN_REVIEW,
      template_version: "1.1.0",
      hindsight_signals: {
        pr: {
          url: "https://github.com/x/y/pull/103",
          state: "merged",
          merged_at: "2026-05-15T01:23:45Z",
        },
        human_verdict: {
          sentiment: "approving",
          comment_count: 1,
          summary: "Reviewer @alice left a thumbs-up; no blocking notes.",
        },
        follow_up_issues: [
          { identifier: "VA-501", title: "Fix flaky test introduced by VA-401" },
        ],
      },
    };
    const result = parseRunReview(wrapRunReview(JSON.stringify(v110)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const hs = result.report.hindsight_signals;
    expect(hs).not.toBeNull();
    if (hs === null) return;
    expect(hs.pr?.state).toBe("merged");
    expect(hs.human_verdict?.sentiment).toBe("approving");
    expect(hs.follow_up_issues).toHaveLength(1);
    expect(hs.follow_up_issues[0]?.identifier).toBe("VA-501");
  });

  it("accepts independently-null sub-sections (partial hindsight)", () => {
    // Gateway may have GitHub token but no Linear search; or PR URL
    // missing but follow-ups present. Each sub-section nulls out
    // independently — the IRA grades on what it has.
    const partial = {
      ...VALID_RUN_REVIEW,
      template_version: "1.1.0",
      hindsight_signals: {
        pr: null,
        human_verdict: null,
        follow_up_issues: [],
      },
    };
    const result = parseRunReview(wrapRunReview(JSON.stringify(partial)));
    expect(result.ok).toBe(true);
  });

  // VA-405: Run Review v1.2.0 populates the relative axis from
  // rolling norms. The schema doesn't structurally change — `relative`
  // was already `null | <BETTER|STEADY|WORSE>` from VA-402 — but the
  // version bump signals "this run was graded with norms" so callers
  // can find norm-aware reviews in the meta-project. v1.0.0 / v1.1.0
  // reviews still parse (forward-compat on the minor bump).

  it("accepts a v1.2.0 payload with both nested and top-level relative axes populated", () => {
    const v120 = {
      ...VALID_RUN_REVIEW,
      template_version: "1.2.0",
      issue_quality: {
        absolute: "STRONG",
        relative: "BETTER",
        justification: "Issue was clearer than typical VA issues.",
      },
      prompt_quality: {
        absolute: "ADEQUATE",
        relative: "STEADY",
        justification: "Typical prompt scope.",
      },
      agent_quality: {
        absolute: "STRONG",
        relative: "BETTER",
        justification: "Iterations 2 vs median 3; under p95.",
      },
      reviewer_quality: {
        absolute: "ADEQUATE",
        relative: "STEADY",
        justification: "No rejections this run; matches category norm.",
      },
      orchestration_quality: {
        absolute: "STRONG",
        relative: "BETTER",
        justification: "Wall-time well under category median.",
      },
      // VA-405 AC: five top-level relative-axis fields. The IRA emits
      // both these and the nested slots; v1.2.0 consumers read these.
      issue_quality_relative: "BETTER",
      prompt_quality_relative: "STEADY",
      agent_quality_relative: "BETTER",
      reviewer_quality_relative: "STEADY",
      orchestration_quality_relative: "BETTER",
    };
    const result = parseRunReview(wrapRunReview(JSON.stringify(v120)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Nested slots round-trip (back-compat).
    expect(result.report.agent_quality.relative).toBe("BETTER");
    expect(result.report.reviewer_quality.relative).toBe("STEADY");
    // VA-405 AC: named top-level fields are present and typed.
    expect(result.report.issue_quality_relative).toBe("BETTER");
    expect(result.report.prompt_quality_relative).toBe("STEADY");
    expect(result.report.agent_quality_relative).toBe("BETTER");
    expect(result.report.reviewer_quality_relative).toBe("STEADY");
    expect(result.report.orchestration_quality_relative).toBe("BETTER");
  });

  it("v1.2.0 omitting the top-level *_quality_relative fields parses (norms-unavailable case)", () => {
    // Norms unavailable / sample too small → IRA omits the named
    // fields entirely AND sets every nested relative slot to null.
    // The schema must accept this shape so the runtime path doesn't
    // need to fabricate a sentinel.
    const v120NoNorms = {
      ...VALID_RUN_REVIEW,
      template_version: "1.2.0",
    };
    const result = parseRunReview(wrapRunReview(JSON.stringify(v120NoNorms)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.issue_quality_relative).toBeUndefined();
    expect(result.report.agent_quality_relative).toBeUndefined();
  });

  it("rejects an invalid value in a top-level *_quality_relative field", () => {
    const bad = {
      ...VALID_RUN_REVIEW,
      template_version: "1.2.0",
      agent_quality_relative: "MUCH_BETTER",
    };
    const result = parseRunReview(wrapRunReview(JSON.stringify(bad)));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("schema-mismatch");
  });

  it("v1.0.0 payloads (all relative=null) still parse under v1.2.0 (forward-compat)", () => {
    const v100 = {
      ...VALID_RUN_REVIEW,
      template_version: "1.0.0",
      hindsight_signals: null,
    };
    const result = parseRunReview(wrapRunReview(JSON.stringify(v100)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.agent_quality.relative).toBeNull();
  });

  it("v1.1.0 hindsight payloads still parse under v1.2.0 (forward-compat)", () => {
    const v110 = {
      ...VALID_RUN_REVIEW,
      template_version: "1.1.0",
      hindsight_signals: {
        pr: {
          url: "https://github.com/x/y/pull/103",
          state: "merged",
          merged_at: "2026-05-15T01:23:45Z",
        },
        human_verdict: null,
        follow_up_issues: [],
      },
    };
    const result = parseRunReview(wrapRunReview(JSON.stringify(v110)));
    expect(result.ok).toBe(true);
  });

  it("rejects an unknown relative-axis value outside the BETTER|STEADY|WORSE alphabet", () => {
    const bad = {
      ...VALID_RUN_REVIEW,
      template_version: "1.2.0",
      agent_quality: {
        absolute: "STRONG",
        relative: "MUCH_BETTER",
        justification: "x",
      },
    };
    const result = parseRunReview(wrapRunReview(JSON.stringify(bad)));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("schema-mismatch");
  });

  it("rejects an unknown PR state outside the open|merged|closed alphabet", () => {
    const bad = {
      ...VALID_RUN_REVIEW,
      template_version: "1.1.0",
      hindsight_signals: {
        pr: {
          url: "https://github.com/x/y/pull/103",
          state: "draft",
          merged_at: null,
        },
        human_verdict: null,
        follow_up_issues: [],
      },
    };
    const result = parseRunReview(wrapRunReview(JSON.stringify(bad)));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("schema-mismatch");
  });
});
