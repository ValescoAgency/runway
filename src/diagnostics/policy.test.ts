import { beforeEach, describe, expect, it, vi } from "vitest";

const loadPolicyMock = vi.fn();
vi.mock("../policy.js", () => ({
  loadPolicy: loadPolicyMock,
}));

const { policyDiagnostic } = await import("./policy.js");

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
  loadPolicyMock.mockReset();
});

describe("policyDiagnostic", () => {
  it("returns ok with the policy source + forbidden-path count", async () => {
    loadPolicyMock.mockReturnValue({
      source: ".runway/policy.yml",
      forbiddenPaths: ["**/*.md", ".github/**"],
    });
    const [res] = await policyDiagnostic.run(ctx);
    expect(res).toEqual({
      status: "ok",
      label: "impl policy",
      detail: ".runway/policy.yml (2 forbidden paths)",
    });
  });

  it("singularises the count when there's exactly one forbidden path", async () => {
    loadPolicyMock.mockReturnValue({
      source: "default",
      forbiddenPaths: [".github/**"],
    });
    const [res] = await policyDiagnostic.run(ctx);
    expect(res?.detail).toBe("default (1 forbidden path)");
  });

  it("returns fail when loadPolicy throws (malformed YAML)", async () => {
    loadPolicyMock.mockImplementation(() => {
      throw new Error("invalid yaml at line 3");
    });
    const [res] = await policyDiagnostic.run(ctx);
    expect(res).toMatchObject({
      status: "fail",
      detail: "invalid yaml at line 3",
    });
  });
});
