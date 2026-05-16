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
});
