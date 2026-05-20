import { Redacted } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock @linear/sdk so validateLinearConfig doesn't try to hit the
// network. We replace LinearClient with a constructor whose returned
// instance exposes the resource methods we use.
//
// VA-423: workflow-state checks retired — runway's queue contract is
// label-gated and runway no longer issues state mutations, so the
// doctor verifies team + labels only.

const teamsMock = vi.fn();
const issueLabelsMock = vi.fn();

vi.mock("@linear/sdk", () => {
  class LinearClient {
    teams = teamsMock;
    issueLabels = issueLabelsMock;
    workflowStates = vi.fn();
    issues = vi.fn();
    issue = vi.fn();
    updateIssue = vi.fn();
    createComment = vi.fn();
    projects = vi.fn();
  }
  return { LinearClient };
});

const { validateLinearConfig } = await import("./linear.js");

const config = {
  linearApiKey: Redacted.make("k"),
  linearTeam: "VA",
  readyLabel: "ready-for-agent",
  hitlLabel: "ready-for-human",
  maxIterations: 5,
  implTurns: 3,
  reviewRetries: 1,
  metaReviewModel: "claude-sonnet-4-6",
  metaProjectName: "runway-meta",
  shepherdEnabled: false,
  shepherdPollIntervalSeconds: 15,
  shepherdMaxIterations: 3,
  shepherdMaxWallSeconds: 3600,
} as const;

beforeEach(() => {
  teamsMock.mockReset();
  issueLabelsMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("validateLinearConfig (VA-354 / VA-423)", () => {
  it("returns kind=missing for the team and skips downstream checks when the team key is wrong", async () => {
    teamsMock.mockResolvedValueOnce({ nodes: [] });

    const out = await validateLinearConfig(config);
    expect(out.team).toEqual({ kind: "missing", key: "VA" });
    expect(out.readyLabel.kind).toBe("skipped");
    expect(out.hitlLabel.kind).toBe("skipped");
    // Labels lookup never ran.
    expect(issueLabelsMock).not.toHaveBeenCalled();
  });

  it("flags a missing HITL label and surfaces available labels for triage", async () => {
    teamsMock.mockResolvedValueOnce({ nodes: [{ id: "team-1" }] });
    issueLabelsMock.mockResolvedValueOnce({
      nodes: [
        { name: "ready-for-agent" },
        { name: "needs-info" },
        { name: "wontfix" },
      ],
    });

    const out = await validateLinearConfig({
      ...config,
      hitlLabel: "missing-label-on-purpose",
    });
    expect(out.team).toEqual({ kind: "ok", id: "team-1" });
    expect(out.readyLabel).toEqual({
      kind: "ok",
      name: "ready-for-agent",
    });
    expect(out.hitlLabel).toEqual({
      kind: "missing",
      name: "missing-label-on-purpose",
      available: ["ready-for-agent", "needs-info", "wontfix"],
    });
  });

  it("returns all-ok when every configured label exists", async () => {
    teamsMock.mockResolvedValueOnce({ nodes: [{ id: "team-1" }] });
    issueLabelsMock.mockResolvedValueOnce({
      nodes: [
        { name: "ready-for-agent" },
        { name: "ready-for-human" },
        { name: "needs-info" },
      ],
    });

    const out = await validateLinearConfig(config);
    expect(out.team.kind).toBe("ok");
    expect(out.readyLabel.kind).toBe("ok");
    expect(out.hitlLabel.kind).toBe("ok");
  });

  it("flags a missing ready label with the team's actual label names", async () => {
    teamsMock.mockResolvedValueOnce({ nodes: [{ id: "team-1" }] });
    issueLabelsMock.mockResolvedValueOnce({
      nodes: [{ name: "Bug" }, { name: "Feature" }, { name: "ready-for-human" }],
    });

    const out = await validateLinearConfig(config);
    expect(out.readyLabel).toEqual({
      kind: "missing",
      name: "ready-for-agent",
      available: ["Bug", "Feature", "ready-for-human"],
    });
  });
});

describe("config defaults (VA-354 / VA-423)", () => {
  it("defaults readyLabel to ready-for-agent (flightplan v1.1.0 contract)", async () => {
    // VA-411: pass an explicit env so a host-exported
    // `RUNWAY_READY_LABEL` can't flip the assertion.
    const { loadConfig } = await import("./config.js");
    expect(loadConfig({ LINEAR_API_KEY: "test" }).readyLabel).toBe(
      "ready-for-agent",
    );
  });

  it("defaults hitlLabel to ready-for-human", async () => {
    const { loadConfig } = await import("./config.js");
    expect(loadConfig({ LINEAR_API_KEY: "test" }).hitlLabel).toBe(
      "ready-for-human",
    );
  });
});
