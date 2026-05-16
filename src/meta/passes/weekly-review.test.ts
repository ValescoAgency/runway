import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Data, Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const callWeeklyReviewMock = vi.fn();
vi.mock("../llm.js", async () => {
  const actual = await vi.importActual<typeof import("../llm.js")>(
    "../llm.js",
  );
  return {
    ...actual,
    callWeeklyReview: callWeeklyReviewMock,
  };
});

const { runWeeklyReviewPass } = await import("./weekly-review.js");
const { WEEKLY_REVIEW_VERSION } = await import("../templates.js");

// VA-408: pass tests cover the contracts the operator and the cron
// scheduler observe:
//   1) Happy path: candidate promotion → runway-repo issue with
//      Bug/Feature/Improvement + runway-meta-promoted labels +
//      theme-key HTML comment; Weekly Review issue lands in
//      runway-meta; meta-weekly-review row written.
//   2) LLM retry exhaustion → kind=failed-loud, NO Linear stub, NO
//      meta-failed row (the loud non-zero exit IS the signal).
//   3) Parse failure → kind=failed-loud, same no-stub contract.
//   4) Empty window → kind=no-reviews, no LLM, no Linear, no SQLite.
//   5) Partial Linear failure: one promotion fails → review still
//      lands with promotionsFiled < promotionsPlanned.

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

class FakeAnthropicError extends Data.TaggedError("FakeAnthropicError")<{
  readonly message: string;
}> {}

const validReview = (overrides: Record<string, unknown> = {}) => ({
  template_version: WEEKLY_REVIEW_VERSION,
  time_window: {
    start_iso: "2026-05-09T00:00:00.000Z",
    end_iso: "2026-05-16T00:00:00.000Z",
  },
  rates: {
    throughput: 12,
    success_pct: 75,
    hitl_pct: 8.3,
    revert_pct: 0,
    infra_error_pct: 0,
  },
  rates_delta_vs_prior_week: null,
  narrative: "Steady week. Two emergent patterns worth promoting.",
  recurring_themes: [],
  promotions: [
    {
      theme_key:
        "prompt:tighten reviewer rejection guidance for refactor:abcd1234",
      target: "prompt" as const,
      category: "Improvement" as const,
      title: "Tighten reviewer rejection guidance",
      change_spec:
        "Reviewer prompt should require an explicit category for every REJECT.",
      acceptance_criteria: [
        "Reviewer report carries a `rejection_category` field on REJECT.",
        "Prompt enforces one of {scope|quality|test|infra}.",
      ],
      // Match the fixture's content_json so the body renders
      // hyperlinks (not plain text). VA-408 AC: source meta-issue
      // links must be clickable in the promoted issue body.
      source_meta_review_identifiers: ["VA-1001", "VA-1002"],
      predicted_effect: {
        claim: "Reviewer rejection-to-fix iteration count drops 20% vs baseline",
        min_sample_size: 10,
        sample_description: "post-ship runs of refactor-class issues",
      },
      corroboration_count: 2,
      recommendation_confidence: "MEDIUM" as const,
    },
  ],
  noted_but_not_promoted: [],
  ...overrides,
});

const buildFixtures = (
  runReviewContent: readonly Record<string, unknown>[] = [
    {
      review: {
        issue_identifier: "VA-1",
        recommendations: [
          {
            target: "prompt",
            change: "tighten reviewer rejection guidance for refactor issues",
            confidence: "MEDIUM",
          },
        ],
      },
      // VA-408 AC: Run Review pass writes the Linear cross-link
      // alongside the parsed review so downstream passes can render
      // markdown source links. Match the shape `run-review.ts` emits.
      linear_issue_identifier: "VA-1001",
      linear_url: "https://linear.app/x/issue/VA-1001",
    },
    {
      review: {
        issue_identifier: "VA-2",
        recommendations: [
          {
            target: "prompt",
            change: "tighten reviewer rejection guidance for refactor issues",
            confidence: "HIGH",
          },
        ],
      },
      linear_issue_identifier: "VA-1002",
      linear_url: "https://linear.app/x/issue/VA-1002",
    },
  ],
) => {
  const saved: SavedReview[] = [];
  const storage = {
    saveMetaReview: vi.fn((row: SavedReview) => {
      saved.push(row);
    }),
  } as unknown as import("../../dashboard/storage.js").Storage;

  const runReviewRows = runReviewContent.map((c, i) => ({
    id: `meta-run-review-${i + 1}`,
    kind: "meta-run-review",
    drainId: "trace-1",
    issueId: `VA-${i + 1}`,
    contentJson: JSON.stringify(c),
    templateVersion: "1.2.0",
    createdAt: `2026-05-${(10 + i).toString().padStart(2, "0")} 00:00:00`,
  }));

  const dashboardRead = {
    loadRunReviewsInWindow: vi.fn(() => Effect.succeed(runReviewRows)),
    loadDrainReviewsInWindow: vi.fn(() => Effect.succeed([])),
    loadRecentWeeklyReviews: vi.fn(() => Effect.succeed([])),
  } as unknown as import("../dashboard-read.js").MetaDashboardRead;

  const promotionResults: Array<{ identifier: string; url: string }> = [
    { identifier: "VA-3001", url: "https://linear.app/x/issue/VA-3001" },
    { identifier: "VA-3002", url: "https://linear.app/x/issue/VA-3002" },
    { identifier: "VA-3003", url: "https://linear.app/x/issue/VA-3003" },
    { identifier: "VA-3004", url: "https://linear.app/x/issue/VA-3004" },
    { identifier: "VA-3005", url: "https://linear.app/x/issue/VA-3005" },
  ];
  let promotionIx = 0;

  const createRunwayRepoIssue = vi.fn(() =>
    Effect.succeed(promotionResults[promotionIx++] ?? promotionResults[0]),
  );
  const metaLinear = {
    ensureMetaProject: vi.fn(() => Effect.succeed("proj-1")),
    createWeeklyReviewIssue: vi.fn(() =>
      Effect.succeed({
        identifier: "VA-2500",
        url: "https://linear.app/x/issue/VA-2500",
      }),
    ),
    createRunwayRepoIssue,
    listOpenPromotedQueue: vi.fn(() => Effect.succeed([])),
  } as unknown as import("../linear-meta.js").MetaLinearGateway;

  return { saved, storage, dashboardRead, metaLinear };
};

let tmpCwd: string;

beforeEach(() => {
  callWeeklyReviewMock.mockReset();
  tmpCwd = mkdtempSync(join(tmpdir(), "weekly-review-test-"));
});

afterEach(() => {
  rmSync(tmpCwd, { recursive: true, force: true });
});

describe("runWeeklyReviewPass (VA-408)", () => {
  it("happy path: writes meta-weekly-review row + runway-meta issue + N runway-repo promotions", async () => {
    callWeeklyReviewMock.mockReturnValueOnce(
      Effect.succeed({ ok: true, report: validReview() }),
    );
    const f = buildFixtures();

    const outcome = await Effect.runPromise(
      runWeeklyReviewPass(
        {
          startIso: "2026-05-09T00:00:00.000Z",
          endIso: "2026-05-16T00:00:00.000Z",
        },
        {
          anthropicApiKey: "test-key",
          metaWeeklyModel: "claude-opus-4-7",
          dashboardRead: f.dashboardRead,
          metaLinear: f.metaLinear,
          storage: f.storage,
          cwd: tmpCwd,
        },
      ),
    );

    expect(outcome.kind).toBe("review");
    if (outcome.kind !== "review") return;
    expect(outcome.promotionsFiled).toBe(1);
    expect(outcome.promotionsPlanned).toBe(1);
    expect(outcome.linearIdentifier).toBe("VA-2500");
    expect(f.saved).toHaveLength(1);
    expect(f.saved[0]?.kind).toBe("meta-weekly-review");
    expect(f.saved[0]?.templateVersion).toBe(WEEKLY_REVIEW_VERSION);
    expect(f.metaLinear.createWeeklyReviewIssue).toHaveBeenCalledTimes(1);
    expect(f.metaLinear.createRunwayRepoIssue).toHaveBeenCalledTimes(1);
    // VA-408 AC: runway-repo issue carries Bug/Feature/Improvement +
    // runway-meta-promoted labels.
    const call = (f.metaLinear.createRunwayRepoIssue as unknown as {
      mock: { calls: ReadonlyArray<ReadonlyArray<{ labels: readonly string[]; body: string }>> };
    }).mock.calls[0]?.[0];
    expect(call?.labels).toEqual(["Improvement", "runway-meta-promoted"]);
    // Theme-key marker is stamped into the body.
    expect(call?.body).toContain("runway-meta-theme-key:");
    expect(call?.body).toContain("prompt:tighten reviewer rejection");
    // VA-408 AC: source meta-issue links rendered as markdown
    // hyperlinks (not bare SQLite row ids).
    expect(call?.body).toContain(
      "[VA-1001](https://linear.app/x/issue/VA-1001)",
    );
    expect(call?.body).toContain(
      "[VA-1002](https://linear.app/x/issue/VA-1002)",
    );
  });

  it("uses Linear identifiers from content_json as promoter source ids (not SQLite row ids)", async () => {
    // Lock down the contract directly: the promoter input + the
    // user prompt must reference VA-1001 / VA-1002, not the
    // meta-run-review-N row UUIDs. The reviewer agent observed this
    // failure mode on PR #110 — this regression test prevents
    // recurrence.
    let capturedUserPrompt = "";
    callWeeklyReviewMock.mockImplementationOnce((args: { userPrompt: string }) => {
      capturedUserPrompt = args.userPrompt;
      return Effect.succeed({ ok: true, report: validReview() });
    });
    const f = buildFixtures();

    await Effect.runPromise(
      runWeeklyReviewPass(
        {
          startIso: "2026-05-09T00:00:00.000Z",
          endIso: "2026-05-16T00:00:00.000Z",
        },
        {
          anthropicApiKey: "test-key",
          metaWeeklyModel: "claude-opus-4-7",
          dashboardRead: f.dashboardRead,
          metaLinear: f.metaLinear,
          storage: f.storage,
          cwd: tmpCwd,
        },
      ),
    );

    expect(capturedUserPrompt).toContain("VA-1001");
    expect(capturedUserPrompt).toContain("VA-1002");
    // Negative: the SQLite row UUIDs must NOT leak into the prompt
    // as source identifiers.
    expect(capturedUserPrompt).not.toMatch(
      /source_meta_review_identifiers:.*meta-run-review-/,
    );
  });

  it("returns failed-loud on LLM retry exhaustion; NO Linear stub, NO meta-failed row", async () => {
    callWeeklyReviewMock.mockReturnValueOnce(
      Effect.fail(new FakeAnthropicError({ message: "anthropic down" })),
    );
    const f = buildFixtures();

    const outcome = await Effect.runPromise(
      runWeeklyReviewPass(
        {
          startIso: "2026-05-09T00:00:00.000Z",
          endIso: "2026-05-16T00:00:00.000Z",
        },
        {
          anthropicApiKey: "test-key",
          metaWeeklyModel: "claude-opus-4-7",
          dashboardRead: f.dashboardRead,
          metaLinear: f.metaLinear,
          storage: f.storage,
          cwd: tmpCwd,
        },
      ),
    );

    expect(outcome.kind).toBe("failed-loud");
    expect(f.saved).toHaveLength(0);
    expect(f.metaLinear.createWeeklyReviewIssue).not.toHaveBeenCalled();
    expect(f.metaLinear.createRunwayRepoIssue).not.toHaveBeenCalled();
  });

  it("returns failed-loud on parse failure; same no-stub contract", async () => {
    callWeeklyReviewMock.mockReturnValueOnce(
      Effect.succeed({
        ok: false,
        error: { kind: "schema-mismatch", message: "missing fields" },
      }),
    );
    const f = buildFixtures();

    const outcome = await Effect.runPromise(
      runWeeklyReviewPass(
        {
          startIso: "2026-05-09T00:00:00.000Z",
          endIso: "2026-05-16T00:00:00.000Z",
        },
        {
          anthropicApiKey: "test-key",
          metaWeeklyModel: "claude-opus-4-7",
          dashboardRead: f.dashboardRead,
          metaLinear: f.metaLinear,
          storage: f.storage,
          cwd: tmpCwd,
        },
      ),
    );

    expect(outcome.kind).toBe("failed-loud");
    expect(f.saved).toHaveLength(0);
  });

  it("returns no-reviews on an empty window; no LLM call, no Linear, no SQLite", async () => {
    const f = buildFixtures([]);
    // Override to truly empty
    (f.dashboardRead.loadRunReviewsInWindow as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      Effect.succeed([]),
    );

    const outcome = await Effect.runPromise(
      runWeeklyReviewPass(
        {
          startIso: "2026-05-09T00:00:00.000Z",
          endIso: "2026-05-16T00:00:00.000Z",
        },
        {
          anthropicApiKey: "test-key",
          metaWeeklyModel: "claude-opus-4-7",
          dashboardRead: f.dashboardRead,
          metaLinear: f.metaLinear,
          storage: f.storage,
          cwd: tmpCwd,
        },
      ),
    );

    expect(outcome.kind).toBe("no-reviews");
    expect(callWeeklyReviewMock).not.toHaveBeenCalled();
    expect(f.saved).toHaveLength(0);
    expect(f.metaLinear.createWeeklyReviewIssue).not.toHaveBeenCalled();
  });

  it("partial Linear failure: one promotion fails to file, review still lands with promotionsFiled < planned", async () => {
    // Two promotions in the LLM response — the second runway-repo
    // create fails.
    const twoPromos = validReview({
      promotions: [
        {
          theme_key: "prompt:theme-a:aaaa1111",
          target: "prompt",
          category: "Improvement",
          title: "Promotion A",
          change_spec: "spec",
          acceptance_criteria: ["a"],
          source_meta_review_identifiers: ["VA-1001"],
          predicted_effect: {
            claim: "x",
            min_sample_size: 5,
            sample_description: "samples",
          },
          corroboration_count: 2,
          recommendation_confidence: "MEDIUM",
        },
        {
          theme_key: "workflow:theme-b:bbbb2222",
          target: "workflow",
          category: "Bug",
          title: "Promotion B",
          change_spec: "spec",
          acceptance_criteria: ["b"],
          source_meta_review_identifiers: ["VA-1002"],
          predicted_effect: {
            claim: "y",
            min_sample_size: 5,
            sample_description: "samples",
          },
          corroboration_count: 2,
          recommendation_confidence: "HIGH",
        },
      ],
    });
    callWeeklyReviewMock.mockReturnValueOnce(
      Effect.succeed({ ok: true, report: twoPromos }),
    );
    const f = buildFixtures();
    let n = 0;
    (f.metaLinear.createRunwayRepoIssue as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => {
        n += 1;
        if (n === 2) {
          return Effect.fail({ _tag: "LinearNetworkError", message: "boom" } as never);
        }
        return Effect.succeed({
          identifier: `VA-${3000 + n}`,
          url: `https://linear.app/x/issue/VA-${3000 + n}`,
        });
      },
    );

    const outcome = await Effect.runPromise(
      runWeeklyReviewPass(
        {
          startIso: "2026-05-09T00:00:00.000Z",
          endIso: "2026-05-16T00:00:00.000Z",
        },
        {
          anthropicApiKey: "test-key",
          metaWeeklyModel: "claude-opus-4-7",
          dashboardRead: f.dashboardRead,
          metaLinear: f.metaLinear,
          storage: f.storage,
          cwd: tmpCwd,
        },
      ),
    );

    expect(outcome.kind).toBe("review");
    if (outcome.kind !== "review") return;
    expect(outcome.promotionsFiled).toBe(1);
    expect(outcome.promotionsPlanned).toBe(2);
    expect(f.saved).toHaveLength(1);
    const content = JSON.parse(f.saved[0]?.contentJson ?? "{}");
    expect(content.promotion_filings).toHaveLength(2);
    expect(content.promotion_filings[1].error).toBeTruthy();
  });

  it("uses metaWeeklyModel (not metaReviewModel) for the LLM call", async () => {
    callWeeklyReviewMock.mockReturnValueOnce(
      Effect.succeed({ ok: true, report: validReview() }),
    );
    const f = buildFixtures();

    await Effect.runPromise(
      runWeeklyReviewPass(
        {
          startIso: "2026-05-09T00:00:00.000Z",
          endIso: "2026-05-16T00:00:00.000Z",
        },
        {
          anthropicApiKey: "test-key",
          metaWeeklyModel: "claude-opus-4-7",
          dashboardRead: f.dashboardRead,
          metaLinear: f.metaLinear,
          storage: f.storage,
          cwd: tmpCwd,
        },
      ),
    );

    expect(callWeeklyReviewMock).toHaveBeenCalledTimes(1);
    expect(callWeeklyReviewMock.mock.calls[0]?.[0]?.model).toBe(
      "claude-opus-4-7",
    );
  });
});
