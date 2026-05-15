import { describe, expect, it } from "vitest";
import {
  buildPrBody,
  formatRebaseConflictReason,
  formatRebaseFailureReason,
} from "./finalize.js";
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

describe("formatRebaseConflictReason (VA-419 / VA-424)", () => {
  it("names the base branch, lists conflicted files, and quotes the APPROVED verdict", () => {
    const reason = formatRebaseConflictReason({
      baseBranch: "master",
      conflictedFiles: [
        "src/dashboard/storage.ts",
        "src/dashboard/storage.test.ts",
      ],
      reviewVerdict: "REVIEW: APPROVED",
    });
    expect(reason).toMatch(/onto `origin\/master` produced merge/);
    expect(reason).toMatch(/- src\/dashboard\/storage\.ts/);
    expect(reason).toMatch(/- src\/dashboard\/storage\.test\.ts/);
    expect(reason).toMatch(/Review was APPROVED before the rebase/);
    expect(reason).toMatch(/`REVIEW: APPROVED`/);
  });

  it("does not claim 'upstream advanced' (VA-424 fix — that wording was inaccurate)", () => {
    const reason = formatRebaseConflictReason({
      baseBranch: "master",
      conflictedFiles: ["src/foo.ts"],
      reviewVerdict: "REVIEW: APPROVED",
    });
    expect(reason).not.toMatch(/Upstream base.*advanced/);
  });

  it("does not recommend letting VA-417 handle it (VA-424 fix — VA-417 destroys approved work)", () => {
    const reason = formatRebaseConflictReason({
      baseBranch: "master",
      conflictedFiles: ["src/foo.ts"],
      reviewVerdict: "REVIEW: APPROVED",
    });
    expect(reason).not.toMatch(/VA-417/);
    // The original wording told operators to "let VA-417 handle it on the
    // next drain" — that path destroys approved work. New wording must
    // not recommend deferring to the next drain (it can still warn
    // operators _not_ to do so, which is the opposite advice).
    expect(reason).not.toMatch(/(^|[^A-Z])let .*(VA-417|next drain) handle/i);
    expect(reason).toMatch(/manually/);
  });
});

describe("formatRebaseFailureReason (VA-424)", () => {
  it("surfaces git stderr, names the base branch, and quotes the APPROVED verdict", () => {
    const reason = formatRebaseFailureReason({
      baseBranch: "master",
      stderr: "error: cannot rebase: You have unstaged changes.\n",
      stdout: "",
      reviewVerdict: "REVIEW: APPROVED",
    });
    expect(reason).toMatch(/onto `origin\/master` failed/);
    expect(reason).toMatch(/no unmerged files/);
    expect(reason).toMatch(/cannot rebase: You have unstaged changes/);
    expect(reason).toMatch(/Review was APPROVED before the rebase/);
  });

  it("falls back to stdout when stderr is empty", () => {
    const reason = formatRebaseFailureReason({
      baseBranch: "main",
      stderr: "",
      stdout: "some rebase output that hints at what went wrong",
      reviewVerdict: "REVIEW: APPROVED",
    });
    expect(reason).toMatch(/some rebase output/);
  });

  it("renders a placeholder when git produced no output", () => {
    const reason = formatRebaseFailureReason({
      baseBranch: "main",
      stderr: "",
      stdout: "",
      reviewVerdict: "REVIEW: APPROVED",
    });
    expect(reason).toMatch(/no stderr or stdout/);
  });

  it("does not recommend letting VA-417 handle it (VA-417 destroys approved work)", () => {
    const reason = formatRebaseFailureReason({
      baseBranch: "master",
      stderr: "some failure",
      stdout: "",
      reviewVerdict: "REVIEW: APPROVED",
    });
    expect(reason).not.toMatch(/VA-417/);
    // The original wording told operators to "let VA-417 handle it on the
    // next drain" — that path destroys approved work. New wording must
    // not recommend deferring to the next drain (it can still warn
    // operators _not_ to do so, which is the opposite advice).
    expect(reason).not.toMatch(/(^|[^A-Z])let .*(VA-417|next drain) handle/i);
  });
});
