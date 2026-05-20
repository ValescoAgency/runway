import { Effect, Either, Redacted } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// VA-360: prove the SDK-response schema validation actually catches
// drift. Mock `@linear/sdk` to return malformed nodes (missing
// `identifier`, wrong type for `id`, etc.) and assert that
// `fetchReady` rejects with a typed `LinearSchemaError` rather than a
// downstream `cannot read property` runtime crash.
//
// VA-423: queue is now label-gated — no workflowStates lookup; the
// happy-path issues must carry the configured `readyLabel` for the
// eligibility check to admit them.

const issuesMock = vi.fn();
const teamsMock = vi.fn();
const projectsMock = vi.fn();
const issueLabelsMock = vi.fn();
const issueGetMock = vi.fn();
// VA-416: hoisted so applyLabel tests can assert the call args.
const updateIssueMock = vi.fn();

vi.mock("@linear/sdk", () => {
  class LinearClient {
    issues = issuesMock;
    teams = teamsMock;
    workflowStates = vi.fn();
    projects = projectsMock;
    issueLabels = issueLabelsMock;
    issue = issueGetMock;
    updateIssue = updateIssueMock;
    createComment = vi.fn();
  }
  return { LinearClient };
});

const { createLinearGateway } = await import("./linear.js");

const config = {
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
  updateIssueMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("VA-360 — Linear SDK response schemas", () => {
  it("fetchReady rejects with LinearSchemaError when an issue node is missing the `identifier` field", async () => {
    teamsMock.mockResolvedValueOnce({
      nodes: [{ id: "team-1", key: "VA" }],
    });
    // Drifted issue: no `identifier` field. Pre-VA-360, the
    // orchestrator would later trip on `i.identifier` as undefined
    // and the drain would error out as `LinearNetworkError` (the
    // catch-all bucket). Post-VA-360 this is a typed schema error.
    issuesMock.mockResolvedValueOnce({
      nodes: [
        {
          id: "issue-1",
          title: "T",
          description: null,
          // identifier intentionally omitted
        },
      ],
    });

    const gateway = createLinearGateway(config);
    const result = await Effect.runPromise(
      gateway.fetchReady().pipe(Effect.either),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("LinearSchemaError");
      // The call label flows through so the operator can tell which
      // gateway method tripped on the drift.
      expect((result.left as { call: string }).call).toBe("fetchReady");
    }
  });

  it("fetchReady rejects with LinearSchemaError when an issue's `title` has the wrong type", async () => {
    teamsMock.mockResolvedValueOnce({
      nodes: [{ id: "team-1", key: "VA" }],
    });
    issuesMock.mockResolvedValueOnce({
      nodes: [
        {
          id: "issue-1",
          identifier: "VA-1",
          title: 42, // drifted — number instead of string
          description: null,
        },
      ],
    });

    const gateway = createLinearGateway(config);
    const result = await Effect.runPromise(
      gateway.fetchReady().pipe(Effect.either),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("LinearSchemaError");
    }
  });

  it("happy path still works — well-formed nodes decode cleanly", async () => {
    teamsMock.mockResolvedValueOnce({
      nodes: [{ id: "team-1", key: "VA" }],
    });
    // VA-394 + VA-425 / VA-423: `fetchReady` calls `.labels()`,
    // `.inverseRelations()`, and `.children()` on each candidate to
    // apply eligibility filters — the happy path needs to mock them,
    // and `labels()` must include the configured `readyLabel`
    // (`ready-for-agent`) so the candidate isn't filtered out by the
    // VA-423 client-side check.
    const emptyConnection = () => Promise.resolve({ nodes: [] });
    const readyLabelConnection = () =>
      Promise.resolve({
        nodes: [{ id: "lbl-ready", name: "ready-for-agent" }],
      });
    issuesMock.mockResolvedValueOnce({
      nodes: [
        {
          id: "issue-1",
          identifier: "VA-1",
          title: "First",
          description: "an issue",
          priority: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          labels: readyLabelConnection,
          inverseRelations: emptyConnection,
          children: emptyConnection,
        },
        {
          id: "issue-2",
          identifier: "VA-2",
          title: "Second",
          description: null,
          priority: 0,
          createdAt: "2026-01-02T00:00:00.000Z",
          labels: readyLabelConnection,
          inverseRelations: emptyConnection,
          children: emptyConnection,
        },
      ],
    });

    const gateway = createLinearGateway(config);
    const issues = await Effect.runPromise(gateway.fetchReady());
    expect(issues).toEqual([
      {
        id: "issue-1",
        identifier: "VA-1",
        title: "First",
        description: "an issue",
        labels: ["ready-for-agent"],
      },
      {
        id: "issue-2",
        identifier: "VA-2",
        title: "Second",
        description: "",
        labels: ["ready-for-agent"],
      },
    ]);
  });

  it("LinearSchemaError is NOT in the retryable set — schema drift fails fast", async () => {
    // We can't directly observe the retry policy from outside, but we
    // can prove the schema error type isn't retryable by importing
    // `applyLinearPolicy` and verifying the typed retry predicate
    // would not re-attempt it. This guards against accidentally
    // adding `LinearSchemaError` to RETRYABLE_LINEAR_TAGS.
    const { LinearSchemaError, applyLinearPolicy } = await import(
      "./linear.js"
    );
    const counter = { n: 0 };
    const failing = Effect.gen(function* () {
      counter.n += 1;
      return yield* Effect.fail(
        new LinearSchemaError({
          call: "test",
          message: "drift",
        }),
      );
    });
    const wrapped = applyLinearPolicy(failing, {
      call: "test",
      timeoutMs: 5_000,
    });
    const result = await Effect.runPromise(wrapped.pipe(Effect.either));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("LinearSchemaError");
    }
    // Exactly one attempt — schema error short-circuits the retry
    // loop. If schema errors slipped into the retryable set this
    // counter would be 6 (1 + 5 retries).
    expect(counter.n).toBe(1);
  });
});

describe("VA-415 — fetchComments tolerates missing `user` field", () => {
  it("decodes a comment node where `user` is absent from the payload (not just null)", async () => {
    issueGetMock.mockResolvedValueOnce({
      comments: vi.fn().mockResolvedValueOnce({
        nodes: [
          // System / integration / deleted-user shape: `user` key is
          // entirely missing. Pre-VA-415 this tripped Schema.NullOr.
          { id: "c-1", body: "system comment", createdAt: "2026-05-14T00:00:00Z" },
          // Present-and-null still works.
          {
            id: "c-2",
            body: "explicit null user",
            createdAt: "2026-05-14T00:01:00Z",
            user: null,
          },
          // Full struct still works.
          {
            id: "c-3",
            body: "human comment",
            createdAt: "2026-05-14T00:02:00Z",
            user: { id: "u-1", name: "Alice" },
          },
        ],
      }),
    });

    const gateway = createLinearGateway(config);
    const result = await Effect.runPromise(
      gateway.fetchComments("issue-uuid").pipe(Effect.either),
    );
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right).toHaveLength(3);
      // Missing-user and null-user both surface as empty `author` so
      // downstream allowlist filtering doesn't trip on undefined.
      const byId = Object.fromEntries(result.right.map((c) => [c.id, c]));
      expect(byId["c-1"]?.author).toBe("");
      expect(byId["c-2"]?.author).toBe("");
      expect(byId["c-3"]?.author).toBe("Alice");
    }
  });
});

describe("VA-416 — applyLabel resolves workspace-scope labels, not just team-scope", () => {
  it("applies a workspace-scoped label (no team association) when the team has no same-name label", async () => {
    updateIssueMock.mockResolvedValueOnce({});
    issueGetMock.mockResolvedValueOnce({
      team: Promise.resolve({ id: "team-1" }),
      labels: vi.fn().mockResolvedValueOnce({ nodes: [] }),
    });
    issueLabelsMock.mockResolvedValueOnce({
      nodes: [
        {
          id: "lbl-workspace",
          name: "ready-for-human",
          team: Promise.resolve(null),
        },
      ],
    });

    const gateway = createLinearGateway(config);
    const result = await Effect.runPromise(
      gateway.applyLabel("issue-uuid", "ready-for-human").pipe(Effect.either),
    );
    expect(Either.isRight(result)).toBe(true);
    expect(updateIssueMock).toHaveBeenCalledWith("issue-uuid", {
      labelIds: ["lbl-workspace"],
    });
  });

  it("prefers a team-scoped label over a workspace-scoped one when both share a name", async () => {
    updateIssueMock.mockResolvedValueOnce({});
    issueGetMock.mockResolvedValueOnce({
      team: Promise.resolve({ id: "team-1" }),
      labels: vi.fn().mockResolvedValueOnce({ nodes: [] }),
    });
    issueLabelsMock.mockResolvedValueOnce({
      nodes: [
        {
          id: "lbl-workspace",
          name: "ready-for-human",
          team: Promise.resolve(null),
        },
        {
          id: "lbl-team",
          name: "ready-for-human",
          team: Promise.resolve({ id: "team-1" }),
        },
      ],
    });

    const gateway = createLinearGateway(config);
    const result = await Effect.runPromise(
      gateway.applyLabel("issue-uuid", "ready-for-human").pipe(Effect.either),
    );
    expect(Either.isRight(result)).toBe(true);
    expect(updateIssueMock).toHaveBeenCalledWith("issue-uuid", {
      labelIds: ["lbl-team"],
    });
  });

  it("throws LinearNotFound when no label with that name exists at any scope", async () => {
    issueGetMock.mockResolvedValueOnce({
      team: Promise.resolve({ id: "team-1" }),
      labels: vi.fn().mockResolvedValueOnce({ nodes: [] }),
    });
    issueLabelsMock.mockResolvedValueOnce({ nodes: [] });

    const gateway = createLinearGateway(config);
    const result = await Effect.runPromise(
      gateway.applyLabel("issue-uuid", "does-not-exist").pipe(Effect.either),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("LinearNotFound");
    }
    expect(updateIssueMock).not.toHaveBeenCalled();
  });
});

// VA-423: pickup-time claim signal. The orchestrator calls
// `removeLabel(issueId, config.readyLabel)` once an issue is chosen.
// The returned `{ removed }` lets the caller distinguish the claim-
// winner branch from the lost-race branch so the loser can skip
// before doing visible work.
describe("VA-423 — removeLabel claim signal", () => {
  it("issues an updateIssue write and returns `removed: true` when the label was present", async () => {
    updateIssueMock.mockResolvedValueOnce({});
    issueGetMock.mockResolvedValueOnce({
      labels: vi.fn().mockResolvedValueOnce({
        nodes: [
          { id: "lbl-ready", name: "ready-for-agent" },
          { id: "lbl-other", name: "Bug" },
        ],
      }),
    });

    const gateway = createLinearGateway(config);
    const result = await Effect.runPromise(
      gateway
        .removeLabel("issue-uuid", "ready-for-agent")
        .pipe(Effect.either),
    );
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right).toEqual({ removed: true });
    }
    expect(updateIssueMock).toHaveBeenCalledWith("issue-uuid", {
      labelIds: ["lbl-other"],
    });
  });

  it("returns `removed: false` and skips the write when the label is already absent (lost claim race / operator-removed)", async () => {
    issueGetMock.mockResolvedValueOnce({
      labels: vi.fn().mockResolvedValueOnce({
        nodes: [{ id: "lbl-other", name: "Bug" }],
      }),
    });

    const gateway = createLinearGateway(config);
    const result = await Effect.runPromise(
      gateway
        .removeLabel("issue-uuid", "ready-for-agent")
        .pipe(Effect.either),
    );
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      // The orchestrator branches on this flag — losers must see
      // `removed: false` so they can short-circuit before the
      // pickup comment lands.
      expect(result.right).toEqual({ removed: false });
    }
    // No write issued at all — the gateway short-circuits before the
    // updateIssue call when the label was absent at read time.
    expect(updateIssueMock).not.toHaveBeenCalled();
  });
});
