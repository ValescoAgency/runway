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
const {
  RUNWAY_META_PREDICTED_EFFECT_MARKER,
  RUNWAY_META_THEME_KEY_MARKER,
  WEEKLY_REVIEW_VERSION,
} = await import("../templates.js");

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
  shipped_promotions: [],
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
    listShippedPromotionsSince: vi.fn(() => Effect.succeed([])),
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

  // ---------------------------------------------------------------------
  // VA-409: attribution loop — *What we shipped* verdicts.
  //
  // Each verdict path on fixture data: HELD / PARTIAL / MISSED / PENDING
  // / QUALITATIVE. Asserts (a) the mechanical verdict reaches the saved
  // SQLite row + the Linear body, (b) the LLM cannot overwrite the
  // verdict, (c) `shipped_promotions` lands in the parsed report.
  // ---------------------------------------------------------------------

  // Build one promoted-issue body the attribution loop will read.
  const buildPromotedBody = (opts: {
    themeKey: string;
    predictedEffect: unknown;
    sources?: readonly string[];
  }): string => {
    const sources =
      opts.sources?.map((s) => `[${s}](https://linear.app/x/issue/${s})`).join(", ") ??
      "";
    return [
      `<!-- ${RUNWAY_META_THEME_KEY_MARKER}: ${opts.themeKey} -->`,
      `<!-- ${RUNWAY_META_PREDICTED_EFFECT_MARKER}: ${JSON.stringify(opts.predictedEffect)} -->`,
      "",
      `**Target taxonomy**: \`prompt\``,
      `**Category**: \`Improvement\``,
      `**Source meta-reviews**: ${sources}`,
      "",
      "## Predicted effect",
      "",
      `> **Claim**: x`,
      "> **Minimum sample size**: n ≥ 1 samples",
    ].join("\n");
  };

  const wireShipped = (
    f: ReturnType<typeof buildFixtures>,
    shipped: ReadonlyArray<{
      identifier: string;
      url: string;
      title: string;
      body: string;
      themeKey: string | null;
      completedAt: string;
    }>,
    postShipMetrics:
      | { value: number; sampleSize: number }
      | { value: null; sampleSize: 0 }
      | null,
  ): void => {
    // Prior weekly is the cutoff source — give the pass at least one
    // recent weekly so it knows when "since" is.
    (
      f.dashboardRead.loadRecentWeeklyReviews as unknown as ReturnType<typeof vi.fn>
    ).mockReturnValue(
      Effect.succeed([
        {
          id: "prev-weekly-1",
          kind: "meta-weekly-review",
          drainId: null,
          issueId: null,
          contentJson: "{}",
          templateVersion: "1.0.0",
          createdAt: "2026-05-08T00:00:00.000Z",
        },
      ]),
    );
    (
      f.metaLinear.listShippedPromotionsSince as unknown as ReturnType<typeof vi.fn>
    ).mockReturnValue(Effect.succeed(shipped));
    // Attach a `loadPostShipMetrics` mock — return either a populated
    // PostShipMetrics row, the null (no rows) variant, or a fake
    // attached only for tests that compute one.
    (f.dashboardRead as unknown as {
      loadPostShipMetrics: ReturnType<typeof vi.fn>;
    }).loadPostShipMetrics = vi.fn(() =>
      Effect.succeed(
        postShipMetrics === null
          ? null
          : {
              category: "VA",
              sinceIso: "2026-05-08T00:00:00.000Z",
              sampleSize: postShipMetrics.sampleSize,
              medianIterationCount: null,
              p95IterationCount: null,
              medianWallTimeMs: null,
              p95WallTimeMs: null,
              reviewerRejectionRate:
                postShipMetrics.value === null ? 0 : postShipMetrics.value,
              revertRate: 0,
              hitlEscapeRate: 0,
              infraErrorRate: 0,
            },
      ),
    );
  };

  it("HELD verdict: observed metric meets the predicted threshold", async () => {
    const f = buildFixtures();
    wireShipped(
      f,
      [
        {
          identifier: "VA-3001",
          url: "https://linear.app/x/issue/VA-3001",
          title: "Tighten reviewer rejection guidance",
          themeKey: "prompt:tighten:abcd1234",
          completedAt: "2026-05-12T00:00:00.000Z",
          body: buildPromotedBody({
            themeKey: "prompt:tighten:abcd1234",
            predictedEffect: {
              claim: "Reviewer rejection rate falls below 8%.",
              min_sample_size: 10,
              sample_description: "post-ship VA-prefixed runs",
              attribution: {
                metric: "reviewer_rejection_rate",
                baseline_value: 0.12,
                direction: "decrease",
                threshold_value: 0.08,
              },
            },
            sources: ["VA-1001"],
          }),
        },
      ],
      { value: 0.05, sampleSize: 15 },
    );
    callWeeklyReviewMock.mockReturnValueOnce(
      Effect.succeed({ ok: true, report: validReview() }),
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
    expect(outcome.shippedPromotionsGraded).toBe(1);
    const content = JSON.parse(f.saved[0]?.contentJson ?? "{}");
    const shipped = content.review.shipped_promotions;
    expect(shipped).toHaveLength(1);
    expect(shipped[0].verdict).toBe("HELD");
    expect(shipped[0].linear_identifier).toBe("VA-3001");
    expect(shipped[0].observed.value).toBe(0.05);
    expect(shipped[0].observed.sample_size).toBe(15);
    // Body carries the *What we shipped* section.
    const bodyArg = (f.metaLinear.createWeeklyReviewIssue as unknown as {
      mock: { calls: ReadonlyArray<ReadonlyArray<{ body: string }>> };
    }).mock.calls[0]?.[0]?.body;
    expect(bodyArg).toContain("## What we shipped");
    expect(bodyArg).toContain("`HELD`");
  });

  it("PARTIAL verdict: observed moved toward threshold but didn't reach", async () => {
    const f = buildFixtures();
    wireShipped(
      f,
      [
        {
          identifier: "VA-3002",
          url: "https://linear.app/x/issue/VA-3002",
          title: "Partial improvement",
          themeKey: "prompt:partial:bbbb2222",
          completedAt: "2026-05-12T00:00:00.000Z",
          body: buildPromotedBody({
            themeKey: "prompt:partial:bbbb2222",
            predictedEffect: {
              claim: "Rejection rate falls below 8%.",
              min_sample_size: 10,
              sample_description: "post-ship runs",
              attribution: {
                metric: "reviewer_rejection_rate",
                baseline_value: 0.12,
                direction: "decrease",
                threshold_value: 0.08,
              },
            },
          }),
        },
      ],
      { value: 0.1, sampleSize: 12 }, // 0.12 → 0.1 → past baseline, not under 0.08
    );
    callWeeklyReviewMock.mockReturnValueOnce(
      Effect.succeed({ ok: true, report: validReview() }),
    );

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

    const content = JSON.parse(f.saved[0]?.contentJson ?? "{}");
    expect(content.review.shipped_promotions[0].verdict).toBe("PARTIAL");
  });

  it("MISSED verdict: observed did not move past baseline", async () => {
    const f = buildFixtures();
    wireShipped(
      f,
      [
        {
          identifier: "VA-3003",
          url: "https://linear.app/x/issue/VA-3003",
          title: "Missed change",
          themeKey: "prompt:missed:cccc3333",
          completedAt: "2026-05-12T00:00:00.000Z",
          body: buildPromotedBody({
            themeKey: "prompt:missed:cccc3333",
            predictedEffect: {
              claim: "Rejection rate falls below 8%.",
              min_sample_size: 10,
              sample_description: "post-ship runs",
              attribution: {
                metric: "reviewer_rejection_rate",
                baseline_value: 0.12,
                direction: "decrease",
                threshold_value: 0.08,
              },
            },
          }),
        },
      ],
      { value: 0.15, sampleSize: 11 }, // wrong direction
    );
    callWeeklyReviewMock.mockReturnValueOnce(
      Effect.succeed({ ok: true, report: validReview() }),
    );

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

    const content = JSON.parse(f.saved[0]?.contentJson ?? "{}");
    expect(content.review.shipped_promotions[0].verdict).toBe("MISSED");
  });

  it("PENDING verdict: post-ship sample below the declared minimum (n=X of Y needed)", async () => {
    const f = buildFixtures();
    wireShipped(
      f,
      [
        {
          identifier: "VA-3004",
          url: "https://linear.app/x/issue/VA-3004",
          title: "Pending change",
          themeKey: "prompt:pending:dddd4444",
          completedAt: "2026-05-12T00:00:00.000Z",
          body: buildPromotedBody({
            themeKey: "prompt:pending:dddd4444",
            predictedEffect: {
              claim: "Rejection rate falls below 8%.",
              min_sample_size: 10,
              sample_description: "post-ship runs",
              attribution: {
                metric: "reviewer_rejection_rate",
                baseline_value: 0.12,
                direction: "decrease",
                threshold_value: 0.08,
              },
            },
          }),
        },
      ],
      { value: 0.05, sampleSize: 3 }, // below n=10
    );
    callWeeklyReviewMock.mockReturnValueOnce(
      Effect.succeed({ ok: true, report: validReview() }),
    );

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

    const content = JSON.parse(f.saved[0]?.contentJson ?? "{}");
    expect(content.review.shipped_promotions[0].verdict).toBe("PENDING");
    // AC: phrasing locks "n=X of Y needed".
    expect(content.review.shipped_promotions[0].comment).toMatch(
      /n=3\s+of\s+10\s+needed/,
    );
  });

  it("QUALITATIVE verdict: predicted_effect has no attribution block", async () => {
    const f = buildFixtures();
    wireShipped(
      f,
      [
        {
          identifier: "VA-3005",
          url: "https://linear.app/x/issue/VA-3005",
          title: "Qualitative shipped change",
          themeKey: "issue-body:style:eeee5555",
          completedAt: "2026-05-12T00:00:00.000Z",
          body: buildPromotedBody({
            themeKey: "issue-body:style:eeee5555",
            predictedEffect: {
              claim: "Future issue bodies cite the new style guide.",
              min_sample_size: 5,
              sample_description: "newly-filed issues",
              // No attribution block — falls to QUALITATIVE.
            },
          }),
        },
      ],
      null, // post-ship metrics unused for qualitative
    );
    callWeeklyReviewMock.mockReturnValueOnce(
      Effect.succeed({ ok: true, report: validReview() }),
    );

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

    const content = JSON.parse(f.saved[0]?.contentJson ?? "{}");
    expect(content.review.shipped_promotions[0].verdict).toBe("QUALITATIVE");
    // AC: comment includes "QUALITATIVE — operator review needed" and
    // quotes the predicted claim.
    expect(content.review.shipped_promotions[0].comment).toContain(
      "QUALITATIVE — operator review needed",
    );
    expect(content.review.shipped_promotions[0].comment).toContain(
      "Future issue bodies cite",
    );
  });

  it("skips attribution loop entirely when no prior weekly review exists", async () => {
    // Fresh workspace: `loadRecentWeeklyReviews` returns []. The pass
    // should NOT call listShippedPromotionsSince and should land an
    // empty shipped_promotions array.
    const f = buildFixtures();
    callWeeklyReviewMock.mockReturnValueOnce(
      Effect.succeed({ ok: true, report: validReview() }),
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
    expect(outcome.shippedPromotionsGraded).toBe(0);
    expect(f.metaLinear.listShippedPromotionsSince).not.toHaveBeenCalled();
  });

  it("LLM cannot overwrite the mechanical verdict — reconciliation drops a hallucinated one", async () => {
    const f = buildFixtures();
    wireShipped(
      f,
      [
        {
          identifier: "VA-3006",
          url: "https://linear.app/x/issue/VA-3006",
          title: "Held change",
          themeKey: "prompt:tighten:abcd1234",
          completedAt: "2026-05-12T00:00:00.000Z",
          body: buildPromotedBody({
            themeKey: "prompt:tighten:abcd1234",
            predictedEffect: {
              claim: "Rejection rate falls below 8%.",
              min_sample_size: 10,
              sample_description: "post-ship runs",
              attribution: {
                metric: "reviewer_rejection_rate",
                baseline_value: 0.12,
                direction: "decrease",
                threshold_value: 0.08,
              },
            },
          }),
        },
      ],
      { value: 0.05, sampleSize: 15 }, // truth = HELD
    );
    // LLM tries to flip it to MISSED with a fake observed value.
    callWeeklyReviewMock.mockReturnValueOnce(
      Effect.succeed({
        ok: true,
        report: validReview({
          shipped_promotions: [
            {
              theme_key: "prompt:tighten:abcd1234",
              linear_identifier: "VA-FAKE",
              linear_url: "https://example.com/fake",
              linear_title: "Hallucinated title",
              source_meta_review_identifiers: ["VA-fake"],
              predicted_effect: {
                claim: "fake",
                min_sample_size: 999,
                sample_description: "fake",
              },
              observed: { metric: null, value: 99, sample_size: 1 },
              verdict: "MISSED",
              comment: "LLM hallucinated comment.",
            },
          ],
        }),
      }),
    );

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

    const content = JSON.parse(f.saved[0]?.contentJson ?? "{}");
    const row = content.review.shipped_promotions[0];
    // Verdict + observed reconciled back to the mechanical truth.
    expect(row.verdict).toBe("HELD");
    expect(row.linear_identifier).toBe("VA-3006");
    expect(row.observed.value).toBe(0.05);
    expect(row.observed.sample_size).toBe(15);
    // But the LLM's one-sentence comment is preserved (the only field
    // the IRA is allowed to author).
    expect(row.comment).toBe("LLM hallucinated comment.");
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
