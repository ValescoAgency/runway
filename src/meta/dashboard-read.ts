import { DatabaseSync } from "node:sqlite";
import { Data, Effect } from "effect";
import type { OtlpAttribute } from "../dashboard/otlp.js";
import { attrMap } from "../dashboard/otlp.js";

/**
 * VA-402: read-only Effect queries against the dashboard SQLite store
 * for the IRA's `runway review` passes. Tagged-error gateway so the
 * pass layer can pattern-match on failure modes (no such drain, no
 * such issue, report shape drift) and route to `meta-failed` stubs
 * instead of crashing the subcommand.
 *
 * Module is "deep" per the PRD's module decomposition: callers pass
 * `{traceId, issueIdentifier}` and get domain rows back. SQL stays
 * inside this file; the IRA reasons on `CapturedIssueProcess`,
 * `CapturedCodingAgentReport`, `CapturedReviewerReport` shapes that
 * never leak the underlying JSON-extract plumbing.
 */

// ---------------------------------------------------------------------------
// Error ADT
// ---------------------------------------------------------------------------

export class MetaReadDatabaseError extends Data.TaggedError(
  "MetaReadDatabaseError",
)<{
  readonly call: string;
  readonly message: string;
}> {}

export class MetaReadIssueProcessNotFound extends Data.TaggedError(
  "MetaReadIssueProcessNotFound",
)<{
  readonly traceId: string;
  readonly issueIdentifier: string;
  readonly message: string;
}> {}

export type MetaReadError =
  | MetaReadDatabaseError
  | MetaReadIssueProcessNotFound;

// ---------------------------------------------------------------------------
// Captured domain shapes — what the Run Review pass sees as input
// ---------------------------------------------------------------------------

export interface CapturedIssueProcess {
  readonly traceId: string;
  readonly spanId: string;
  readonly issueIdentifier: string;
  readonly issueId: string | null;
  readonly issueTitle: string | null;
  readonly issueLabels: readonly string[];
  readonly branch: string | null;
  readonly outcomeKind: string | null;
  readonly outcomeDetail: string | null;
  readonly prUrl: string | null;
  readonly hitlReason: string | null;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
}

/**
 * VA-401 / VA-402: the Coding Agent Report captured off the LAST
 * `impl-iter-N` span for an issue process — that's the iteration the
 * agent exited on, so its report represents the agent's final view.
 * `iterationIndex` is the 1-based iteration number the report came
 * from; the IRA grades efficiency against rolling norms in VA-405
 * by reading this number alongside the wall-time telemetry.
 *
 * Three result shapes mirror VA-401's parse contract:
 *   - `ok: true` — report parsed cleanly, JSON body is in `payload`
 *   - `ok: false, kind: "missing"` — no iteration span or no report
 *     attribute on the latest one (legacy run, or shape drift)
 *   - `ok: false, kind: "error"` — the iteration span had an error
 *     tag attribute set by the orchestrator's parse path
 */
export type CapturedCodingAgentReport =
  | {
      readonly ok: true;
      readonly iterationIndex: number;
      readonly templateVersion: string;
      readonly payload: string;
    }
  | { readonly ok: false; readonly kind: "missing"; readonly message: string }
  | {
      readonly ok: false;
      readonly kind: "error";
      readonly errorKind: string;
      readonly message: string;
    };

export type CapturedReviewerReport =
  | { readonly ok: true; readonly templateVersion: string; readonly payload: string }
  | { readonly ok: false; readonly kind: "missing"; readonly message: string }
  | {
      readonly ok: false;
      readonly kind: "error";
      readonly errorKind: string;
      readonly message: string;
    };

// ---------------------------------------------------------------------------
// Gateway interface
// ---------------------------------------------------------------------------

export interface MetaDashboardRead {
  /**
   * Resolve the issue_processes row for a (drain trace_id, issue
   * identifier) pair. Returns `MetaReadIssueProcessNotFound` when
   * the dashboard hasn't seen the OTLP flush yet (drain too fresh,
   * collector dropped the batch).
   */
  loadIssueProcess(
    traceId: string,
    issueIdentifier: string,
  ): Effect.Effect<CapturedIssueProcess, MetaReadError>;
  /**
   * VA-403: latest `end_time_unix_nano` across every `issue_processes`
   * row in the trace. Proxy for "drain finished processing" — the
   * delay gate compares this against `now - delay_hours` to decide
   * whether the drain is mature enough for the IRA. Returns null
   * when no rows exist for the trace (drain too fresh / unknown id).
   */
  loadDrainEndTime(
    traceId: string,
  ): Effect.Effect<string | null, MetaReadError>;
  /**
   * Pull the Coding Agent Report off the latest impl-iter span for
   * an issue process. Never fails the Effect — the "no report" /
   * "report error" cases land as tagged `ok: false` variants so the
   * IRA can grade them as observations rather than crashing the
   * pass.
   */
  loadCodingAgentReport(
    traceId: string,
    issueProcessSpanId: string,
  ): Effect.Effect<CapturedCodingAgentReport, MetaReadError>;
  /**
   * Pull the Reviewer Report off the `review` span for an issue
   * process. Same tolerant contract as `loadCodingAgentReport`.
   */
  loadReviewerReport(
    traceId: string,
    issueProcessSpanId: string,
  ): Effect.Effect<CapturedReviewerReport, MetaReadError>;
  /**
   * VA-404: count of `review` spans whose parent is the issue
   * process. Each `Effect.withSpan("review")` call in `runReviewPass`
   * opens a fresh span — when VA-418's review-retry budget fires,
   * the orchestrator runs `runReviewPass` again, so this count is
   * the number of review attempts the run actually made.
   *
   * `>= 2` means at least one mid-run review-retry happened — even
   * if the run ultimately succeeded ("opened"). The heuristic
   * filter uses this to honour the PRD's "retry triggered at any
   * phase" trip clause for runs that recovered from a REJECTED-RETRY
   * without escalating to HITL.
   */
  countReviewAttempts(
    traceId: string,
    issueProcessSpanId: string,
  ): Effect.Effect<number, MetaReadError>;
}

/**
 * Open the dashboard SQLite at `path` read-only and return a typed
 * gateway. The IRA passes use this in scoped Effects so the handle
 * closes deterministically at end-of-run.
 */
export function createMetaDashboardRead(path: string): MetaDashboardRead {
  const db = new DatabaseSync(path);

  const selectIssueProcess = db.prepare(`
    SELECT trace_id, span_id, issue_identifier, issue_id, issue_title,
           issue_labels, branch, outcome_kind, outcome_detail, pr_url,
           hitl_reason, start_time_unix_nano, end_time_unix_nano
    FROM issue_processes
    WHERE trace_id = ? AND issue_identifier = ?
    ORDER BY inserted_at DESC
    LIMIT 1
  `);

  const selectLatestImplIterRawSpan = db.prepare(`
    SELECT rs.payload, ai.iteration_index
    FROM agent_iterations ai
    JOIN raw_spans rs ON rs.trace_id = ai.trace_id AND rs.span_id = ai.id
    WHERE ai.trace_id = ? AND ai.issue_process_id = ?
    ORDER BY ai.iteration_index DESC
    LIMIT 1
  `);

  // VA-403: the drain's "done" time as max(end_time) across the
  // trace's issue_processes. CAST to INTEGER so the int64-as-string
  // column orders numerically — same trick `getActiveDrainStmt`
  // uses on start_time.
  const selectDrainEndTime = db.prepare(`
    SELECT MAX(CAST(end_time_unix_nano AS INTEGER)) AS max_end
    FROM issue_processes
    WHERE trace_id = ?
  `);

  // Reviewer report lives on the `review` span, child of the issue
  // process. `json_extract` pulls the parent span id off the OTLP
  // span JSON so we can scope by parent — agent_iterations doesn't
  // have a typed row for `review` (only `impl-iter-N`).
  const selectReviewRawSpan = db.prepare(`
    SELECT payload
    FROM raw_spans
    WHERE trace_id = ?
      AND name = 'review'
      AND json_extract(payload, '$.parentSpanId') = ?
    ORDER BY rowid DESC
    LIMIT 1
  `);

  // VA-404: count of review spans for the issue process. The
  // orchestrator emits one `review` span per attempt (initial +
  // each retry within the budget). >= 2 = at least one retry fired.
  const selectReviewAttemptCount = db.prepare(`
    SELECT COUNT(*) AS attempts
    FROM raw_spans
    WHERE trace_id = ?
      AND name = 'review'
      AND json_extract(payload, '$.parentSpanId') = ?
  `);

  const wrap = <A>(
    call: string,
    thunk: () => A,
  ): Effect.Effect<A, MetaReadError> =>
    Effect.try({
      try: thunk,
      catch: (err) =>
        new MetaReadDatabaseError({
          call,
          message: err instanceof Error ? err.message : String(err),
        }),
    });

  return {
    loadIssueProcess(traceId, issueIdentifier) {
      return Effect.gen(function* () {
        const row = yield* wrap(
          "loadIssueProcess",
          () =>
            selectIssueProcess.get(traceId, issueIdentifier) as
              | Record<string, unknown>
              | undefined,
        );
        if (!row) {
          return yield* Effect.fail(
            new MetaReadIssueProcessNotFound({
              traceId,
              issueIdentifier,
              message: `no issue_processes row for trace=${traceId}, issue=${issueIdentifier}`,
            }),
          );
        }
        const labels = (() => {
          const raw = row.issue_labels;
          if (typeof raw !== "string" || raw.length === 0) return [];
          try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed.map(String) : [];
          } catch {
            return [];
          }
        })();
        return {
          traceId: String(row.trace_id ?? ""),
          spanId: String(row.span_id ?? ""),
          issueIdentifier: String(row.issue_identifier ?? ""),
          issueId: nullableStr(row.issue_id),
          issueTitle: nullableStr(row.issue_title),
          issueLabels: labels,
          branch: nullableStr(row.branch),
          outcomeKind: nullableStr(row.outcome_kind),
          outcomeDetail: nullableStr(row.outcome_detail),
          prUrl: nullableStr(row.pr_url),
          hitlReason: nullableStr(row.hitl_reason),
          startTimeUnixNano: String(row.start_time_unix_nano ?? ""),
          endTimeUnixNano: String(row.end_time_unix_nano ?? ""),
        };
      });
    },

    loadDrainEndTime(traceId) {
      return wrap("loadDrainEndTime", () => {
        const row = selectDrainEndTime.get(traceId) as
          | Record<string, unknown>
          | undefined;
        const max = row?.max_end;
        if (max === null || max === undefined) return null;
        // SQLite returns the MAX as a BigInt for INTEGER columns
        // wider than 32-bit; coerce to string so the caller compares
        // against `Date.now() * 1_000_000` without precision drift.
        return String(max);
      });
    },

    loadCodingAgentReport(traceId, issueProcessSpanId) {
      return wrap("loadCodingAgentReport", () => {
        const row = selectLatestImplIterRawSpan.get(
          traceId,
          issueProcessSpanId,
        ) as Record<string, unknown> | undefined;
        if (!row) {
          return {
            ok: false,
            kind: "missing",
            message: `no impl-iter spans for issue_process_id=${issueProcessSpanId}`,
          } satisfies CapturedCodingAgentReport;
        }
        const attrs = extractAttrs(String(row.payload ?? ""));
        return projectCodingAgentReport(
          attrs,
          Number(row.iteration_index ?? 0),
        );
      });
    },

    loadReviewerReport(traceId, issueProcessSpanId) {
      return wrap("loadReviewerReport", () => {
        const row = selectReviewRawSpan.get(
          traceId,
          issueProcessSpanId,
        ) as Record<string, unknown> | undefined;
        if (!row) {
          return {
            ok: false,
            kind: "missing",
            message: `no review span for issue_process_id=${issueProcessSpanId} (likely BLOCKED before review or review crashed pre-flush)`,
          } satisfies CapturedReviewerReport;
        }
        const attrs = extractAttrs(String(row.payload ?? ""));
        return projectReviewerReport(attrs);
      });
    },

    countReviewAttempts(traceId, issueProcessSpanId) {
      return wrap("countReviewAttempts", () => {
        const row = selectReviewAttemptCount.get(
          traceId,
          issueProcessSpanId,
        ) as Record<string, unknown> | undefined;
        return Number(row?.attempts ?? 0);
      });
    },
  };
}

function nullableStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length === 0 ? null : s;
}

function extractAttrs(payloadJson: string): Record<string, unknown> {
  try {
    const span = JSON.parse(payloadJson) as {
      attributes?: readonly OtlpAttribute[];
    };
    return attrMap(span.attributes);
  } catch {
    return {};
  }
}

function projectCodingAgentReport(
  attrs: Record<string, unknown>,
  iterationIndex: number,
): CapturedCodingAgentReport {
  const errorKind = attrs["runway.impl.report.error.kind"];
  if (typeof errorKind === "string") {
    return {
      ok: false,
      kind: "error",
      errorKind,
      message: String(
        attrs["runway.impl.report.error.message"] ?? "(no message)",
      ),
    };
  }
  const payload = attrs["runway.impl.report.payload"];
  const version = attrs["runway.impl.report.template_version"];
  if (typeof payload !== "string" || typeof version !== "string") {
    return {
      ok: false,
      kind: "missing",
      message: "latest impl-iter span has no runway.impl.report.payload attribute",
    };
  }
  return {
    ok: true,
    iterationIndex,
    templateVersion: version,
    payload,
  };
}

function projectReviewerReport(
  attrs: Record<string, unknown>,
): CapturedReviewerReport {
  const errorKind = attrs["runway.review.report.error.kind"];
  if (typeof errorKind === "string") {
    return {
      ok: false,
      kind: "error",
      errorKind,
      message: String(
        attrs["runway.review.report.error.message"] ?? "(no message)",
      ),
    };
  }
  const payload = attrs["runway.review.report.payload"];
  const version = attrs["runway.review.report.template_version"];
  if (typeof payload !== "string" || typeof version !== "string") {
    return {
      ok: false,
      kind: "missing",
      message: "review span has no runway.review.report.payload attribute",
    };
  }
  return { ok: true, templateVersion: version, payload };
}
