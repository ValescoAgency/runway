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
  implTurns: 3,
  reviewRetries: 1,
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
  // VA-420: Linear priority encoding — 1=Urgent, 2=High, 3=Medium,
  // 4=Low, 0=No priority. Defaults to 0 so existing tests keep
  // exercising the "no explicit priority" path.
  readonly priority?: number;
  readonly createdAt?: string;
}

function fakeIssue(args: FakeIssueArgs) {
  return {
    id: args.id,
    identifier: args.identifier,
    title: args.title,
    description: args.description ?? null,
    priority: args.priority ?? 0,
    createdAt: args.createdAt ?? "2026-01-01T00:00:00.000Z",
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

// VA-420: the SDK's `IssueOrderBy` enum doesn't expose `priority`, and
// the un-directioned `createdAt` actually defaults to DESC on Linear's
// GraphQL — i.e. newest-first, the opposite of the FIFO comment the
// code used to carry. `fetchReady` now re-sorts the candidate set in
// JS: by priority bucket (Urgent → High → Medium → Low → No-priority),
// then by `createdAt` ASC within a bucket.
describe("VA-420 — fetchReady drain order", () => {
  it("drains higher Linear priority before lower priority", async () => {
    stubTeamAndState();
    // SDK returns newest-first (createdAt DESC default); the JS sort
    // must override that with priority-first ordering.
    issuesMock.mockResolvedValueOnce({
      nodes: [
        fakeIssue({
          id: "issue-medium",
          identifier: "VA-419",
          title: "medium, newest",
          priority: 3,
          createdAt: "2026-05-14T21:20:00.000Z",
        }),
        fakeIssue({
          id: "issue-urgent-middle",
          identifier: "VA-418",
          title: "urgent, middle-created",
          priority: 1,
          createdAt: "2026-05-14T20:49:00.000Z",
        }),
        fakeIssue({
          id: "issue-urgent-oldest",
          identifier: "VA-417",
          title: "urgent, oldest",
          priority: 1,
          createdAt: "2026-05-14T18:11:00.000Z",
        }),
      ],
    });

    const gateway = createLinearGateway(baseConfig);
    const result = await Effect.runPromise(gateway.fetchReady());

    // VA-417 (Urgent, oldest) → VA-418 (Urgent, newer) → VA-419 (Medium).
    expect(result.map((i) => i.identifier)).toEqual([
      "VA-417",
      "VA-418",
      "VA-419",
    ]);
  });

  it("breaks ties within a priority bucket by createdAt ASC (oldest first)", async () => {
    stubTeamAndState();
    issuesMock.mockResolvedValueOnce({
      nodes: [
        fakeIssue({
          id: "issue-newest",
          identifier: "VA-A",
          title: "high, newest",
          priority: 2,
          createdAt: "2026-05-14T21:00:00.000Z",
        }),
        fakeIssue({
          id: "issue-oldest",
          identifier: "VA-B",
          title: "high, oldest",
          priority: 2,
          createdAt: "2026-05-14T18:00:00.000Z",
        }),
        fakeIssue({
          id: "issue-middle",
          identifier: "VA-C",
          title: "high, middle",
          priority: 2,
          createdAt: "2026-05-14T19:30:00.000Z",
        }),
      ],
    });

    const gateway = createLinearGateway(baseConfig);
    const result = await Effect.runPromise(gateway.fetchReady());

    expect(result.map((i) => i.identifier)).toEqual(["VA-B", "VA-C", "VA-A"]);
  });

  it("sorts No-priority (Linear priority=0) behind every prioritised bucket", async () => {
    stubTeamAndState();
    issuesMock.mockResolvedValueOnce({
      nodes: [
        fakeIssue({
          id: "issue-no-prio-old",
          identifier: "VA-NP",
          title: "no priority, ancient",
          priority: 0,
          createdAt: "2024-01-01T00:00:00.000Z",
        }),
        fakeIssue({
          id: "issue-low",
          identifier: "VA-LOW",
          title: "low priority, recent",
          priority: 4,
          createdAt: "2026-05-14T20:00:00.000Z",
        }),
        fakeIssue({
          id: "issue-urgent",
          identifier: "VA-UR",
          title: "urgent",
          priority: 1,
          createdAt: "2026-05-14T19:00:00.000Z",
        }),
      ],
    });

    const gateway = createLinearGateway(baseConfig);
    const result = await Effect.runPromise(gateway.fetchReady());

    // Urgent → Low → No-priority, even though the No-priority issue is
    // by far the oldest.
    expect(result.map((i) => i.identifier)).toEqual([
      "VA-UR",
      "VA-LOW",
      "VA-NP",
    ]);
  });
});

describe("VA-421 — fetchReady accepts In-Progress when no remote agent branch", () => {
  function stubTeamTodoAndInProgress() {
    teamsMock.mockResolvedValueOnce({ nodes: [{ id: "team-1", key: "VA" }] });
    // findStateId is called twice (Todo, then In Progress) when the
    // gateway is built with `remoteAgentBranchExists`. Tests that
    // exercise the VA-421 path stub both lookups in that order.
    workflowStatesMock.mockResolvedValueOnce({
      nodes: [{ id: "state-todo", name: "Todo" }],
    });
    workflowStatesMock.mockResolvedValueOnce({
      nodes: [{ id: "state-inprog", name: "In Progress" }],
    });
  }

  it("accepts an In-Progress issue when origin/agent/<id> does not exist", async () => {
    stubTeamTodoAndInProgress();
    // First issues() call — Todo bucket (empty).
    issuesMock.mockResolvedValueOnce({ nodes: [] });
    // Second issues() call — In-Progress bucket (one auto-transitioned issue).
    issuesMock.mockResolvedValueOnce({
      nodes: [
        fakeIssue({
          id: "issue-ip-1",
          identifier: "VA-417",
          title: "in-progress, but never drained",
        }),
      ],
    });

    const remoteAgentBranchExists = vi.fn().mockResolvedValue(false);
    const gateway = createLinearGateway(baseConfig, null, {
      remoteAgentBranchExists,
    });
    const result = await Effect.runPromise(gateway.fetchReady());

    expect(result.map((i) => i.identifier)).toEqual(["VA-417"]);
    expect(remoteAgentBranchExists).toHaveBeenCalledWith("agent/va-417");
  });

  it("skips an In-Progress issue when origin/agent/<id> exists", async () => {
    stubTeamTodoAndInProgress();
    issuesMock.mockResolvedValueOnce({ nodes: [] });
    issuesMock.mockResolvedValueOnce({
      nodes: [
        fakeIssue({
          id: "issue-ip-2",
          identifier: "VA-500",
          title: "real work in flight",
        }),
      ],
    });

    const remoteAgentBranchExists = vi.fn().mockResolvedValue(true);
    const gateway = createLinearGateway(baseConfig, null, {
      remoteAgentBranchExists,
    });
    const result = await Effect.runPromise(gateway.fetchReady());

    expect(result).toEqual([]);
    expect(remoteAgentBranchExists).toHaveBeenCalledWith("agent/va-500");
  });

  it("skips an In-Progress issue with the HITL label without consulting git", async () => {
    stubTeamTodoAndInProgress();
    issuesMock.mockResolvedValueOnce({ nodes: [] });
    issuesMock.mockResolvedValueOnce({
      nodes: [
        fakeIssue({
          id: "issue-ip-hitl",
          identifier: "VA-600",
          title: "in-progress + HITL",
          labels: ["needs-human"],
        }),
      ],
    });

    const remoteAgentBranchExists = vi.fn().mockResolvedValue(false);
    const gateway = createLinearGateway(baseConfig, null, {
      remoteAgentBranchExists,
    });
    const result = await Effect.runPromise(gateway.fetchReady());

    expect(result).toEqual([]);
    // HITL filter runs before the git check — predicate never fires.
    expect(remoteAgentBranchExists).not.toHaveBeenCalled();
  });

  it("does not consult git for Todo candidates (no behavior change on the common path)", async () => {
    stubTeamTodoAndInProgress();
    issuesMock.mockResolvedValueOnce({
      nodes: [
        fakeIssue({
          id: "issue-todo",
          identifier: "VA-700",
          title: "plain todo",
        }),
      ],
    });
    issuesMock.mockResolvedValueOnce({ nodes: [] });

    const remoteAgentBranchExists = vi.fn().mockResolvedValue(true);
    const gateway = createLinearGateway(baseConfig, null, {
      remoteAgentBranchExists,
    });
    const result = await Effect.runPromise(gateway.fetchReady());

    expect(result.map((i) => i.identifier)).toEqual(["VA-700"]);
    expect(remoteAgentBranchExists).not.toHaveBeenCalled();
  });

  it("omits the In-Progress query entirely when no predicate is provided (legacy callers)", async () => {
    // No In-Progress state lookup — only Todo. Matches stubTeamAndState
    // (the pre-VA-421 helper).
    stubTeamAndState();
    issuesMock.mockResolvedValueOnce({
      nodes: [
        fakeIssue({
          id: "issue-todo-legacy",
          identifier: "VA-800",
          title: "legacy todo",
        }),
      ],
    });

    const gateway = createLinearGateway(baseConfig);
    const result = await Effect.runPromise(gateway.fetchReady());

    expect(result.map((i) => i.identifier)).toEqual(["VA-800"]);
    // Sanity: only one issues() call was made — no In-Progress bucket.
    expect(issuesMock).toHaveBeenCalledTimes(1);
  });
});
