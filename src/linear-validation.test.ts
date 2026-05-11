import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock @linear/sdk so validateLinearConfig doesn't try to hit the
// network. We replace LinearClient with a constructor whose returned
// instance exposes the three resource methods we use.

const teamsMock = vi.fn();
const workflowStatesMock = vi.fn();
const issueLabelsMock = vi.fn();

vi.mock("@linear/sdk", () => {
  class LinearClient {
    teams = teamsMock;
    workflowStates = workflowStatesMock;
    issueLabels = issueLabelsMock;
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
  linearApiKey: "k",
  linearTeam: "VA",
  readyStatus: "Todo",
  inProgressStatus: "In Progress",
  inReviewStatus: "In Review",
  hitlLabel: "ready-for-human",
  maxIterations: 5,
} as const;

beforeEach(() => {
  teamsMock.mockReset();
  workflowStatesMock.mockReset();
  issueLabelsMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("validateLinearConfig (VA-354)", () => {
  it("returns kind=missing for the team and skips downstream checks when the team key is wrong", async () => {
    teamsMock.mockResolvedValueOnce({ nodes: [] });

    const out = await validateLinearConfig(config);
    expect(out.team).toEqual({ kind: "missing", key: "VA" });
    expect(out.readyStatus.kind).toBe("skipped");
    expect(out.hitlLabel.kind).toBe("skipped");
    // Workflow states / labels lookups never ran.
    expect(workflowStatesMock).not.toHaveBeenCalled();
    expect(issueLabelsMock).not.toHaveBeenCalled();
  });

  it("flags a missing HITL label and surfaces available labels for triage", async () => {
    teamsMock.mockResolvedValueOnce({ nodes: [{ id: "team-1" }] });
    workflowStatesMock.mockResolvedValueOnce({
      nodes: [
        { name: "Todo" },
        { name: "In Progress" },
        { name: "In Review" },
      ],
    });
    issueLabelsMock.mockResolvedValueOnce({
      nodes: [
        { name: "ready-for-agent" },
        { name: "needs-info" },
        { name: "wontfix" },
      ],
    });

    const out = await validateLinearConfig({
      ...config,
      hitlLabel: "needs-human",
    });
    expect(out.team).toEqual({ kind: "ok", id: "team-1" });
    expect(out.readyStatus).toEqual({ kind: "ok", name: "Todo" });
    expect(out.hitlLabel).toEqual({
      kind: "missing",
      name: "needs-human",
      available: ["ready-for-agent", "needs-info", "wontfix"],
    });
  });

  it("returns all-ok when every configured name exists", async () => {
    teamsMock.mockResolvedValueOnce({ nodes: [{ id: "team-1" }] });
    workflowStatesMock.mockResolvedValueOnce({
      nodes: [
        { name: "Todo" },
        { name: "In Progress" },
        { name: "In Review" },
      ],
    });
    issueLabelsMock.mockResolvedValueOnce({
      nodes: [{ name: "ready-for-human" }, { name: "needs-info" }],
    });

    const out = await validateLinearConfig(config);
    expect(out.team.kind).toBe("ok");
    expect(out.readyStatus.kind).toBe("ok");
    expect(out.inProgressStatus.kind).toBe("ok");
    expect(out.inReviewStatus.kind).toBe("ok");
    expect(out.hitlLabel.kind).toBe("ok");
  });

  it("flags a missing workflow state with the team's actual state names", async () => {
    teamsMock.mockResolvedValueOnce({ nodes: [{ id: "team-1" }] });
    workflowStatesMock.mockResolvedValueOnce({
      nodes: [{ name: "Backlog" }, { name: "Doing" }, { name: "Done" }],
    });
    issueLabelsMock.mockResolvedValueOnce({ nodes: [] });

    const out = await validateLinearConfig(config);
    expect(out.readyStatus).toEqual({
      kind: "missing",
      name: "Todo",
      available: ["Backlog", "Doing", "Done"],
    });
  });
});

describe("config default (VA-354)", () => {
  it("defaults hitlLabel to ready-for-human (Flightplan canonical)", async () => {
    vi.resetModules();
    // Ensure no override is in env when re-loading config.
    delete process.env.RUNWAY_HITL_LABEL;
    process.env.LINEAR_API_KEY = "test";
    const { loadConfig } = await import("./config.js");
    expect(loadConfig().hitlLabel).toBe("ready-for-human");
  });
});
