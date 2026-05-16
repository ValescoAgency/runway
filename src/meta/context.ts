import { Effect } from "effect";
import {
  categoryFromIssueIdentifier,
  type CapturedCodingAgentReport,
  type CapturedIssueProcess,
  type CapturedNorms,
  type CapturedReviewerReport,
  type MetaDashboardRead,
  type MetaReadError,
} from "./dashboard-read.js";
import {
  fetchHindsightSignals,
  type GitHubHindsightGateway,
  type LinearHindsightGateway,
} from "./hindsight.js";
import type { HindsightSignals } from "./templates.js";

/**
 * VA-402: per-pass context loader. The PRD's module decomposition
 * lists `meta/context` as the single seam through which every pass
 * loads its input — a `loadContextFor(pass, scope)` interface that
 * grows as later slices add hindsight (VA-403), heuristic-filter
 * inputs (VA-404), rolling norms (VA-405), prior Reviews + the
 * promoted-queue (VA-408), and `.out-of-scope/` (VA-408).
 *
 * This module is the seam, not the loader-of-everything. At this
 * slice the only pass is Run Review and the only context fields are
 * the captured Coding Agent + Reviewer reports plus the
 * `issue_processes` row that ties them together. Later slices widen
 * the discriminated union — adding new pass variants means adding
 * new variants here, not editing the pass itself.
 *
 * Keeps `dashboard-read` purely as the typed gateway (one method per
 * SQLite shape); composition into pass-shaped contexts lives here.
 */

// ---------------------------------------------------------------------------
// Context shapes — one per pass
// ---------------------------------------------------------------------------

/**
 * Run Review pass context (v1.2.0 — adds rolling norms). The
 * `Captured*` shapes carry their own success / failure variants — see
 * `dashboard-read.ts`. The pass never crashes on a report parse
 * failure; it grades on what it has.
 */
export interface RunReviewContext {
  readonly issueProcess: CapturedIssueProcess;
  readonly codingAgentReport: CapturedCodingAgentReport;
  readonly reviewerReport: CapturedReviewerReport;
  // VA-404: number of review attempts the run made. >= 2 means a
  // mid-run review-retry fired (REJECTED-RETRY → re-impl → re-review)
  // even if the run ultimately succeeded. The heuristic filter trips
  // on this so a "looked clean" recovery isn't a clean skip.
  readonly reviewAttemptCount: number;
  // VA-403: hindsight composed of PR state, human-comment summary,
  // and Linear follow-up issues filed in the past 48h. Null when no
  // hindsight gateways were wired in (back-compat for v1.0.0
  // callers that haven't been updated to construct them).
  readonly hindsightSignals: HindsightSignals | null;
  // VA-405: rolling norms (median/p95 iteration, wall-time, rejection
  // / revert / hitl / infra rates) for the issue category, sourced
  // from VA-399's evaluator-facing read-model. Null when (a) the
  // caller didn't ask for norms (back-compat with v1.1.0), (b) the
  // category has no rows in the configured window, or (c) the gateway
  // failed (degraded read — the pass continues without).
  readonly norms: CapturedNorms | null;
}

/**
 * VA-403: optional hindsight wiring for the Run Review context
 * loader. When present, `loadContextFor` fetches PR state +
 * follow-up issues concurrently and projects them into
 * `hindsightSignals`. When absent, `hindsightSignals` stays null
 * (the pre-VA-403 contract — still parses against the v1.1.0
 * RunReview schema since the schema accepts both).
 *
 * `followUpWindowHours` defaults to 48 per the VA-403 PRD
 * ("Linear issues filed in the past 48 hours referencing the source
 * issue identifier"). Operators can tighten / widen via
 * `metaHindsightWindowHours` in `.runway/config.yml` (VA-403).
 */
export interface HindsightWiring {
  readonly github: GitHubHindsightGateway;
  readonly linear: LinearHindsightGateway;
  readonly followUpWindowHours?: number;
}

// ---------------------------------------------------------------------------
// Loader API — discriminated by pass
// ---------------------------------------------------------------------------

export type LoadContextArgs =
  | {
      readonly pass: "run-review";
      readonly traceId: string;
      readonly issueIdentifier: string;
      // VA-403: optional hindsight gateways. When present the loader
      // fetches PR state + follow-ups; when absent `hindsightSignals`
      // stays null (back-compat with v1.0.0 callers).
      readonly hindsight?: HindsightWiring;
      // VA-405: rolling-norm window in drains. When present the
      // loader queries `loadNorms(category, window)` and projects the
      // result into `context.norms`. When absent, `norms` stays null
      // (v1.0.0 / v1.1.0 back-compat — older callers that haven't been
      // updated keep the legacy "no relative axis" behavior).
      readonly normsWindow?: number;
    };

export type LoadContextResult =
  | { readonly pass: "run-review"; readonly context: RunReviewContext };

/**
 * VA-402: PRD's `loadContextFor(pass, scope)` seam. One function,
 * one switch over `pass` — each variant returns the typed context
 * its pass needs. Failure surfaces in the gateway's tagged error
 * channel; the pass turns those into `meta-failed` stubs.
 */
export const loadContextFor = (
  args: LoadContextArgs,
  gateway: MetaDashboardRead,
): Effect.Effect<LoadContextResult, MetaReadError> => {
  switch (args.pass) {
    case "run-review":
      return loadRunReviewContext(args, gateway).pipe(
        Effect.map((context) => ({ pass: "run-review" as const, context })),
      );
  }
};

const DEFAULT_FOLLOW_UP_WINDOW_HOURS = 48;

const loadRunReviewContext = (
  args: {
    readonly traceId: string;
    readonly issueIdentifier: string;
    readonly hindsight?: HindsightWiring;
    readonly normsWindow?: number;
  },
  gateway: MetaDashboardRead,
): Effect.Effect<RunReviewContext, MetaReadError> =>
  Effect.gen(function* () {
    const issueProcess = yield* gateway.loadIssueProcess(
      args.traceId,
      args.issueIdentifier,
    );
    // VA-401's reports are tolerant — a missing or malformed report
    // surfaces as a tagged `ok: false` variant rather than failing
    // the read. We pass that through so the IRA grades on what it
    // observes (and grades reviewer / agent quality as FAILED when
    // the report shape is missing).
    const codingAgentReport = yield* gateway
      .loadCodingAgentReport(args.traceId, issueProcess.spanId)
      .pipe(
        Effect.orElseSucceed(
          (): CapturedCodingAgentReport => ({
            ok: false,
            kind: "missing",
            message: "loadCodingAgentReport gateway error",
          }),
        ),
      );
    const reviewerReport = yield* gateway
      .loadReviewerReport(args.traceId, issueProcess.spanId)
      .pipe(
        Effect.orElseSucceed(
          (): CapturedReviewerReport => ({
            ok: false,
            kind: "missing",
            message: "loadReviewerReport gateway error",
          }),
        ),
      );
    // VA-404: review attempt count. Tolerant — gateway error
    // collapses to 0 (the conservative reading: "we couldn't tell, so
    // assume no retry"). The other trip clauses still cover the
    // common signals (HITL, errored, reverted, iteration count).
    const reviewAttemptCount = yield* gateway
      .countReviewAttempts(args.traceId, issueProcess.spanId)
      .pipe(Effect.orElseSucceed(() => 0));
    // VA-403: hindsight is independently optional from the dashboard
    // gateway — the loader runs both fetches concurrently and tolerates
    // a per-source failure inside `fetchHindsightSignals` (it projects
    // tagged errors to nulls / empties). The whole block is null when
    // no hindsight gateways were wired (v1.0.0 back-compat).
    const hindsightSignals = args.hindsight
      ? yield* fetchHindsightSignals(
          {
            prUrl: issueProcess.prUrl,
            sourceIdentifier: issueProcess.issueIdentifier,
            followUpSinceIso: hoursAgoIso(
              args.hindsight.followUpWindowHours ??
                DEFAULT_FOLLOW_UP_WINDOW_HOURS,
            ),
          },
          {
            github: args.hindsight.github,
            linear: args.hindsight.linear,
          },
        )
      : null;
    // VA-405: rolling norms via VA-399's read-model. Tolerant — the
    // gateway error collapses to null so the IRA still grades (just
    // without a relative axis). Callers that pass `normsWindow=0` /
    // omit it entirely keep the v1.1.0 contract.
    const norms =
      args.normsWindow !== undefined && args.normsWindow > 0
        ? yield* gateway
            .loadNorms(
              categoryFromIssueIdentifier(issueProcess.issueIdentifier),
              args.normsWindow,
            )
            .pipe(Effect.orElseSucceed((): CapturedNorms | null => null))
        : null;
    return {
      issueProcess,
      codingAgentReport,
      reviewerReport,
      reviewAttemptCount,
      hindsightSignals,
      norms,
    };
  });

const hoursAgoIso = (hours: number): string =>
  new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
