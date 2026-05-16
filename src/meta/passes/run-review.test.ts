import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const callRunReviewMock = vi.fn();
vi.mock("../llm.js", async () => {
  const actual = await vi.importActual<typeof import("../llm.js")>(
    "../llm.js",
  );
  return {
    ...actual,
    callRunReview: callRunReviewMock,
  };
});

const { runRunReviewPass } = await import("./run-review.js");
const { RUN_REVIEW_VERSION } = await import("../templates.js");

// VA-402: end-to-end contract for the Run Review pass. We mock the
// LLM call (deterministic, no network) and pass hand-built gateway
// + storage doubles for the dashboard / Linear / SQLite seams. The
// tests pin the three outcomes the pass owns:
//
//   1) happy path → Linear issue created + meta_reviews row of kind
//      `meta-run-review`
//   2) LLM call failed after retry → meta_reviews row of kind
//      `meta-failed`, NO Linear issue
//   3) LLM responded with malformed payload → same `meta-failed`
//      stub but the LLM's raw response is preserved when possible

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

  const captured = {
    spanId: "span-issue-process",
    issueIdentifier: "VA-401",
    issueTitle: "Structured agent reports",
    issueLabels: ["Feature"] as readonly string[],
    outcomeKind: "opened",
    outcomeDetail: "https://github.com/x/y/pull/103",
    prUrl: "https://github.com/x/y/pull/103",
    hitlReason: null,
    branch: "agent/va-401",
    issueId: "issue-abc",
    traceId: "trace-abc",
    startTimeUnixNano: "1",
    endTimeUnixNano: "2",
  };

  const dashboardRead = {
    loadIssueProcess: vi.fn(() => Effect.succeed(captured)),
    // VA-403: loadDrainEndTime is the delay-gate input. The default
    // mock returns null ("unknown") so existing happy/failure-path
    // tests pass `delayHours: 0` to bypass the gate entirely.
    loadDrainEndTime: vi.fn(() => Effect.succeed(null)),
    loadCodingAgentReport: vi.fn(() =>
      Effect.succeed({
        ok: true as const,
        iterationIndex: 1,
        templateVersion: "1.0.0",
        payload: JSON.stringify({ approach: "fixture" }),
      }),
    ),
    loadReviewerReport: vi.fn(() =>
      Effect.succeed({
        ok: true as const,
        templateVersion: "1.0.0",
        payload: JSON.stringify({ verdict: "APPROVE" }),
      }),
    ),
  } as unknown as import("../dashboard-read.js").MetaDashboardRead;

  const metaLinear = {
    ensureMetaProject: vi.fn(() => Effect.succeed("proj-1")),
    createRunReviewIssue: vi.fn(() =>
      Effect.succeed({
        identifier: "VA-1001",
        url: "https://linear.app/x/issue/VA-1001",
      }),
    ),
  } as unknown as import("../linear-meta.js").MetaLinearGateway;

  return { saved, storage, dashboardRead, metaLinear };
};

const validReview = {
  template_version: RUN_REVIEW_VERSION,
  issue_identifier: "VA-401",
  drain_trace_id: "trace-abc",
  final_outcome: "opened",
  issue_quality: { absolute: "STRONG", relative: null, justification: "x" },
  prompt_quality: { absolute: "ADEQUATE", relative: null, justification: "x" },
  agent_quality: { absolute: "STRONG", relative: null, justification: "x" },
  reviewer_quality: { absolute: "STRONG", relative: null, justification: "x" },
  orchestration_quality: {
    absolute: "STRONG",
    relative: null,
    justification: "x",
  },
  recommendations: [],
  hindsight_signals: null,
};

beforeEach(() => {
  callRunReviewMock.mockReset();
});

describe("runRunReviewPass (VA-402)", () => {
  it("writes a meta-run-review row and creates a Linear issue on the happy path", async () => {
    callRunReviewMock.mockReturnValueOnce(
      Effect.succeed({ ok: true, report: validReview }),
    );
    const f = buildFixtures();

    const outcome = await Effect.runPromise(
      runRunReviewPass(
        { traceId: "trace-abc", issueIdentifier: "VA-401" },
        {
          anthropicApiKey: "test-key",
          metaReviewModel: "claude-sonnet-4-6",
          dashboardRead: f.dashboardRead,
          metaLinear: f.metaLinear,
          storage: f.storage,
          // VA-403: bypass the delay gate — these tests focus on
          // the LLM / persistence paths, not on age checking.
          delayHours: 0,
        },
      ),
    );

    expect(outcome.kind).toBe("review");
    if (outcome.kind !== "review") return;
    expect(outcome.linearIdentifier).toBe("VA-1001");
    expect(outcome.linearUrl).toMatch(/linear\.app/);
    expect(f.saved).toHaveLength(1);
    expect(f.saved[0]?.kind).toBe("meta-run-review");
    expect(f.saved[0]?.drainId).toBe("trace-abc");
    expect(f.saved[0]?.issueId).toBe("VA-401");
    expect(f.saved[0]?.templateVersion).toBe(RUN_REVIEW_VERSION);
    // Linear write was the path that produced VA-1001.
    expect(f.metaLinear.createRunReviewIssue).toHaveBeenCalledTimes(1);
  });

  it("writes a meta-failed stub + a Linear stub when the LLM call exhausts its retry budget", async () => {
    callRunReviewMock.mockReturnValueOnce(
      Effect.fail({
        _tag: "AnthropicServerError" as const,
        status: 503,
        message: "service unavailable",
      }),
    );
    const f = buildFixtures();

    const outcome = await Effect.runPromise(
      runRunReviewPass(
        { traceId: "trace-abc", issueIdentifier: "VA-401" },
        {
          anthropicApiKey: "test-key",
          metaReviewModel: "claude-sonnet-4-6",
          dashboardRead: f.dashboardRead,
          metaLinear: f.metaLinear,
          storage: f.storage,
          // VA-403: bypass the delay gate — these tests focus on
          // the LLM / persistence paths, not on age checking.
          delayHours: 0,
        },
      ),
    );

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason).toContain("LLM call failed");
    expect(f.saved).toHaveLength(1);
    expect(f.saved[0]?.kind).toBe("meta-failed");
    // VA-402 AC: retry-exhaustion writes BOTH a SQLite stub AND a
    // Linear stub in `runway-meta` — the operator sees the gap in
    // the meta-project view too.
    expect(f.metaLinear.createRunReviewIssue).toHaveBeenCalledTimes(1);
    const stubCall = (
      f.metaLinear.createRunReviewIssue as ReturnType<typeof vi.fn>
    ).mock.calls[0]?.[0];
    expect(stubCall?.title).toMatch(/Run Review FAILED/);
    // The stub row cross-links to the Linear stub via its content.
    const content = JSON.parse(f.saved[0]?.contentJson ?? "{}");
    expect(content.linear_stub_identifier).toBe("VA-1001");
  });

  it("writes a meta-failed stub when the LLM response fails parse (no retry on parse error)", async () => {
    callRunReviewMock.mockReturnValueOnce(
      Effect.succeed({
        ok: false,
        error: {
          kind: "schema-mismatch" as const,
          message: "agent_quality.absolute: invalid_enum_value",
        },
      }),
    );
    const f = buildFixtures();

    const outcome = await Effect.runPromise(
      runRunReviewPass(
        { traceId: "trace-abc", issueIdentifier: "VA-401" },
        {
          anthropicApiKey: "test-key",
          metaReviewModel: "claude-sonnet-4-6",
          dashboardRead: f.dashboardRead,
          metaLinear: f.metaLinear,
          storage: f.storage,
          // VA-403: bypass the delay gate — these tests focus on
          // the LLM / persistence paths, not on age checking.
          delayHours: 0,
        },
      ),
    );

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason).toContain("schema-mismatch");
    expect(f.saved[0]?.kind).toBe("meta-failed");
    // Parse failure is NOT retryable — the LLM call only fires once.
    expect(callRunReviewMock).toHaveBeenCalledTimes(1);
    // Parse failure still produces a Linear stub so the gap shows up
    // in the meta-project view.
    expect(f.metaLinear.createRunReviewIssue).toHaveBeenCalledTimes(1);
  });

  it("preserves the parsed Review + records secondary linear failure when Linear writes fail end-to-end", async () => {
    callRunReviewMock.mockReturnValueOnce(
      Effect.succeed({ ok: true, report: validReview }),
    );
    const f = buildFixtures();
    f.metaLinear.createRunReviewIssue = vi.fn(() =>
      Effect.fail({ _tag: "LinearNetworkError" as const, message: "boom" }),
    ) as unknown as typeof f.metaLinear.createRunReviewIssue;

    const outcome = await Effect.runPromise(
      runRunReviewPass(
        { traceId: "trace-abc", issueIdentifier: "VA-401" },
        {
          anthropicApiKey: "test-key",
          metaReviewModel: "claude-sonnet-4-6",
          dashboardRead: f.dashboardRead,
          metaLinear: f.metaLinear,
          storage: f.storage,
          // VA-403: bypass the delay gate — these tests focus on
          // the LLM / persistence paths, not on age checking.
          delayHours: 0,
        },
      ),
    );

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason).toContain("Linear issue create failed");
    const content = JSON.parse(f.saved[0]?.contentJson ?? "{}");
    expect(content.preserved_review).not.toBeNull();
    expect(content.preserved_review.issue_identifier).toBe("VA-401");
    // Linear was called twice — once for the success-path issue
    // (failed) and once for the failure-path stub (also failed in
    // this fixture). The SQLite row records the secondary failure
    // so the operator can debug.
    expect(f.metaLinear.createRunReviewIssue).toHaveBeenCalledTimes(2);
    expect(content.secondary_linear_error).toContain("boom");
    expect(content.linear_stub_identifier).toBeNull();
  });

  it("stubs out when the issue_process row hasn't been observed yet", async () => {
    const f = buildFixtures();
    f.dashboardRead.loadIssueProcess = vi.fn(() =>
      Effect.fail({
        _tag: "MetaReadIssueProcessNotFound" as const,
        traceId: "trace-missing",
        issueIdentifier: "VA-401",
        message: "no issue_processes row for trace=trace-missing, issue=VA-401",
      }),
    ) as unknown as typeof f.dashboardRead.loadIssueProcess;

    const outcome = await Effect.runPromise(
      runRunReviewPass(
        { traceId: "trace-missing", issueIdentifier: "VA-401" },
        {
          anthropicApiKey: "test-key",
          metaReviewModel: "claude-sonnet-4-6",
          dashboardRead: f.dashboardRead,
          metaLinear: f.metaLinear,
          storage: f.storage,
          // VA-403: bypass the delay gate — these tests focus on
          // the LLM / persistence paths, not on age checking.
          delayHours: 0,
        },
      ),
    );

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason).toContain("failed to load context");
    expect(f.saved[0]?.kind).toBe("meta-failed");
    // LLM should never have been called.
    expect(callRunReviewMock).not.toHaveBeenCalled();
    // Linear stub still lands so the gap appears in the meta-project.
    expect(f.metaLinear.createRunReviewIssue).toHaveBeenCalledTimes(1);
  });

  // VA-403: delay gate. Drain end-time loaded from dashboard-read;
  // compared against now - delayHours. Younger drains short-circuit
  // with a `delayed` outcome, no LLM / Linear / SQLite write.

  it("returns kind=delayed without calling Anthropic when drain is younger than delayHours", async () => {
    const f = buildFixtures();
    // Drain ended 2 hours ago — younger than the 18h default.
    const twoHoursAgoNs = String(
      BigInt(Date.now() - 2 * 3_600 * 1000) * BigInt(1_000_000),
    );
    f.dashboardRead.loadDrainEndTime = vi.fn(() =>
      Effect.succeed(twoHoursAgoNs),
    ) as unknown as typeof f.dashboardRead.loadDrainEndTime;

    const outcome = await Effect.runPromise(
      runRunReviewPass(
        { traceId: "trace-fresh", issueIdentifier: "VA-401" },
        {
          anthropicApiKey: "test-key",
          metaReviewModel: "claude-sonnet-4-6",
          dashboardRead: f.dashboardRead,
          metaLinear: f.metaLinear,
          storage: f.storage,
          // omit delayHours → defaults to 18
        },
      ),
    );

    expect(outcome.kind).toBe("delayed");
    if (outcome.kind !== "delayed") return;
    expect(outcome.thresholdHours).toBe(18);
    expect(outcome.drainAgeHours).toBeGreaterThanOrEqual(1.5);
    expect(outcome.drainAgeHours).toBeLessThan(3);
    // No Anthropic call, no Linear write, no SQLite row.
    expect(callRunReviewMock).not.toHaveBeenCalled();
    expect(f.metaLinear.createRunReviewIssue).not.toHaveBeenCalled();
    expect(f.saved).toHaveLength(0);
  });

  it("proceeds normally when drain is older than delayHours", async () => {
    const f = buildFixtures();
    // Drain ended 24 hours ago — older than 18h default.
    const dayAgoNs = String(
      BigInt(Date.now() - 24 * 3_600 * 1000) * BigInt(1_000_000),
    );
    f.dashboardRead.loadDrainEndTime = vi.fn(() =>
      Effect.succeed(dayAgoNs),
    ) as unknown as typeof f.dashboardRead.loadDrainEndTime;
    callRunReviewMock.mockReturnValueOnce(
      Effect.succeed({ ok: true, report: validReview }),
    );

    const outcome = await Effect.runPromise(
      runRunReviewPass(
        { traceId: "trace-mature", issueIdentifier: "VA-401" },
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
    expect(callRunReviewMock).toHaveBeenCalledTimes(1);
  });

  it("bypasses the delay gate when force=true (operator --force)", async () => {
    const f = buildFixtures();
    // Drain literally just ended.
    const justNowNs = String(BigInt(Date.now()) * BigInt(1_000_000));
    f.dashboardRead.loadDrainEndTime = vi.fn(() =>
      Effect.succeed(justNowNs),
    ) as unknown as typeof f.dashboardRead.loadDrainEndTime;
    callRunReviewMock.mockReturnValueOnce(
      Effect.succeed({ ok: true, report: validReview }),
    );

    const outcome = await Effect.runPromise(
      runRunReviewPass(
        { traceId: "trace-fresh", issueIdentifier: "VA-401" },
        {
          anthropicApiKey: "test-key",
          metaReviewModel: "claude-sonnet-4-6",
          dashboardRead: f.dashboardRead,
          metaLinear: f.metaLinear,
          storage: f.storage,
          force: true,
        },
      ),
    );

    expect(outcome.kind).toBe("review");
  });

  it("treats unknown drain age as fresh (loadDrainEndTime returns null → delayed)", async () => {
    const f = buildFixtures();
    f.dashboardRead.loadDrainEndTime = vi.fn(() =>
      Effect.succeed(null),
    ) as unknown as typeof f.dashboardRead.loadDrainEndTime;

    const outcome = await Effect.runPromise(
      runRunReviewPass(
        { traceId: "trace-unknown", issueIdentifier: "VA-401" },
        {
          anthropicApiKey: "test-key",
          metaReviewModel: "claude-sonnet-4-6",
          dashboardRead: f.dashboardRead,
          metaLinear: f.metaLinear,
          storage: f.storage,
          // default delayHours = 18, default force = false
        },
      ),
    );

    expect(outcome.kind).toBe("delayed");
    expect(callRunReviewMock).not.toHaveBeenCalled();
  });

  // VA-403: hindsight wiring. The pass passes ctx.hindsightSignals
  // into composeUserPrompt; we verify the LLM was called with a
  // prompt that mentions the hindsight section.

  it("includes hindsight signals in the LLM user prompt when wired", async () => {
    const f = buildFixtures();
    callRunReviewMock.mockReturnValueOnce(
      Effect.succeed({ ok: true, report: validReview }),
    );
    const github = {
      fetchPrState: vi.fn(() =>
        Effect.succeed({
          url: "https://github.com/x/y/pull/103",
          state: "merged" as const,
          mergedAt: "2026-05-15T01:23Z",
          humanComments: [],
        }),
      ),
    };
    const linear = {
      findFollowUpIssues: vi.fn(() => Effect.succeed([])),
    };

    await Effect.runPromise(
      runRunReviewPass(
        { traceId: "trace-abc", issueIdentifier: "VA-401" },
        {
          anthropicApiKey: "test-key",
          metaReviewModel: "claude-sonnet-4-6",
          dashboardRead: f.dashboardRead,
          metaLinear: f.metaLinear,
          storage: f.storage,
          hindsight: { github, linear },
          delayHours: 0,
        },
      ),
    );

    expect(callRunReviewMock).toHaveBeenCalledTimes(1);
    const llmCall = callRunReviewMock.mock.calls[0]?.[0] as
      | { userPrompt?: string }
      | undefined;
    expect(llmCall?.userPrompt).toContain("# Hindsight signals");
    expect(llmCall?.userPrompt).toContain('"state": "merged"');
  });
});
