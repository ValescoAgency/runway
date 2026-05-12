import { describe, expect, it } from "vitest";
import { renderImplementPrompt, renderReviewPrompt } from "./prompts.js";
import type { Policy } from "./policy.js";
import type { RunwayIssue } from "./linear.js";

// VA-361: contract tests on the deep prompt API. The leaf helpers
// (load*, renderPrompt, *Vars, renderForbiddenPathsBullet) are now
// private — we assert at the seam callers actually use: "given this
// issue + policy + state, the rendered string contains X."
//
// These tests read the real `prompts/implement.md` and
// `prompts/review.md` templates. That's intentional — if a template
// drops a placeholder, the corresponding substitution test fails
// loudly, which is the alert we want.

const issue: RunwayIssue = {
  id: "issue-1",
  identifier: "VA-312",
  title: "Fix the TOCTOU race in provisionHousehold",
  description: "Acceptance: add a unique index on owner role.",
};

const policyWithPaths: Policy = {
  forbiddenPaths: [".env*", "*.pem"],
  source: "test",
};

const policyEmpty: Policy = {
  forbiddenPaths: [],
  source: "test",
};

describe("renderImplementPrompt (VA-361)", () => {
  it("substitutes the issue identifier, title, and description into the template", async () => {
    const out = await renderImplementPrompt({
      issue,
      policy: policyWithPaths,
      previousIterations: "",
    });
    expect(out).toContain("VA-312");
    expect(out).toContain("Fix the TOCTOU race in provisionHousehold");
    expect(out).toContain("Acceptance: add a unique index on owner role.");
  });

  it("falls back to `(no description)` when the issue description is empty", async () => {
    const out = await renderImplementPrompt({
      issue: { ...issue, description: "" },
      policy: policyEmpty,
      previousIterations: "",
    });
    expect(out).toContain("(no description)");
  });

  it("renders the policy's forbidden paths into the working-style bullet", async () => {
    const out = await renderImplementPrompt({
      issue,
      policy: policyWithPaths,
      previousIterations: "",
    });
    expect(out).toContain("`.env*`");
    expect(out).toContain("`*.pem`");
    expect(out).toContain("IMPL: BLOCKED");
  });

  it("emits the no-restriction sentence when forbiddenPaths is empty", async () => {
    const out = await renderImplementPrompt({
      issue,
      policy: policyEmpty,
      previousIterations: "",
    });
    expect(out).toMatch(/No write-path restrictions/);
  });

  it("substitutes previousIterations into the {{PREVIOUS_ITERATIONS}} slot", async () => {
    const summary = "## Previous iterations\n\nDid stuff already.";
    const out = await renderImplementPrompt({
      issue,
      policy: policyWithPaths,
      previousIterations: summary,
    });
    expect(out).toContain("Did stuff already.");
  });

  it("leaves PREVIOUS_ITERATIONS empty when no summary is passed", async () => {
    const out = await renderImplementPrompt({
      issue,
      policy: policyWithPaths,
      previousIterations: "",
    });
    expect(out).not.toContain("{{PREVIOUS_ITERATIONS}}");
  });
});

describe("renderReviewPrompt (VA-361)", () => {
  it("substitutes the issue identifier, title, description, diff, and commits", async () => {
    const out = await renderReviewPrompt({
      issue,
      diff: "--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new",
      commits: "abc123 Add unique index\ndef456 Wire withAudit",
    });
    expect(out).toContain("VA-312");
    expect(out).toContain("Fix the TOCTOU race in provisionHousehold");
    expect(out).toContain("--- a/foo.ts");
    expect(out).toContain("abc123 Add unique index");
  });

  it("falls back to `(empty diff)` / `(no commits)` when those args are empty", async () => {
    const out = await renderReviewPrompt({
      issue,
      diff: "",
      commits: "",
    });
    expect(out).toContain("(empty diff)");
    expect(out).toContain("(no commits)");
  });
});
