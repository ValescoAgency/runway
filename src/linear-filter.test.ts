import { Effect, Redacted } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// VA-394: `fetchReady` must skip issues that runway cannot or should
// not pick up — either because they're blocked by a non-terminal
// blocker (sequential dependency safety) or because they carry the
// HITL label (triage marked them human-only, or a prior drain
// already escaped them).

const issuesMock = vi.fn();
const teamsMock = vi.fn();
const workflowStatesMock = vi.fn();
const projectsMock = vi.fn();
const issueLabelsMock = vi.fn();
const issueGetMock = vi.fn();

vi.mock("@linear/sdk", () => {
  class LinearClient {
    issues = issuesMock;
    teams = teamsMock;
    workflowStates = workflowStatesMock;
    projects = projectsMock;
    issueLabels = issueLabelsMock;
    issue = issueGetMock;
    updateIssue = vi.fn();
    createComment = vi.fn();
  }
  return { LinearClient, Issue: class {} };
});

const { createLinearGateway } = await import("./linear.js");

const baseConfig = {
  linearApiKey: Redacted.make("test"),
  linearTeam: "VA",
  readyStatus: "Todo",
  inProgressStatus: "In Progress",
  inReviewStatus: "In Review",
  hitlLabel: "needs-human",
  maxIterations: 5,
} as const;

beforeEach(() => {
  issuesMock.mockReset();
  teamsMock.mockReset();
  workflowStatesMock.mockReset();
  projectsMock.mockReset();
  issueLabelsMock.mockReset();
  issueGetMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface FakeIssueArgs {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly description?: string | null;
  readonly labels?: readonly string[];
  readonly inverseRelations?: readonly {
    readonly type: string;
    readonly blockerStateType: string | null;
  }[];
}

function fakeIssue(args: FakeIssueArgs) {
  return {
    id: args.id,
    identifier: args.identifier,
    title: args.title,
    description: args.description ?? null,
    labels: () =>
      Promise.resolve({
        nodes: (args.labels ?? []).map((name, i) => ({
          id: `lbl-${args.id}-${i}`,
          name,
        })),
      }),
    inverseRelations: () =>
      Promise.resolve({
        nodes: (args.inverseRelations ?? []).map((rel, i) => ({
          id: `rel-${args.id}-${i}`,
          type: rel.type,
          issue:
            rel.blockerStateType === null
              ? Promise.resolve(undefined)
              : Promise.resolve({
                  state: Promise.resolve({ type: rel.blockerStateType }),
                }),
        })),
      }),
  };
}

function stubTeamAndState() {
  teamsMock.mockResolvedValueOnce({ nodes: [{ id: "team-1", key: "VA" }] });
  workflowStatesMock.mockResolvedValueOnce({
    nodes: [{ id: "state-todo", name: "Todo" }],
  });
}

describe("VA-394 — fetchReady eligibility filters", () => {
  it("excludes an issue blocked by a non-terminal blocker", async () => {
    stubTeamAndState();
    issuesMock.mockResolvedValueOnce({
      nodes: [
        fakeIssue({
          id: "issue-a",
          identifier: "VA-1",
          title: "first slice",
        }),
        fakeIssue({
          id: "issue-b",
          identifier: "VA-2",
          title: "second slice",
          inverseRelations: [
            { type: "blocks", blockerStateType: "unstarted" },
          ],
        }),
      ],
    });

    const gateway = createLinearGateway(baseConfig);
    const result = await Effect.runPromise(gateway.fetchReady());

    expect(result.map((i) => i.identifier)).toEqual(["VA-1"]);
  });

  it("includes an issue whose blockers are all in terminal state", async () => {
    stubTeamAndState();
    issuesMock.mockResolvedValueOnce({
      nodes: [
        fakeIssue({
          id: "issue-c",
          identifier: "VA-3",
          title: "post-dependency",
          inverseRelations: [
            { type: "blocks", blockerStateType: "completed" },
            { type: "blocks", blockerStateType: "canceled" },
          ],
        }),
      ],
    });

    const gateway = createLinearGateway(baseConfig);
    const result = await Effect.runPromise(gateway.fetchReady());

    expect(result.map((i) => i.identifier)).toEqual(["VA-3"]);
  });

  it("excludes an issue carrying the HITL label", async () => {
    stubTeamAndState();
    issuesMock.mockResolvedValueOnce({
      nodes: [
        fakeIssue({
          id: "issue-d",
          identifier: "VA-4",
          title: "human only",
          labels: ["needs-human"],
        }),
        fakeIssue({
          id: "issue-e",
          identifier: "VA-5",
          title: "agent ok",
          labels: ["Feature"],
        }),
      ],
    });

    const gateway = createLinearGateway(baseConfig);
    const result = await Effect.runPromise(gateway.fetchReady());

    expect(result.map((i) => i.identifier)).toEqual(["VA-5"]);
  });

  it("respects a custom hitlLabel from config", async () => {
    stubTeamAndState();
    issuesMock.mockResolvedValueOnce({
      nodes: [
        fakeIssue({
          id: "issue-f",
          identifier: "VA-6",
          title: "custom label",
          labels: ["ready-for-human"],
        }),
      ],
    });

    const customConfig = { ...baseConfig, hitlLabel: "ready-for-human" };
    const gateway = createLinearGateway(customConfig);
    const result = await Effect.runPromise(gateway.fetchReady());

    expect(result).toEqual([]);
  });

  it("ignores non-blocks relation types (duplicate, related)", async () => {
    stubTeamAndState();
    issuesMock.mockResolvedValueOnce({
      nodes: [
        fakeIssue({
          id: "issue-g",
          identifier: "VA-7",
          title: "related but not blocked",
          inverseRelations: [
            { type: "duplicate", blockerStateType: "unstarted" },
            { type: "related", blockerStateType: "started" },
          ],
        }),
      ],
    });

    const gateway = createLinearGateway(baseConfig);
    const result = await Effect.runPromise(gateway.fetchReady());

    expect(result.map((i) => i.identifier)).toEqual(["VA-7"]);
  });

  it("includes an issue with no labels and no relations (the common case)", async () => {
    stubTeamAndState();
    issuesMock.mockResolvedValueOnce({
      nodes: [
        fakeIssue({
          id: "issue-h",
          identifier: "VA-8",
          title: "plain ready issue",
        }),
      ],
    });

    const gateway = createLinearGateway(baseConfig);
    const result = await Effect.runPromise(gateway.fetchReady());

    expect(result.map((i) => i.identifier)).toEqual(["VA-8"]);
  });
});
