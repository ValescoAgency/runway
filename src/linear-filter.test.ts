import { Effect, Redacted } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// VA-394 / VA-423: `fetchReady` must skip issues that runway cannot or
// should not pick up — either because they're blocked by a non-terminal
// blocker (sequential dependency safety), they carry the HITL label
// (triage marked them human-only, or a prior drain already escaped
// them), they happen to have lost the `ready-for-agent` label between
// the GraphQL filter and the per-candidate read (eventual consistency),
// or they're a parent PRD with sub-issues.

const issuesMock = vi.fn();
const teamsMock = vi.fn();
const projectsMock = vi.fn();
const issueLabelsMock = vi.fn();
const issueGetMock = vi.fn();

vi.mock("@linear/sdk", () => {
  class LinearClient {
    issues = issuesMock;
    teams = teamsMock;
    workflowStates = vi.fn();
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
  issuesMock.mockReset();
  teamsMock.mockReset();
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
  /**
   * Labels on the issue. Defaults to `["ready-for-agent"]` so the
   * VA-423 client-side label check (`if (!labels.includes(readyLabel))
   * continue`) doesn't filter out fixtures that don't explicitly
   * exercise the label code-path. Tests that want to assert on the
   * dual-label / no-label skip behavior pass an explicit list.
   */
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
  // VA-425: number of child sub-issues on this candidate. Default 0
  // so existing tests stay on the "leaf issue" path.
  readonly childCount?: number;
  // VA-453: Linear workflow state `type`. Default `"unstarted"` so
  // existing tests keep exercising the non-terminal path; tests that
  // want to assert on the cancelled/done filter pass `"completed"` or
  // `"canceled"` explicitly.
  readonly stateType?: string;
}

function fakeIssue(args: FakeIssueArgs) {
  const labels = args.labels ?? ["ready-for-agent"];
  return {
    id: args.id,
    identifier: args.identifier,
    title: args.title,
    description: args.description ?? null,
    priority: args.priority ?? 0,
    createdAt: args.createdAt ?? "2026-01-01T00:00:00.000Z",
    labels: () =>
      Promise.resolve({
        nodes: labels.map((name, i) => ({
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
    children: () =>
      Promise.resolve({
        nodes: Array.from({ length: args.childCount ?? 0 }, (_, i) => ({
          id: `child-${args.id}-${i}`,
        })),
      }),
    // VA-453: drain skips terminal-state issues (see fetchReady).
    state: Promise.resolve({ type: args.stateType ?? "unstarted" }),
  };
}

function stubTeam() {
  teamsMock.mockResolvedValueOnce({ nodes: [{ id: "team-1", key: "VA" }] });
}

describe("VA-394 / VA-423 — fetchReady eligibility filters", () => {
  it("excludes an issue blocked by a non-terminal blocker", async () => {
    stubTeam();
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
    stubTeam();
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

  it("VA-423 AC: skips an issue carrying both `ready-for-agent` and `ready-for-human` (treat as ready-for-human)", async () => {
    stubTeam();
    issuesMock.mockResolvedValueOnce({
      nodes: [
        fakeIssue({
          id: "issue-d",
          identifier: "VA-4",
          title: "agent-ready but also human-marked",
          labels: ["ready-for-agent", "ready-for-human"],
        }),
        fakeIssue({
          id: "issue-e",
          identifier: "VA-5",
          title: "agent ok",
          labels: ["ready-for-agent", "Feature"],
        }),
      ],
    });

    const gateway = createLinearGateway(baseConfig);
    const result = await Effect.runPromise(gateway.fetchReady());

    expect(result.map((i) => i.identifier)).toEqual(["VA-5"]);
  });

  // VA-453
  it("VA-453: skips issues whose workflow state type is completed or canceled even when they still carry `ready-for-agent`", async () => {
    stubTeam();
    issuesMock.mockResolvedValueOnce({
      nodes: [
        fakeIssue({
          id: "issue-done",
          identifier: "VA-DONE",
          title: "marked Done but label not stripped",
          stateType: "completed",
        }),
        fakeIssue({
          id: "issue-cancelled",
          identifier: "VA-CAN",
          title: "marked Cancelled but label not stripped",
          stateType: "canceled",
        }),
        fakeIssue({
          id: "issue-active",
          identifier: "VA-LIVE",
          title: "actually drainable",
          stateType: "unstarted",
        }),
      ],
    });

    const gateway = createLinearGateway(baseConfig);
    const result = await Effect.runPromise(gateway.fetchReady());

    expect(result.map((i) => i.identifier)).toEqual(["VA-LIVE"]);
  });

  it("VA-423 AC: skips an issue carrying neither label (defensive — covers eventual consistency between GraphQL filter and per-candidate read)", async () => {
    stubTeam();
    issuesMock.mockResolvedValueOnce({
      nodes: [
        fakeIssue({
          id: "issue-no-labels",
          identifier: "VA-NO-LABEL",
          title: "label-less ghost",
          labels: [],
        }),
        fakeIssue({
          id: "issue-irrelevant",
          identifier: "VA-IRR",
          title: "different labels only",
          labels: ["Bug", "tracked"],
        }),
        fakeIssue({
          id: "issue-ok",
          identifier: "VA-OK",
          title: "still carries the ready label",
          labels: ["ready-for-agent"],
        }),
      ],
    });

    const gateway = createLinearGateway(baseConfig);
    const result = await Effect.runPromise(gateway.fetchReady());

    expect(result.map((i) => i.identifier)).toEqual(["VA-OK"]);
  });

  it("respects a custom hitlLabel from config (skipping the configured marker even when ready-for-agent is present)", async () => {
    stubTeam();
    issuesMock.mockResolvedValueOnce({
      nodes: [
        fakeIssue({
          id: "issue-f",
          identifier: "VA-6",
          title: "custom human marker",
          labels: ["ready-for-agent", "needs-attention"],
        }),
      ],
    });

    const customConfig = { ...baseConfig, hitlLabel: "needs-attention" };
    const gateway = createLinearGateway(customConfig);
    const result = await Effect.runPromise(gateway.fetchReady());

    expect(result).toEqual([]);
  });

  it("ignores non-blocks relation types (duplicate, related)", async () => {
    stubTeam();
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

  it("includes an issue carrying ready-for-agent and no extras (the common case)", async () => {
    stubTeam();
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

  it("VA-423: the GraphQL filter handed to client.issues() narrows by `labels.name = readyLabel`", async () => {
    stubTeam();
    issuesMock.mockResolvedValueOnce({ nodes: [] });

    const gateway = createLinearGateway(baseConfig);
    await Effect.runPromise(gateway.fetchReady());

    expect(issuesMock).toHaveBeenCalledTimes(1);
    const filterArg = issuesMock.mock.calls[0]?.[0]?.filter;
    expect(filterArg).toMatchObject({
      team: { id: { eq: "team-1" } },
      labels: { name: { eq: "ready-for-agent" } },
    });
    // No `state` filter — labels-as-state is the whole point of
    // VA-423; the absence is load-bearing.
    expect(filterArg).not.toHaveProperty("state");
  });

  it("VA-423: the GraphQL filter honors a custom `readyLabel`", async () => {
    stubTeam();
    issuesMock.mockResolvedValueOnce({ nodes: [] });

    const gateway = createLinearGateway({
      ...baseConfig,
      readyLabel: "agent-ready",
    });
    await Effect.runPromise(gateway.fetchReady());

    const filterArg = issuesMock.mock.calls[0]?.[0]?.filter;
    expect(filterArg).toMatchObject({
      labels: { name: { eq: "agent-ready" } },
    });
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
    stubTeam();
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
    stubTeam();
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
    stubTeam();
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

// VA-425: parent PRDs / umbrella tickets that have child sub-issues
// describe scope across multiple deliverables; the right unit of agent
// work is the child. `fetchReady` skips parents so the agent doesn't
// latch onto one user story and falsely close the umbrella.
describe("VA-425 — fetchReady skips parent issues with children", () => {
  it("includes an issue with no children (the common case)", async () => {
    stubTeam();
    issuesMock.mockResolvedValueOnce({
      nodes: [
        fakeIssue({
          id: "issue-leaf",
          identifier: "VA-LEAF",
          title: "self-contained ticket",
          childCount: 0,
        }),
      ],
    });

    const gateway = createLinearGateway(baseConfig);
    const result = await Effect.runPromise(gateway.fetchReady());

    expect(result.map((i) => i.identifier)).toEqual(["VA-LEAF"]);
  });

  it("skips an issue with one or more children (parent PRD)", async () => {
    stubTeam();
    issuesMock.mockResolvedValueOnce({
      nodes: [
        fakeIssue({
          id: "issue-prd",
          identifier: "VA-PRD",
          title: "umbrella PRD with sub-issues",
          childCount: 6,
        }),
        fakeIssue({
          id: "issue-leaf",
          identifier: "VA-LEAF",
          title: "self-contained sibling",
          childCount: 0,
        }),
      ],
    });

    const gateway = createLinearGateway(baseConfig);
    const result = await Effect.runPromise(gateway.fetchReady());

    expect(result.map((i) => i.identifier)).toEqual(["VA-LEAF"]);
  });

  it("includes child issues themselves (a child with no children of its own is eligible)", async () => {
    stubTeam();
    issuesMock.mockResolvedValueOnce({
      nodes: [
        fakeIssue({
          id: "issue-child",
          identifier: "VA-CHILD",
          title: "leaf slice under a PRD",
          childCount: 0,
        }),
      ],
    });

    const gateway = createLinearGateway(baseConfig);
    const result = await Effect.runPromise(gateway.fetchReady());

    expect(result.map((i) => i.identifier)).toEqual(["VA-CHILD"]);
  });
});
