import { describe, expect, it } from "vitest";
import {
  CODING_AGENT_REPORT_FENCE_TAG,
  CODING_AGENT_REPORT_VERSION,
  REVIEWER_REPORT_FENCE_TAG,
  REVIEWER_REPORT_VERSION,
  parseCodingAgentReport,
  parseReviewerReport,
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
  verdict: "APPROVED",
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
        verdict: "CONTINUE",
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
    expect(result.report.verdict).toBe("APPROVED");
    expect(result.report.per_ac_validation).toHaveLength(1);
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

  it("returns schema-mismatch for an unknown verdict enum", () => {
    const stdout = wrapReviewer(
      JSON.stringify({ ...VALID_REVIEWER_REPORT, verdict: "MAYBE" }),
    );
    const result = parseReviewerReport(stdout);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("schema-mismatch");
  });

  it("permits an optional guidance_to_coding_agent field on APPROVED", () => {
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
