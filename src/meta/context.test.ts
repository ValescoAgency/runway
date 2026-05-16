import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { loadContextFor } from "./context.js";
import type {
  CapturedIssueProcess,
  MetaDashboardRead,
} from "./dashboard-read.js";

// VA-402: the `meta/context` seam is the PRD's `loadContextFor(pass,
// scope)` entry point. The Run Review variant composes three gateway
// reads into one typed context; later slices add hindsight / norms /
// prior reviews behind this same seam. These tests lock the contract:
//
//   - happy path: every gateway succeeds → typed `RunReviewContext`
//     with all three captured fields and reserved null slots
//   - gateway error on the issue_process load propagates as the
//     pass's failure trigger (it's an unrecoverable "no such row")
//   - tolerant degradation on the per-report loads: a gateway error
//     becomes a `kind: "missing"` captured shape so the IRA can
//     grade reviewer / agent quality as FAILED rather than crash

const baseIssueProcess: CapturedIssueProcess = {
  traceId: "trace-abc",
  spanId: "span-issue-process",
  issueIdentifier: "VA-401",
  issueId: "issue-abc",
  issueTitle: "test",
  issueLabels: [],
  branch: "agent/va-401",
  outcomeKind: "opened",
  outcomeDetail: "url",
  prUrl: "url",
  hitlReason: null,
  startTimeUnixNano: "1",
  endTimeUnixNano: "2",
};

const makeGateway = (
  over: Partial<MetaDashboardRead> = {},
): MetaDashboardRead =>
  ({
    loadIssueProcess: vi.fn(() => Effect.succeed(baseIssueProcess)),
    loadCodingAgentReport: vi.fn(() =>
      Effect.succeed({
        ok: true as const,
        iterationIndex: 1,
        templateVersion: "1.0.0",
        payload: "{}",
      }),
    ),
    loadReviewerReport: vi.fn(() =>
      Effect.succeed({
        ok: true as const,
        templateVersion: "1.0.0",
        payload: "{}",
      }),
    ),
    // VA-404 follow-up: review-attempt count gateway. Default 1 in
    // the makeGateway helper so existing tests don't have to think
    // about it; tests that care about retry detection override.
    countReviewAttempts: vi.fn(() => Effect.succeed(1)),
    ...over,
  }) as unknown as MetaDashboardRead;

describe("loadContextFor — pass: run-review (VA-402)", () => {
  it("composes the three gateway reads into a typed RunReviewContext", async () => {
    const gateway = makeGateway();
    const result = await Effect.runPromise(
      loadContextFor(
        { pass: "run-review", traceId: "trace-abc", issueIdentifier: "VA-401" },
        gateway,
      ),
    );
    expect(result.pass).toBe("run-review");
    if (result.pass !== "run-review") return;
    expect(result.context.issueProcess.issueIdentifier).toBe("VA-401");
    expect(result.context.codingAgentReport.ok).toBe(true);
    expect(result.context.reviewerReport.ok).toBe(true);
    // VA-403 / VA-405 widen these to non-null shapes; v1.0.0 reserves.
    expect(result.context.hindsightSignals).toBeNull();
    expect(result.context.norms).toBeNull();
  });

  it("fails the load when issue_process can't be resolved (pass triggers stub)", async () => {
    const gateway = makeGateway({
      loadIssueProcess: vi.fn(() =>
        Effect.fail({
          _tag: "MetaReadIssueProcessNotFound" as const,
          traceId: "trace-abc",
          issueIdentifier: "VA-401",
          message: "no issue_processes row for trace=trace-abc, issue=VA-401",
        }),
      ) as unknown as MetaDashboardRead["loadIssueProcess"],
    });
    const result = await Effect.runPromise(
      Effect.either(
        loadContextFor(
          {
            pass: "run-review",
            traceId: "trace-abc",
            issueIdentifier: "VA-401",
          },
          gateway,
        ),
      ),
    );
    expect(result._tag).toBe("Left");
    if (result._tag !== "Left") return;
    expect(result.left._tag).toBe("MetaReadIssueProcessNotFound");
  });

  it("degrades a coding-agent gateway error into a `missing` captured variant", async () => {
    const gateway = makeGateway({
      loadCodingAgentReport: vi.fn(() =>
        Effect.fail({
          _tag: "MetaReadDatabaseError" as const,
          call: "loadCodingAgentReport",
          message: "i/o error",
        }),
      ) as unknown as MetaDashboardRead["loadCodingAgentReport"],
    });
    const result = await Effect.runPromise(
      loadContextFor(
        { pass: "run-review", traceId: "trace-abc", issueIdentifier: "VA-401" },
        gateway,
      ),
    );
    if (result.pass !== "run-review") return;
    expect(result.context.codingAgentReport.ok).toBe(false);
    if (result.context.codingAgentReport.ok) return;
    expect(result.context.codingAgentReport.kind).toBe("missing");
  });

  it("degrades a reviewer-report gateway error into a `missing` captured variant", async () => {
    const gateway = makeGateway({
      loadReviewerReport: vi.fn(() =>
        Effect.fail({
          _tag: "MetaReadDatabaseError" as const,
          call: "loadReviewerReport",
          message: "i/o error",
        }),
      ) as unknown as MetaDashboardRead["loadReviewerReport"],
    });
    const result = await Effect.runPromise(
      loadContextFor(
        { pass: "run-review", traceId: "trace-abc", issueIdentifier: "VA-401" },
        gateway,
      ),
    );
    if (result.pass !== "run-review") return;
    expect(result.context.reviewerReport.ok).toBe(false);
    if (result.context.reviewerReport.ok) return;
    expect(result.context.reviewerReport.kind).toBe("missing");
  });

  // VA-404 follow-up: the review-attempt count is a first-class
  // gateway read; widens RunReviewContext so the heuristic filter
  // can detect retry-then-success runs that the outcomeKind clauses
  // alone would miss.

  it("propagates the review attempt count from the gateway", async () => {
    const gateway = makeGateway({
      countReviewAttempts: vi.fn(() =>
        Effect.succeed(3),
      ) as unknown as MetaDashboardRead["countReviewAttempts"],
    });
    const result = await Effect.runPromise(
      loadContextFor(
        { pass: "run-review", traceId: "trace-abc", issueIdentifier: "VA-401" },
        gateway,
      ),
    );
    if (result.pass !== "run-review") return;
    expect(result.context.reviewAttemptCount).toBe(3);
  });

  it("degrades a countReviewAttempts gateway error to 0 (conservative)", async () => {
    const gateway = makeGateway({
      countReviewAttempts: vi.fn(() =>
        Effect.fail({
          _tag: "MetaReadDatabaseError" as const,
          call: "countReviewAttempts",
          message: "i/o error",
        }),
      ) as unknown as MetaDashboardRead["countReviewAttempts"],
    });
    const result = await Effect.runPromise(
      loadContextFor(
        { pass: "run-review", traceId: "trace-abc", issueIdentifier: "VA-401" },
        gateway,
      ),
    );
    if (result.pass !== "run-review") return;
    expect(result.context.reviewAttemptCount).toBe(0);
  });

  // VA-403: hindsight wiring. Optional argument — when omitted,
  // hindsightSignals stays null (back-compat). When present, it
  // composes PR state + Linear follow-ups concurrently into the
  // populated v1.1.0 shape.

  it("leaves hindsightSignals null when no hindsight gateways are wired (v1.0.0 back-compat)", async () => {
    const gateway = makeGateway();
    const result = await Effect.runPromise(
      loadContextFor(
        { pass: "run-review", traceId: "trace-abc", issueIdentifier: "VA-401" },
        gateway,
      ),
    );
    if (result.pass !== "run-review") return;
    expect(result.context.hindsightSignals).toBeNull();
  });

  it("composes hindsight from injected gateways when wired", async () => {
    const gateway = makeGateway({
      loadIssueProcess: vi.fn(() =>
        Effect.succeed({
          ...baseIssueProcess,
          prUrl: "https://github.com/foo/bar/pull/103",
        }),
      ),
    });
    const github = {
      fetchPrState: vi.fn(() =>
        Effect.succeed({
          url: "https://github.com/foo/bar/pull/103",
          state: "merged" as const,
          mergedAt: "2026-05-15T01:23Z",
          humanComments: [],
        }),
      ),
    };
    const linear = {
      findFollowUpIssues: vi.fn(() =>
        Effect.succeed([
          { identifier: "VA-501", title: "Follow-up to VA-401" },
        ]),
      ),
    };
    const result = await Effect.runPromise(
      loadContextFor(
        {
          pass: "run-review",
          traceId: "trace-abc",
          issueIdentifier: "VA-401",
          hindsight: { github, linear },
        },
        gateway,
      ),
    );
    if (result.pass !== "run-review") return;
    expect(result.context.hindsightSignals).not.toBeNull();
    if (result.context.hindsightSignals === null) return;
    expect(result.context.hindsightSignals.pr?.state).toBe("merged");
    expect(result.context.hindsightSignals.follow_up_issues).toHaveLength(1);
    // Linear follow-up gateway received an ISO cutoff in the past
    // (default 48h window). Don't assert on the exact value (test
    // would race the clock); just assert it was called.
    expect(linear.findFollowUpIssues).toHaveBeenCalledTimes(1);
    const call = (linear.findFollowUpIssues as unknown as {
      readonly mock: { readonly calls: ReadonlyArray<[{ sourceIdentifier: string; sinceIso: string }]> };
    }).mock.calls[0]?.[0];
    expect(call?.sourceIdentifier).toBe("VA-401");
    expect(typeof call?.sinceIso).toBe("string");
  });

  it("respects an operator-supplied followUpWindowHours override", async () => {
    const gateway = makeGateway({
      loadIssueProcess: vi.fn(() =>
        Effect.succeed({ ...baseIssueProcess, prUrl: null }),
      ),
    });
    const github = {
      fetchPrState: vi.fn(() => Effect.succeed(null)),
    };
    const linear = {
      findFollowUpIssues: vi.fn(() => Effect.succeed([])),
    };
    const before = Date.now();
    await Effect.runPromise(
      loadContextFor(
        {
          pass: "run-review",
          traceId: "trace-abc",
          issueIdentifier: "VA-401",
          hindsight: { github, linear, followUpWindowHours: 24 },
        },
        gateway,
      ),
    );
    const sinceIso = ((
      linear.findFollowUpIssues as unknown as {
        readonly mock: { readonly calls: ReadonlyArray<[{ sinceIso: string }]> };
      }
    ).mock.calls[0]?.[0]?.sinceIso) as string;
    const sinceMs = Date.parse(sinceIso);
    // 24h window: cutoff should be ~24h before "now" (with a tiny
    // slack for test runtime). Lower bound: at least 24h - 1min ago.
    // Upper bound: at most 24h + 1min ago.
    const expectedCutoff = before - 24 * 60 * 60 * 1000;
    expect(sinceMs).toBeLessThanOrEqual(expectedCutoff + 60_000);
    expect(sinceMs).toBeGreaterThanOrEqual(expectedCutoff - 60_000);
  });
});
