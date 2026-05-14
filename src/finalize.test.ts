import { describe, expect, it } from "vitest";
import { buildPrBody, formatRebaseConflictReason } from "./finalize.js";
import type { RunwayIssue } from "./linear.js";

const issue: RunwayIssue = {
  id: "issue-id",
  identifier: "VA-412",
  title: "finalize emits the wrong magic word",
  description: "A description.",
  labels: [],
};

describe("buildPrBody (VA-412)", () => {
  it("ends with `Closes <identifier>` so Linear auto-transitions on merge", () => {
    const body = buildPrBody(issue);
    expect(body).toContain("Closes VA-412");
    expect(body).not.toMatch(/^Refs VA-412$/m);
  });

  it("falls back to a placeholder when the issue has no description", () => {
    const body = buildPrBody({ ...issue, description: "" });
    expect(body).toContain("(no description)");
    expect(body).toContain("Closes VA-412");
  });
});

describe("formatRebaseConflictReason (VA-419)", () => {
  it("names the base branch, lists conflicted files, and quotes the APPROVED verdict", () => {
    const reason = formatRebaseConflictReason({
      baseBranch: "master",
      conflictedFiles: [
        "src/dashboard/storage.ts",
        "src/dashboard/storage.test.ts",
      ],
      reviewVerdict: "REVIEW: APPROVED",
    });
    expect(reason).toMatch(/Upstream base `master` advanced/);
    expect(reason).toMatch(/- src\/dashboard\/storage\.ts/);
    expect(reason).toMatch(/- src\/dashboard\/storage\.test\.ts/);
    expect(reason).toMatch(/Review was APPROVED before the rebase/);
    expect(reason).toMatch(/`REVIEW: APPROVED`/);
  });

  it("falls back to a hint when git reported no conflicted files", () => {
    const reason = formatRebaseConflictReason({
      baseBranch: "main",
      conflictedFiles: [],
      reviewVerdict: "REVIEW: APPROVED",
    });
    expect(reason).toMatch(/no conflicted files reported by git/);
  });
});
