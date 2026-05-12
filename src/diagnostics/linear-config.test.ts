import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.fn();
const validateLinearConfigMock = vi.fn();
vi.mock("../config.js", () => ({ loadConfig: loadConfigMock }));
vi.mock("../linear.js", () => ({
  validateLinearConfig: validateLinearConfigMock,
}));

const { linearConfigDiagnostic } = await import("./linear-config.js");

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
  loadConfigMock.mockReset();
  validateLinearConfigMock.mockReset();
  process.env.LINEAR_API_KEY = "test-key";
});

describe("linearConfigDiagnostic", () => {
  it("emits a single skip when LINEAR_API_KEY is unset", async () => {
    delete process.env.LINEAR_API_KEY;
    const results = await linearConfigDiagnostic.run(ctx);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      status: "skip",
      detail: expect.stringContaining("LINEAR_API_KEY unset"),
    });
  });

  it("emits fail + 2 skips when the team is missing", async () => {
    loadConfigMock.mockReturnValue({
      linearTeam: "VA",
      readyStatus: "Todo",
      inProgressStatus: "In Progress",
      inReviewStatus: "In Review",
      hitlLabel: "needs-human",
    });
    validateLinearConfigMock.mockResolvedValue({
      team: { kind: "missing", key: "VA" },
    });
    const results = await linearConfigDiagnostic.run(ctx);
    expect(results.map((r) => r.status)).toEqual(["fail", "skip", "skip"]);
    expect(results[0]?.detail).toContain('"VA" not found');
  });

  it("emits team-ok + 3 state results + hitl-label result when everything is configured", async () => {
    loadConfigMock.mockReturnValue({
      linearTeam: "VA",
      readyStatus: "Todo",
      inProgressStatus: "In Progress",
      inReviewStatus: "In Review",
      hitlLabel: "needs-human",
    });
    validateLinearConfigMock.mockResolvedValue({
      team: { kind: "ok", id: "team-uuid" },
      readyStatus: { kind: "ok" },
      inProgressStatus: { kind: "ok" },
      inReviewStatus: { kind: "ok" },
      hitlLabel: { kind: "ok" },
    });
    const results = await linearConfigDiagnostic.run(ctx);
    expect(results).toHaveLength(5);
    expect(results.every((r) => r.status === "ok")).toBe(true);
  });

  it("emits fail with the available list when the HITL label isn't on the team", async () => {
    loadConfigMock.mockReturnValue({
      linearTeam: "VA",
      readyStatus: "Todo",
      inProgressStatus: "In Progress",
      inReviewStatus: "In Review",
      hitlLabel: "needs-human",
    });
    validateLinearConfigMock.mockResolvedValue({
      team: { kind: "ok", id: "team-uuid" },
      readyStatus: { kind: "ok" },
      inProgressStatus: { kind: "ok" },
      inReviewStatus: { kind: "ok" },
      hitlLabel: {
        kind: "missing",
        available: ["bug", "feature", "ready-for-human"],
      },
    });
    const results = await linearConfigDiagnostic.run(ctx);
    const hitl = results.find((r) => r.label.includes("HITL"));
    expect(hitl).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("ready-for-human"),
    });
  });
});
