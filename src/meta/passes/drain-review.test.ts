import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const callDrainReviewMock = vi.fn();
vi.mock("../llm.js", async () => {
  const actual = await vi.importActual<typeof import("../llm.js")>(
    "../llm.js",
  );
  return {
    ...actual,
    callDrainReview: callDrainReviewMock,
  };
});

const { runDrainReviewPass } = await import("./drain-review.js");
const { DRAIN_REVIEW_VERSION } = await import("../templates.js");

// VA-406: end-to-end contract for the Drain Review pass. We mock the
// LLM (deterministic, no network) and hand-build gateway + storage
// doubles for the dashboard / Linear / SQLite seams. Tests pin the
// observable contracts the operator and the trigger care about:
//
//   1) happy path (severity: routine) → meta-drain-review row,
//      meta-project Linear issue, NO runway-repo escalation
//   2) severity: critical → runway-repo issue with Bug + meta-promoted
//      labels, source link to drain-review
//   3) no Run Reviews exist for the drain → kind=no-run-reviews, no
//      LLM, no Linear, no SQLite write
//   4) LLM failure → meta-failed row + Linear stub
//   5) parse failure → meta-failed row + Linear stub
//   6) Linear failure after LLM success → preserved review + stub
//   7) escalation failure is best-effort — drain review still lands

interface SavedReview {
  readonly id: string;
  readonly kind: string;
  readonly scope: string;
  readonly drainId: string | null;
  readonly issueId: string | null;
  readonly contentJson: string;
  readonly templateVersion: string;
  readonly createdAt: string;
}

const buildFixtures = () => {
  const saved: SavedReview[] = [];
  const storage = {
    saveMetaReview: vi.fn((row: SavedReview) => {
      saved.push(row);
    }),
  } as unknown as import("../../dashboard/storage.js").Storage;

  // VA-406: per-drain context — two issues in the drain, both have
  // Run Review rows. The drain pass loads these via loadContextFor
  // and threads them into the user prompt.
  const issueProcesses = [
    {
      traceId: "trace-abc",
      spanId: "sp-1",
      issueIdentifier: "VA-1",
      issueId: null,
      issueTitle: "First fix",
      issueLabels: [] as readonly string[],
      branch: null,
      outcomeKind: "opened",
      outcomeDetail: "PR #100",
      prUrl: null,
      hitlReason: null,
      startTimeUnixNano: "1",
      endTimeUnixNano: "2",
    },
    {
      traceId: "trace-abc",
      spanId: "sp-2",
      issueIdentifier: "VA-2",
      issueId: null,
      issueTitle: "Second fix",
      issueLabels: [],
      branch: null,
      outcomeKind: "hitl",
      outcomeDetail: "Sub-agent review rejected",
      prUrl: null,
      hitlReason: "Reviewer disagreed with itself",
      startTimeUnixNano: "3",
      endTimeUnixNano: "4",
    },
  ];

  const metaRows = [
    {
      id: "row-va-1",
      kind: "meta-run-review",
      issueId: "VA-1",
      contentJson: JSON.stringify({
        review: { issue_identifier: "VA-1", final_outcome: "opened" },
        linear_url: "https://linear.app/x/issue/VA-1001",
      }),
      templateVersion: "1.2.0",
      createdAt: "2026-05-16 12:00:01",
    },
    {
      id: "row-va-2",
      kind: "meta-run-review",
      issueId: "VA-2",
      contentJson: JSON.stringify({
        review: { issue_identifier: "VA-2", final_outcome: "hitl" },
        linear_url: "https://linear.app/x/issue/VA-1002",
      }),
      templateVersion: "1.2.0",
      createdAt: "2026-05-16 12:00:02",
    },
  ];

  const dashboardRead = {
    loadIssueProcessesForDrain: vi.fn(() => Effect.succeed(issueProcesses)),
    loadDrainMetaRows: vi.fn(() => Effect.succeed(metaRows)),
  } as unknown as import("../dashboard-read.js").MetaDashboardRead;

  const metaLinear = {
    ensureMetaProject: vi.fn(() => Effect.succeed("proj-1")),
    createDrainReviewIssue: vi.fn(() =>
      Effect.succeed({
        identifier: "VA-2001",
        url: "https://linear.app/x/issue/VA-2001",
      }),
    ),
    createRunwayRepoIssue: vi.fn(() =>
      Effect.succeed({
        identifier: "VA-3001",
        url: "https://linear.app/x/issue/VA-3001",
      }),
    ),
  } as unknown as import("../linear-meta.js").MetaLinearGateway;

  return { saved, storage, dashboardRead, metaLinear };
};

const validRoutine = {
  template_version: DRAIN_REVIEW_VERSION,
  drain_trace_id: "trace-abc",
  issue_count: 2,
  outcomes_summary: { opened: 1, hitl: 1 },
  sequencing_assessment: "Two unrelated fixes; order was fine.",
  cross_issue_patterns: ["Both touched dashboard/."],
  notable_events: [
    {
      issue_identifier: "VA-2",
      event: "HITL escape; reviewer disagreed with itself.",
      run_review_url: "https://linear.app/x/issue/VA-1002",
    },
  ],
  recommendations: [
    {
      target: "prompt",
      change: "Reviewer prompt needs consistency rule.",
      confidence: "MEDIUM",
    },
  ],
  severity: "routine",
  severity_justification:
    "HITL was the safety valve working — recoverable judgement call.",
};

const validCritical = {
  ...validRoutine,
  severity: "critical",
  severity_justification: "Orchestrator silently dropped two captured reports.",
  recommendations: [
    {
      target: "tooling",
      change: "Add a flush-verification step before orchestrator exits.",
      confidence: "HIGH",
    },
  ],
};

beforeEach(() => {
  callDrainReviewMock.mockReset();
});

describe("runDrainReviewPass (VA-406)", () => {
  it("writes a meta-drain-review row + meta-project Linear issue on the routine happy path; NO runway-repo escalation", async () => {
    callDrainReviewMock.mockReturnValueOnce(
      Effect.succeed({ ok: true, report: validRoutine }),
    );
    const f = buildFixtures();

    const outcome = await Effect.runPromise(
      runDrainReviewPass(
        { traceId: "trace-abc" },
        {
          anthropicApiKey: "test-key",
          metaReviewModel: "claude-sonnet-4-6",
          dashboardRead: f.dashboardRead,
          metaLinear: f.metaLinear,
          storage: f.storage,
        },
      ),
    );

    expect(outcome.kind).toBe("review");
    if (outcome.kind !== "review") return;
    expect(outcome.severity).toBe("routine");
    expect(outcome.linearIdentifier).toBe("VA-2001");
    expect(outcome.escalationIdentifier).toBeNull();
    expect(outcome.escalationUrl).toBeNull();
    expect(f.saved).toHaveLength(1);
    expect(f.saved[0]?.kind).toBe("meta-drain-review");
    expect(f.saved[0]?.drainId).toBe("trace-abc");
    expect(f.saved[0]?.issueId).toBeNull();
    expect(f.saved[0]?.templateVersion).toBe(DRAIN_REVIEW_VERSION);
    expect(f.metaLinear.createDrainReviewIssue).toHaveBeenCalledTimes(1);
    // Severity: routine → escalation is NOT called.
    expect(f.metaLinear.createRunwayRepoIssue).not.toHaveBeenCalled();
  });

  it("files a runway-repo escalation issue with Bug + runway-meta-promoted labels on severity: critical", async () => {
    callDrainReviewMock.mockReturnValueOnce(
      Effect.succeed({ ok: true, report: validCritical }),
    );
    const f = buildFixtures();

    const outcome = await Effect.runPromise(
      runDrainReviewPass(
        { traceId: "trace-abc" },
        {
          anthropicApiKey: "test-key",
          metaReviewModel: "claude-sonnet-4-6",
          dashboardRead: f.dashboardRead,
          metaLinear: f.metaLinear,
          storage: f.storage,
        },
      ),
    );

    expect(outcome.kind).toBe("review");
    if (outcome.kind !== "review") return;
    expect(outcome.severity).toBe("critical");
    expect(outcome.escalationIdentifier).toBe("VA-3001");
    expect(outcome.escalationUrl).toContain("VA-3001");
    expect(f.metaLinear.createRunwayRepoIssue).toHaveBeenCalledTimes(1);
    const escCall = (
      f.metaLinear.createRunwayRepoIssue as ReturnType<typeof vi.fn>
    ).mock.calls[0]?.[0];
    expect(escCall?.labels).toEqual(["Bug", "runway-meta-promoted"]);
    // Body cross-links to the drain-review issue created in
    // runway-meta — the operator follows the link from the escalation
    // back to the full review.
    expect(escCall?.body).toContain("VA-2001");
    expect(escCall?.body).toMatch(/Drain Review for drain/);

    // SQLite content_json records both Linear writes for the dashboard.
    const content = JSON.parse(f.saved[0]?.contentJson ?? "{}");
    expect(content.escalation_identifier).toBe("VA-3001");
    expect(content.linear_issue_identifier).toBe("VA-2001");
  });

  it("returns kind=no-run-reviews when the drain has no per-issue meta_reviews — no LLM, no Linear, no SQLite", async () => {
    const f = buildFixtures();
    f.dashboardRead.loadDrainMetaRows = vi.fn(() =>
      Effect.succeed([]),
    ) as unknown as typeof f.dashboardRead.loadDrainMetaRows;

    const outcome = await Effect.runPromise(
      runDrainReviewPass(
        { traceId: "trace-abc" },
        {
          anthropicApiKey: "test-key",
          metaReviewModel: "claude-sonnet-4-6",
          dashboardRead: f.dashboardRead,
          metaLinear: f.metaLinear,
          storage: f.storage,
        },
      ),
    );

    expect(outcome.kind).toBe("no-run-reviews");
    if (outcome.kind !== "no-run-reviews") return;
    expect(outcome.reason).toMatch(/no completed Run Reviews/);
    expect(callDrainReviewMock).not.toHaveBeenCalled();
    expect(f.metaLinear.createDrainReviewIssue).not.toHaveBeenCalled();
    expect(f.saved).toHaveLength(0);
  });

  it("writes a meta-failed stub + Linear stub when the LLM exhausts its retry budget", async () => {
    callDrainReviewMock.mockReturnValueOnce(
      Effect.fail({
        _tag: "AnthropicServerError" as const,
        status: 503,
        message: "service unavailable",
      }),
    );
    const f = buildFixtures();

    const outcome = await Effect.runPromise(
      runDrainReviewPass(
        { traceId: "trace-abc" },
        {
          anthropicApiKey: "test-key",
          metaReviewModel: "claude-sonnet-4-6",
          dashboardRead: f.dashboardRead,
          metaLinear: f.metaLinear,
          storage: f.storage,
        },
      ),
    );

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason).toContain("LLM call failed");
    expect(f.saved).toHaveLength(1);
    expect(f.saved[0]?.kind).toBe("meta-failed");
    expect(f.saved[0]?.drainId).toBe("trace-abc");
    expect(f.metaLinear.createDrainReviewIssue).toHaveBeenCalledTimes(1);
    const stubCall = (
      f.metaLinear.createDrainReviewIssue as ReturnType<typeof vi.fn>
    ).mock.calls[0]?.[0];
    expect(stubCall?.title).toMatch(/Drain Review FAILED/);
    // Critical: escalation is NEVER called on a failure path —
    // there's no parsed severity yet.
    expect(f.metaLinear.createRunwayRepoIssue).not.toHaveBeenCalled();
  });

  it("writes a meta-failed stub when the LLM response fails parse (no retry)", async () => {
    callDrainReviewMock.mockReturnValueOnce(
      Effect.succeed({
        ok: false,
        error: {
          kind: "schema-mismatch" as const,
          message: "severity: invalid_enum_value",
        },
      }),
    );
    const f = buildFixtures();

    const outcome = await Effect.runPromise(
      runDrainReviewPass(
        { traceId: "trace-abc" },
        {
          anthropicApiKey: "test-key",
          metaReviewModel: "claude-sonnet-4-6",
          dashboardRead: f.dashboardRead,
          metaLinear: f.metaLinear,
          storage: f.storage,
        },
      ),
    );

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason).toContain("schema-mismatch");
    expect(f.saved[0]?.kind).toBe("meta-failed");
    expect(callDrainReviewMock).toHaveBeenCalledTimes(1);
  });

  it("preserves the parsed Review + records secondary linear failure when Linear writes fail end-to-end", async () => {
    callDrainReviewMock.mockReturnValueOnce(
      Effect.succeed({ ok: true, report: validRoutine }),
    );
    const f = buildFixtures();
    f.metaLinear.createDrainReviewIssue = vi.fn(() =>
      Effect.fail({ _tag: "LinearNetworkError" as const, message: "boom" }),
    ) as unknown as typeof f.metaLinear.createDrainReviewIssue;

    const outcome = await Effect.runPromise(
      runDrainReviewPass(
        { traceId: "trace-abc" },
        {
          anthropicApiKey: "test-key",
          metaReviewModel: "claude-sonnet-4-6",
          dashboardRead: f.dashboardRead,
          metaLinear: f.metaLinear,
          storage: f.storage,
        },
      ),
    );

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason).toContain("Linear issue create failed");
    const content = JSON.parse(f.saved[0]?.contentJson ?? "{}");
    expect(content.preserved_review).not.toBeNull();
    expect(content.preserved_review.drain_trace_id).toBe("trace-abc");
    expect(content.secondary_linear_error).toContain("boom");
  });

  it("treats escalation write failure as best-effort — drain review still lands cleanly", async () => {
    callDrainReviewMock.mockReturnValueOnce(
      Effect.succeed({ ok: true, report: validCritical }),
    );
    const f = buildFixtures();
    f.metaLinear.createRunwayRepoIssue = vi.fn(() =>
      Effect.fail({
        _tag: "LinearNetworkError" as const,
        message: "runway-repo project unreachable",
      }),
    ) as unknown as typeof f.metaLinear.createRunwayRepoIssue;

    const outcome = await Effect.runPromise(
      runDrainReviewPass(
        { traceId: "trace-abc" },
        {
          anthropicApiKey: "test-key",
          metaReviewModel: "claude-sonnet-4-6",
          dashboardRead: f.dashboardRead,
          metaLinear: f.metaLinear,
          storage: f.storage,
        },
      ),
    );

    expect(outcome.kind).toBe("review");
    if (outcome.kind !== "review") return;
    expect(outcome.severity).toBe("critical");
    // Escalation failed — identifiers are null but the drain review
    // landed.
    expect(outcome.escalationIdentifier).toBeNull();
    expect(outcome.escalationUrl).toBeNull();
    expect(outcome.linearIdentifier).toBe("VA-2001");
    // The escalation gap is recorded in content_json for debugging.
    const content = JSON.parse(f.saved[0]?.contentJson ?? "{}");
    expect(content.escalation_error).toContain("runway-repo project unreachable");
  });

  it("passes the gathered issue_processes + meta rows into the LLM user prompt", async () => {
    callDrainReviewMock.mockReturnValueOnce(
      Effect.succeed({ ok: true, report: validRoutine }),
    );
    const f = buildFixtures();

    await Effect.runPromise(
      runDrainReviewPass(
        { traceId: "trace-abc" },
        {
          anthropicApiKey: "test-key",
          metaReviewModel: "claude-sonnet-4-6",
          dashboardRead: f.dashboardRead,
          metaLinear: f.metaLinear,
          storage: f.storage,
        },
      ),
    );

    const llmCall = callDrainReviewMock.mock.calls[0]?.[0] as
      | { userPrompt?: string }
      | undefined;
    expect(llmCall?.userPrompt).toContain("VA-1");
    expect(llmCall?.userPrompt).toContain("VA-2");
    expect(llmCall?.userPrompt).toContain("Issue process count: 2");
    expect(llmCall?.userPrompt).toContain("meta-run-review");
    // The per-issue meta row content is included verbatim so the IRA
    // can ground its grade on the actual Run Review verdicts.
    expect(llmCall?.userPrompt).toContain("final_outcome");
  });
});
