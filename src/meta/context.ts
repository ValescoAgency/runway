import { Effect } from "effect";
import type {
  CapturedCodingAgentReport,
  CapturedIssueProcess,
  CapturedReviewerReport,
  MetaDashboardRead,
  MetaReadError,
} from "./dashboard-read.js";

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
 * Run Review pass context (v1.0.0 — no hindsight, no norms). The
 * three `Captured*` shapes carry their own success / failure
 * variants — see `dashboard-read.ts`. The pass never crashes on a
 * report parse failure; it grades on what it has.
 */
export interface RunReviewContext {
  readonly issueProcess: CapturedIssueProcess;
  readonly codingAgentReport: CapturedCodingAgentReport;
  readonly reviewerReport: CapturedReviewerReport;
  // VA-403 wires hindsight (PR merge status, human review comments,
  // follow-up issues). Reserved here as `null` so v1.0.0 callers
  // forward-compat to v1.1.0 by reading the field.
  readonly hindsightSignals: null;
  // VA-405 wires rolling norms from the VA-399 read-model. Same
  // null-reserved pattern.
  readonly norms: null;
}

// ---------------------------------------------------------------------------
// Loader API — discriminated by pass
// ---------------------------------------------------------------------------

export type LoadContextArgs =
  | {
      readonly pass: "run-review";
      readonly traceId: string;
      readonly issueIdentifier: string;
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

const loadRunReviewContext = (
  args: { readonly traceId: string; readonly issueIdentifier: string },
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
    return {
      issueProcess,
      codingAgentReport,
      reviewerReport,
      hindsightSignals: null,
      norms: null,
    };
  });
