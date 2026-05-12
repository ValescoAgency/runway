import { beforeEach, describe, expect, it } from "vitest";
import { linearScopeDiagnostic } from "./linear-scope.js";

const ctx = {
  cwd: "/tmp/repo",
  tier: 2 as const,
  repo: {
    tier: 2 as const,
    hasDockerfile: true,
    hasSchema: true,
    authMode: "api-key" as const,
    hasConflictingAuthVars: false,
  },
  options: { detailed: false, json: false },
};

beforeEach(() => {
  delete process.env.RUNWAY_LINEAR_TEAM;
  delete process.env.RUNWAY_LINEAR_PROJECT;
});

describe("linearScopeDiagnostic", () => {
  it("falls back to team `VA` (team-wide) when both env vars are unset", async () => {
    const [res] = await linearScopeDiagnostic.run(ctx);
    expect(res).toMatchObject({
      status: "ok",
      detail: expect.stringContaining("team VA (team-wide"),
    });
  });

  it("surfaces RUNWAY_LINEAR_TEAM when set, without a project", async () => {
    process.env.RUNWAY_LINEAR_TEAM = "ENG";
    const [res] = await linearScopeDiagnostic.run(ctx);
    expect(res?.detail).toContain("team ENG");
    expect(res?.detail).toContain("RUNWAY_LINEAR_PROJECT unset");
  });

  it("combines team + project when both are set", async () => {
    process.env.RUNWAY_LINEAR_TEAM = "ENG";
    process.env.RUNWAY_LINEAR_PROJECT = "Migration";
    const [res] = await linearScopeDiagnostic.run(ctx);
    expect(res?.detail).toContain("team ENG / project Migration");
  });
});
