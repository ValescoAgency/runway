import { Effect } from "effect";
import {
  categoryFromIssueIdentifier,
  type CapturedCodingAgentReport,
  type CapturedIssueProcess,
  type CapturedNorms,
  type CapturedReviewerReport,
  type DrainMetaRow,
  type MetaDashboardRead,
  type MetaReadError,
  type WindowedMetaRow,
} from "./dashboard-read.js";
import {
  fetchHindsightSignals,
  type GitHubHindsightGateway,
  type LinearHindsightGateway,
} from "./hindsight.js";
import type {
  MetaLinearError,
  MetaLinearGateway,
  OpenPromotedQueueEntry,
  ShippedPromotedQueueEntry,
} from "./linear-meta.js";
import {
  loadOutOfScopeEntries,
  type OutOfScopeEntry,
  type OutOfScopeReadError,
} from "./out-of-scope.js";
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
    }
  | {
      // VA-406: drain-review pass context — every issue_process for
      // the drain plus every per-issue meta_reviews row (including
      // skipped/failed). The loader doesn't pull norms or hindsight
      // for the drain pass; the drain-level prompt is composition-
      // shaped, not per-issue-quality-shaped, so the inputs are
      // distinct.
      readonly pass: "drain-review";
      readonly traceId: string;
    }
  | {
      // VA-408: weekly-review pass context — Run + Drain Reviews in
      // the [startIso, endIso) window, prior 4 Weekly Reviews,
      // .out-of-scope/ rationales, and the open promoted-queue.
      // Loaded in parallel across the dashboard + Linear gateways.
      readonly pass: "weekly-review";
      readonly startIso: string;
      readonly endIso: string;
      readonly cwd: string;
      readonly metaLinear: MetaLinearGateway;
      /** Default 4 per PRD. */
      readonly priorWeeklyLimit?: number;
    };

export type LoadContextResult =
  | { readonly pass: "run-review"; readonly context: RunReviewContext }
  | { readonly pass: "drain-review"; readonly context: DrainReviewContext }
  | { readonly pass: "weekly-review"; readonly context: WeeklyReviewContext };

/**
 * VA-406: per-drain context payload. Mirrors the shape Run Review
 * passes through to its prompt builder — typed inputs, no in-loader
 * formatting — so the pass body can compose its own prompt without
 * the loader leaking serialization decisions.
 */
export interface DrainReviewContext {
  readonly traceId: string;
  readonly issueProcesses: readonly CapturedIssueProcess[];
  readonly metaRows: readonly DrainMetaRow[];
}

/**
 * VA-408: weekly-review context payload. The pass composes its prompt
 * from this; the promoter reads `runReviews` directly for
 * Recommendation extraction.
 *
 * The Linear-side queue read (`openPromotedQueue`) and the FS-side
 * out-of-scope read are loaded best-effort: a transient Linear error
 * or a missing `.out-of-scope/` directory degrade to empty arrays
 * rather than failing the whole pass. The trade-off is that a Linear
 * outage during the queue read could allow a re-promotion of a theme
 * with an open issue — acceptable cost for keeping the Weekly Review
 * from silently no-firing.
 */
export interface WeeklyReviewContext {
  readonly startIso: string;
  readonly endIso: string;
  readonly runReviews: readonly WindowedMetaRow[];
  readonly drainReviews: readonly WindowedMetaRow[];
  readonly priorWeeklyReviews: readonly WindowedMetaRow[];
  readonly outOfScopeEntries: readonly OutOfScopeEntry[];
  readonly openPromotedQueue: readonly OpenPromotedQueueEntry[];
  /**
   * VA-409: promoted runway-repo issues that moved to a `completed`
   * Linear state since the cutoff (the prior Weekly Review's
   * `created_at`, or the window start when no prior weekly exists).
   * Best-effort load: a Linear-side failure degrades to an empty
   * array with the error preserved in `degradedSources`.
   */
  readonly shippedPromotions: readonly ShippedPromotedQueueEntry[];
  /**
   * Per-source error reporting — when a degraded load happened the
   * pass logs which source produced the empty array. Null means the
   * source loaded cleanly. The IRA's prompt can call out the gap so
   * the operator knows whether the empty queue is real or due to a
   * transient gateway failure.
   */
  readonly degradedSources: {
    readonly outOfScope: string | null;
    readonly openPromotedQueue: string | null;
    readonly shippedPromotions: string | null;
  };
}

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
    case "drain-review":
      return loadDrainReviewContext(args, gateway).pipe(
        Effect.map((context) => ({ pass: "drain-review" as const, context })),
      );
    case "weekly-review":
      return loadWeeklyReviewContext(args, gateway).pipe(
        Effect.map((context) => ({ pass: "weekly-review" as const, context })),
      );
  }
};

const DEFAULT_PRIOR_WEEKLY_LIMIT = 4;

const loadWeeklyReviewContext = (
  args: {
    readonly startIso: string;
    readonly endIso: string;
    readonly cwd: string;
    readonly metaLinear: MetaLinearGateway;
    readonly priorWeeklyLimit?: number;
  },
  gateway: MetaDashboardRead,
): Effect.Effect<WeeklyReviewContext, MetaReadError> =>
  Effect.gen(function* () {
    const priorWeeklyLimit =
      args.priorWeeklyLimit ?? DEFAULT_PRIOR_WEEKLY_LIMIT;
    // VA-408 + VA-409: six reads in parallel — three dashboard-SQLite,
    // one FS, two Linear. SQLite is single-threaded but the Effect
    // scheduler runs the async wrappers concurrently. FS + Linear
    // sources are best-effort: a failure degrades to an empty array
    // with the error message preserved in `degradedSources`. The
    // shipped-promotion cutoff is computed AFTER prior weekly reviews
    // resolve, but the Linear query itself can run concurrently using
    // the window start as a pessimistic cutoff and then the loop
    // filters to the actual prior-weekly cutoff. Simpler: just sequence
    // the shipped query after the prior weekly read — the Linear RTT
    // is ~150ms, dwarfed by the LLM call that follows.
    const [
      runReviews,
      drainReviews,
      priorWeekly,
      outOfScopeResult,
      openQueueResult,
    ] = yield* Effect.all(
      [
        gateway.loadRunReviewsInWindow(args.startIso, args.endIso),
        gateway.loadDrainReviewsInWindow(args.startIso, args.endIso),
        gateway.loadRecentWeeklyReviews(priorWeeklyLimit),
        loadOutOfScopeEntries(args.cwd).pipe(Effect.either),
        args.metaLinear.listOpenPromotedQueue().pipe(Effect.either),
      ],
      { concurrency: "unbounded" },
    );
    const outOfScopeEntries =
      outOfScopeResult._tag === "Right" ? outOfScopeResult.right : [];
    const openPromotedQueue =
      openQueueResult._tag === "Right" ? openQueueResult.right : [];

    // VA-409: cutoff for "since the prior Weekly Review". When no
    // prior weekly exists (fresh workspace / first weekly run), we
    // skip the attribution loop entirely — there's no "since" baseline
    // and the first weekly's role is to establish ground truth, not
    // to grade. A null shippedResult means "no prior weekly", distinct
    // from "Linear errored" so the prompt can render the right message.
    const shippedCutoffIso = priorWeekly[0]?.createdAt ?? null;
    const shippedResult =
      shippedCutoffIso !== null
        ? yield* args.metaLinear
            .listShippedPromotionsSince(shippedCutoffIso)
            .pipe(Effect.either)
        : null;
    const shippedPromotions: readonly ShippedPromotedQueueEntry[] =
      shippedResult === null
        ? []
        : shippedResult._tag === "Right"
          ? shippedResult.right
          : [];
    const shippedPromotionsDegraded =
      shippedResult !== null && shippedResult._tag === "Left"
        ? formatDegradedError("shippedPromotions", shippedResult.left)
        : null;

    return {
      startIso: args.startIso,
      endIso: args.endIso,
      runReviews,
      drainReviews,
      priorWeeklyReviews: priorWeekly,
      outOfScopeEntries,
      openPromotedQueue,
      shippedPromotions,
      degradedSources: {
        outOfScope:
          outOfScopeResult._tag === "Left"
            ? formatDegradedError("out-of-scope", outOfScopeResult.left)
            : null,
        openPromotedQueue:
          openQueueResult._tag === "Left"
            ? formatDegradedError("openPromotedQueue", openQueueResult.left)
            : null,
        shippedPromotions: shippedPromotionsDegraded,
      },
    } satisfies WeeklyReviewContext;
  });

const formatDegradedError = (
  source: string,
  err: OutOfScopeReadError | MetaLinearError,
): string => {
  const message = "message" in err ? err.message : String(err);
  return `${source}: ${message}`;
};

const loadDrainReviewContext = (
  args: { readonly traceId: string },
  gateway: MetaDashboardRead,
): Effect.Effect<DrainReviewContext, MetaReadError> =>
  Effect.gen(function* () {
    // VA-406: pull both in parallel — issue_processes and meta_reviews
    // rows live in independent tables and the queries don't depend on
    // each other.
    const [issueProcesses, metaRows] = yield* Effect.all(
      [
        gateway.loadIssueProcessesForDrain(args.traceId),
        gateway.loadDrainMetaRows(args.traceId),
      ],
      { concurrency: "unbounded" },
    );
    return {
      traceId: args.traceId,
      issueProcesses,
      metaRows,
    };
  });

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
