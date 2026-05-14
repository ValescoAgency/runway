import { describe, expect, it } from "vitest";
import { buildPrBody } from "./finalize.js";
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
