import { Effect, Either, Redacted } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// VA-360: prove the SDK-response schema validation actually catches
// drift. Mock `@linear/sdk` to return malformed nodes (missing
// `identifier`, wrong type for `id`, etc.) and assert that
// `fetchReady` rejects with a typed `LinearSchemaError` rather than a
// downstream `cannot read property` runtime crash.

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
  return { LinearClient };
});

const { createLinearGateway } = await import("./linear.js");

const config = {
  linearApiKey: Redacted.make("test"),
  linearTeam: "VA",
  readyStatus: "Todo",
  inProgressStatus: "In Progress",
  inReviewStatus: "In Review",
  hitlLabel: "ready-for-human",
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

describe("VA-360 — Linear SDK response schemas", () => {
  it("fetchReady rejects with LinearSchemaError when an issue node is missing the `identifier` field", async () => {
    teamsMock.mockResolvedValueOnce({
      nodes: [{ id: "team-1", key: "VA" }],
    });
    workflowStatesMock.mockResolvedValueOnce({
      nodes: [{ id: "state-todo", name: "Todo" }],
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
    workflowStatesMock.mockResolvedValueOnce({
      nodes: [{ id: "state-todo", name: "Todo" }],
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

  it("transition rejects with LinearSchemaError when a workflow state node is missing `id`", async () => {
    issueGetMock.mockResolvedValueOnce({
      team: Promise.resolve({ id: "team-1", key: "VA" }),
    });
    // Drifted state node — no `id`.
    workflowStatesMock.mockResolvedValueOnce({
      nodes: [{ name: "In Progress" }],
    });

    const gateway = createLinearGateway(config);
    const result = await Effect.runPromise(
      gateway.transition("issue-1", "In Progress").pipe(Effect.either),
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
    workflowStatesMock.mockResolvedValueOnce({
      nodes: [{ id: "state-todo", name: "Todo" }],
    });
    // VA-394: `fetchReady` now calls `.labels()` and
    // `.inverseRelations()` on each candidate to apply eligibility
    // filters — the happy path needs to mock them returning empty
    // sets so the candidate passes the filters unchanged.
    const emptyConnection = () => Promise.resolve({ nodes: [] });
    issuesMock.mockResolvedValueOnce({
      nodes: [
        {
          id: "issue-1",
          identifier: "VA-1",
          title: "First",
          description: "an issue",
          labels: emptyConnection,
          inverseRelations: emptyConnection,
        },
        {
          id: "issue-2",
          identifier: "VA-2",
          title: "Second",
          description: null,
          labels: emptyConnection,
          inverseRelations: emptyConnection,
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
      },
      {
        id: "issue-2",
        identifier: "VA-2",
        title: "Second",
        description: "",
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
