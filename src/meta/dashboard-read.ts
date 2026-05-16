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

/**
 * VA-405: rolling norms for one issue category, sourced from the
 * VA-399 evaluator-facing read-model. Field shapes mirror
 * `EvaluatorAggregate` (the dashboard's `evaluator_aggregates_v1`
 * view) so a SQL-side and IRA-side reference both point at the same
 * named columns — see `src/dashboard/read-model.md` for the contract.
 *
 * `windowDrains` is echoed back from the loader's request so a Run
 * Review's `# Norms` user-prompt section is self-describing — the
 * IRA's grade can reason about "vs typical of the last N drains"
 * without an out-of-band lookup.
 *
 * `sampleSize < 5` rows are returned verbatim — the IRA's prompt is
 * instructed to caveat small-sample comparisons rather than the
 * gateway pretending they don't exist. Operators inspecting the user
 * prompt should see exactly what the IRA was given.
 */
export interface CapturedNorms {
  readonly category: string;
  readonly windowDrains: number;
  readonly sampleSize: number;
  readonly medianIterationCount: number | null;
  readonly p95IterationCount: number | null;
  readonly medianWallTimeMs: number | null;
  readonly p95WallTimeMs: number | null;
  readonly reviewerRejectionRate: number;
  readonly revertRate: number;
  readonly hitlEscapeRate: number;
  readonly infraErrorRate: number;
}

/**
 * VA-405: derive a comparison cohort from an issue identifier. Mirrors
 * the SQL `CASE WHEN instr(id, '-') > 0 THEN substr(...) ELSE id END`
 * in `evaluator_aggregates_v1` so the gateway and the view agree on
 * what "same kind of issue" means.
 *
 *   "VA-401" → "VA"
 *   "OPS"    → "OPS"
 */
export function categoryFromIssueIdentifier(identifier: string): string {
  const dash = identifier.indexOf("-");
  return dash > 0 ? identifier.slice(0, dash) : identifier;
}

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
  /**
   * VA-405: rolling norms for one issue category over the last N
   * drains. Mirrors the SQL of `evaluator_aggregates_v1` (VA-399's
   * read-model) but is parameterized by `windowDrains` so the IRA can
   * pick its own comparison window without depending on the dashboard
   * process's view configuration. Returns `null` when the category
   * has no rows in the window — first run for a new team prefix, or
   * the window is too short.
   *
   * Queries VA-399's `evaluator_aggregates_v1` view (the read-model
   * contract per `src/dashboard/read-model.md`). The view's actual
   * window N is owned by the dashboard process (set at startup via
   * `DASHBOARD_AGGREGATE_WINDOW`, default 30). `windowDrains` here is
   * an echo / traceability parameter: the IRA records what window it
   * requested in `CapturedNorms.windowDrains` for the prompt, but the
   * underlying numbers reflect whatever the dashboard process is
   * configured for. A future per-call window would be a versioned
   * `_v2` read-model addition (per the view's semver policy).
   */
  loadNorms(
    category: string,
    windowDrains: number,
  ): Effect.Effect<CapturedNorms | null, MetaReadError>;
  /**
   * VA-406: every issue_process row for a drain, projected to the same
   * shape Run Review uses. The Drain Review pass consumes the rollup
   * (outcome distribution + per-issue events). Distinct from
   * `loadIssueProcess` which loads a single (trace, issue) pair.
   *
   * Ordered by start_time_unix_nano ASC so the IRA's prompt can
   * reason about sequencing — "did the schema migration run before or
   * after the UI fix that depends on it?" — without a second pass.
   */
  loadIssueProcessesForDrain(
    traceId: string,
  ): Effect.Effect<readonly CapturedIssueProcess[], MetaReadError>;
  /**
   * VA-406: count of distinct `issue_identifier` values in
   * issue_processes for a drain. The Run Review → Drain Review
   * trigger compares this against `countCompletedRunReviews` to
   * decide if its write was the LAST Run Review for the drain. A
   * dedicated COUNT(DISTINCT ...) query keeps the no-fire hot path
   * cheap — pulling every issue_process row + label JSON + outcome
   * cols just to dedupe in JS would scale linearly with drain size.
   */
  countDistinctIssuesForDrain(
    traceId: string,
  ): Effect.Effect<number, MetaReadError>;
  /**
   * VA-406: count of distinct issues with a terminal Run Review row for
   * a drain (kind in `meta-run-review`, `meta-skipped`, `meta-failed`).
   * Used by the Run Review pass to decide whether its write was the
   * LAST one that the drain was waiting on — if yes, fire Drain Review
   * in-process.
   *
   * Counted as DISTINCT non-null `issue_id` so:
   *   - reruns producing two terminal rows for the same issue don't
   *     inflate the count
   *   - drain-level `meta-failed` stubs (issue_id = null) are ignored
   *
   * Skipped + failed both count as "complete" per the VA-406 AC:
   * "accounting for `meta-skipped` and `meta-failed` rows as
   * \"complete\"." The IRA's drain pass treats them as evidence-of-no-
   * evidence rather than blocking on a retry.
   */
  countCompletedRunReviews(
    traceId: string,
  ): Effect.Effect<number, MetaReadError>;
  /**
   * VA-406: count meta_reviews rows for a drain of kind
   * `meta-drain-review`. The Run Review trigger uses this to avoid
   * firing Drain Review twice for the same drain — operators may
   * legitimately re-run a Run Review (e.g. after a corruption fix),
   * which writes a new completion row, but the drain pass has already
   * fired and we don't want a duplicate verdict.
   */
  countDrainReviews(
    traceId: string,
  ): Effect.Effect<number, MetaReadError>;
  /**
   * VA-406: pull every successful Run Review's contentJson for a
   * drain. The Drain Review pass loads these to grade composition +
   * sequencing + cross-issue patterns. Skipped / failed rows are
   * INCLUDED so the IRA can note "two of the seven runs had no IRA
   * grade — orchestration gap" — that's a drain-review-relevant
   * pattern, not a row to silently drop.
   *
   * Ordered by `created_at ASC` so the prompt reads in pickup order.
   * Returns the raw `MetaReviewRow` shape so the pass can decide how
   * to project (a Drain Review row would just shuttle review.content
   * straight to the LLM; a skipped row carries `reason` and renders
   * as "no IRA grade — uneventful run").
   */
  loadDrainMetaRows(
    traceId: string,
  ): Effect.Effect<readonly DrainMetaRow[], MetaReadError>;
  /**
   * VA-408: pull every Run Review row (`meta-run-review`) whose
   * `created_at` falls within the closed-open ISO window
   * `[startIso, endIso)`. The Weekly Review's promoter parses each
   * row's `content_json` to extract Recommendations; the LLM reads
   * the same rows for narrative context. Ordered ascending by
   * `created_at` so the prompt reads in time order.
   */
  loadRunReviewsInWindow(
    startIso: string,
    endIso: string,
  ): Effect.Effect<readonly WindowedMetaRow[], MetaReadError>;
  /**
   * VA-408: pull every Drain Review row (`meta-drain-review`) in the
   * same window. Drain Reviews aren't a promoter input directly (the
   * cross-issue patterns surface there are already structural), but
   * the LLM reads them for narrative shape and to spot drains the
   * Weekly Review should call out.
   */
  loadDrainReviewsInWindow(
    startIso: string,
    endIso: string,
  ): Effect.Effect<readonly WindowedMetaRow[], MetaReadError>;
  /**
   * VA-408: pull the N most-recent Weekly Review rows. PRD spec is
   * "prior 4 Weekly Reviews" — the LLM uses these for trend grounding
   * and to check what was promised vs delivered. Ordered descending
   * by `created_at` (freshest first).
   */
  loadRecentWeeklyReviews(
    limit: number,
  ): Effect.Effect<readonly WindowedMetaRow[], MetaReadError>;
  /**
   * VA-409: compute post-ship aggregates for one issue category over
   * drains whose start time is at or after `sinceIso`. Mirrors the
   * structure of `evaluator_aggregates_v1` (VA-399) but parameterized
   * by time (not drain count) and filtered to a single category.
   *
   * The attribution loop calls this once per shipped promotion using
   * the issue's `completedAt` as the cutoff and the issue's category
   * (derived from `issue_identifier` per `categoryFromIssueIdentifier`).
   * Returns null when no `issue_processes` rows match — the loop maps
   * that to a 0-sample `PostShipMetrics` so the PENDING verdict path
   * fires cleanly.
   */
  loadPostShipMetrics(
    category: string,
    sinceIso: string,
  ): Effect.Effect<PostShipMetrics | null, MetaReadError>;
}

/**
 * VA-406: minimal shape per meta_reviews row the Drain Review pass
 * needs. Mirrors `StoredMetaReview` (in dashboard/storage.ts) but
 * lives here so dashboard-read's consumers don't have to import from
 * the write-side gateway.
 */
export interface DrainMetaRow {
  readonly id: string;
  readonly kind: string;
  readonly issueId: string | null;
  readonly contentJson: string;
  readonly templateVersion: string;
  readonly createdAt: string;
}

/**
 * VA-408: meta_reviews row projected for the Weekly Review pass's
 * windowed reads. Adds `drainId` vs `DrainMetaRow` so the LLM prompt
 * can group cross-drain patterns and so promoter sources reference
 * the correct drain. Same column set otherwise.
 */
export interface WindowedMetaRow {
  readonly id: string;
  readonly kind: string;
  readonly drainId: string | null;
  readonly issueId: string | null;
  readonly contentJson: string;
  readonly templateVersion: string;
  readonly createdAt: string;
}

/**
 * VA-409: post-ship metric aggregates for one issue category, computed
 * over drains that started at or after `sinceIso`. Field shapes mirror
 * `CapturedNorms` / `EvaluatorAggregate` so the same metric vocabulary
 * applies — the difference is the cohort filter: norms read the rolling
 * window; post-ship reads the time-bounded window scoped to "after this
 * promotion shipped". A null return (sample_size === 0) means no
 * post-ship runs accrued yet; the attribution loop maps that to a
 * PENDING verdict.
 *
 * Distinct from `CapturedNorms` because `windowDrains` doesn't apply
 * (the filter is time-based, not drain-count-based); `sinceIso` is
 * echoed back instead for prompt traceability.
 */
export interface PostShipMetrics {
  readonly category: string;
  readonly sinceIso: string;
  readonly sampleSize: number;
  readonly medianIterationCount: number | null;
  readonly p95IterationCount: number | null;
  readonly medianWallTimeMs: number | null;
  readonly p95WallTimeMs: number | null;
  readonly reviewerRejectionRate: number;
  readonly revertRate: number;
  readonly hitlEscapeRate: number;
  readonly infraErrorRate: number;
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

  // VA-405: read rolling norms straight from VA-399's evaluator-
  // facing view. The view name + column shape is the IRA's stable
  // contract per `src/dashboard/read-model.md`; changes that rename a
  // column require a versioned `_v2` view, not an in-place edit.
  //
  // The view's window N is the dashboard process's setting (env
  // `DASHBOARD_AGGREGATE_WINDOW`, default 30). `loadNorms`' window
  // parameter is echoed back in the projected `CapturedNorms` shape
  // for the IRA's user prompt but does not affect this query — see
  // the gateway interface's doc-comment.
  const selectNorms = db.prepare(`
    SELECT
      sample_size,
      median_iteration_count,
      p95_iteration_count,
      median_wall_time_ms,
      p95_wall_time_ms,
      reviewer_rejection_rate,
      revert_rate,
      hitl_escape_rate,
      infra_error_rate
    FROM evaluator_aggregates_v1
    WHERE category = ?
  `);

  // VA-406: every issue_process row for one drain, ordered by start
  // time. Returns the same projected shape the single-row gateway uses
  // so callers can reuse `CapturedIssueProcess` consumers.
  const selectIssueProcessesForDrain = db.prepare(`
    SELECT trace_id, span_id, issue_identifier, issue_id, issue_title,
           issue_labels, branch, outcome_kind, outcome_detail, pr_url,
           hitl_reason, start_time_unix_nano, end_time_unix_nano
    FROM issue_processes
    WHERE trace_id = ?
    ORDER BY CAST(start_time_unix_nano AS INTEGER) ASC, span_id ASC
  `);

  // VA-406: distinct-identifier count for trigger checks. SQL handles
  // the dedupe so the trigger doesn't pay to load + project every row
  // on every Run Review write.
  const selectDistinctIssueCount = db.prepare(`
    SELECT COUNT(DISTINCT issue_identifier) AS n
    FROM issue_processes
    WHERE trace_id = ?
  `);

  // VA-406: count distinct per-issue terminal Run Review rows for a
  // drain. Skipped + failed both count as "complete" per the AC —
  // they're terminal Run Review outcomes, not retries. We count
  // DISTINCT issue_id (and exclude null) so that:
  //   - reruns producing two terminal rows for the same issue don't
  //     falsely satisfy the trigger gate while another issue is still
  //     missing
  //   - drain-level `meta-failed` stubs (issue_id = null, written by a
  //     failed Drain Review) don't contribute to the completion count
  const selectCompletedRunReviewCount = db.prepare(`
    SELECT COUNT(DISTINCT issue_id) AS n
    FROM meta_reviews
    WHERE drain_id = ?
      AND issue_id IS NOT NULL
      AND kind IN ('meta-run-review', 'meta-skipped', 'meta-failed')
  `);

  // VA-406: count meta_reviews rows for a drain of kind meta-drain-review.
  // Used by the Run Review trigger to avoid firing the Drain Review
  // pass twice for the same drain.
  const selectDrainReviewCount = db.prepare(`
    SELECT COUNT(*) AS n
    FROM meta_reviews
    WHERE drain_id = ?
      AND kind = 'meta-drain-review'
  `);

  // VA-406: pull every meta_reviews row for a drain so the Drain Review
  // pass can project per-issue summaries + cross-link URLs. Includes
  // skipped + failed rows alongside meta-run-review — the drain pass
  // notes their absence-of-grade as an observation.
  const selectDrainMetaRows = db.prepare(`
    SELECT id, kind, issue_id, content_json, template_version, created_at
    FROM meta_reviews
    WHERE drain_id = ?
      AND kind IN ('meta-run-review', 'meta-skipped', 'meta-failed')
    ORDER BY created_at ASC, id ASC
  `);

  // VA-408: Run Reviews + skipped/failed Run Review stubs in a time
  // window. The promoter walks these for Recommendation extraction;
  // the LLM walks the same set for narrative context. We INCLUDE
  // skipped + failed stubs so the LLM can call out coverage gaps —
  // a week with five `meta-failed` rows is a story the Weekly Review
  // should tell.
  const selectRunReviewsInWindow = db.prepare(`
    SELECT id, kind, drain_id, issue_id, content_json, template_version, created_at
    FROM meta_reviews
    WHERE kind IN ('meta-run-review', 'meta-skipped', 'meta-failed')
      AND created_at >= ?
      AND created_at < ?
    ORDER BY created_at ASC, id ASC
  `);

  // VA-408: Drain Reviews in the same window. Kind-only filter; no
  // skipped/failed stub equivalent at the drain level for VA-408's
  // first pass (the drain-level meta-failed stubs that VA-406 may
  // write are tagged `meta-failed`, not `meta-drain-review`, and
  // they're already covered by `selectRunReviewsInWindow` if you
  // need them — but the Weekly Review pass uses them for context,
  // not as Drain Review evidence).
  const selectDrainReviewsInWindow = db.prepare(`
    SELECT id, kind, drain_id, issue_id, content_json, template_version, created_at
    FROM meta_reviews
    WHERE kind = 'meta-drain-review'
      AND created_at >= ?
      AND created_at < ?
    ORDER BY created_at ASC, id ASC
  `);

  // VA-408: prior Weekly Reviews for context. Ordered descending so
  // limit-N returns the freshest N rows.
  const selectRecentWeeklyReviews = db.prepare(`
    SELECT id, kind, drain_id, issue_id, content_json, template_version, created_at
    FROM meta_reviews
    WHERE kind = 'meta-weekly-review'
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `);

  // VA-409: post-ship aggregates for one issue category over drains
  // that started at or after a given nanosecond timestamp. Mirrors the
  // structure of `evaluator_aggregates_v1` (VA-399's read-model) but
  // parameterized by time (not drain count) and scoped to a single
  // category at the outermost SELECT so the IRA can grade one shipped
  // promotion at a time.
  //
  // Two bind parameters, both bound as INTEGER text:
  //   ?1 — `start_time_unix_nano >= ?` (the post-ship cutoff in nanos)
  //   ?2 — `category` for the per-category filter
  const selectPostShipMetrics = db.prepare(`
    WITH post_ship_drains AS (
      SELECT trace_id
      FROM drains
      WHERE CAST(start_time_unix_nano AS INTEGER) >= ?
    ),
    process_rows AS (
      SELECT
        ip.trace_id,
        ip.span_id,
        ip.outcome_kind,
        COALESCE(ip.outcome_detail, '') AS outcome_detail,
        CASE
          WHEN instr(ip.issue_identifier, '-') > 0
            THEN substr(ip.issue_identifier, 1, instr(ip.issue_identifier, '-') - 1)
          ELSE ip.issue_identifier
        END AS category,
        (CAST(ip.end_time_unix_nano AS INTEGER) - CAST(ip.start_time_unix_nano AS INTEGER)) / 1000000 AS wall_time_ms,
        (
          SELECT COUNT(*) FROM agent_iterations a
          WHERE a.trace_id = ip.trace_id AND a.issue_process_id = ip.span_id
        ) AS iteration_count
      FROM issue_processes ip
      WHERE ip.trace_id IN (SELECT trace_id FROM post_ship_drains)
    ),
    in_category AS (
      SELECT *
      FROM process_rows
      WHERE category = ?
    ),
    wt_ranked AS (
      SELECT
        wall_time_ms,
        ROW_NUMBER() OVER (ORDER BY wall_time_ms) AS rn,
        COUNT(*) OVER () AS cnt
      FROM in_category
    ),
    it_ranked AS (
      SELECT
        iteration_count,
        ROW_NUMBER() OVER (ORDER BY iteration_count) AS rn,
        COUNT(*) OVER () AS cnt
      FROM in_category
    ),
    wt_median AS (
      SELECT AVG(wall_time_ms * 1.0) AS value
      FROM wt_ranked
      WHERE rn IN ((cnt + 1) / 2, (cnt / 2) + 1)
    ),
    wt_p95 AS (
      SELECT MIN(wall_time_ms) AS value
      FROM wt_ranked
      WHERE rn >= (cnt * 95 + 99) / 100
    ),
    it_median AS (
      SELECT AVG(iteration_count * 1.0) AS value
      FROM it_ranked
      WHERE rn IN ((cnt + 1) / 2, (cnt / 2) + 1)
    ),
    it_p95 AS (
      SELECT MIN(iteration_count) AS value
      FROM it_ranked
      WHERE rn >= (cnt * 95 + 99) / 100
    )
    SELECT
      (SELECT COUNT(*) FROM in_category) AS sample_size,
      (SELECT value FROM it_median) AS median_iteration_count,
      (SELECT value FROM it_p95) AS p95_iteration_count,
      (SELECT value FROM wt_median) AS median_wall_time_ms,
      (SELECT value FROM wt_p95) AS p95_wall_time_ms,
      (
        SELECT AVG(CASE WHEN outcome_kind = 'hitl' AND outcome_detail LIKE 'Sub-agent review rejected%'
                       THEN 1.0 ELSE 0.0 END)
        FROM in_category
      ) AS reviewer_rejection_rate,
      (
        SELECT AVG(CASE WHEN outcome_kind = 'reverted' THEN 1.0 ELSE 0.0 END)
        FROM in_category
      ) AS revert_rate,
      (
        SELECT AVG(CASE WHEN outcome_kind = 'hitl' THEN 1.0 ELSE 0.0 END)
        FROM in_category
      ) AS hitl_escape_rate,
      (
        SELECT AVG(CASE WHEN outcome_kind = 'errored' THEN 1.0 ELSE 0.0 END)
        FROM in_category
      ) AS infra_error_rate
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
        return projectIssueProcessRow(row);
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

    loadNorms(category, windowDrains) {
      return wrap("loadNorms", () => {
        // Coerce window to a positive integer for the echo field — the
        // view itself ignores it, but `CapturedNorms.windowDrains`
        // feeds the IRA's user prompt and should not advertise `-3` or
        // `NaN`. Bigger story (per-call window) lives in the gateway
        // doc-comment.
        const n = Math.max(1, Math.floor(windowDrains));
        const row = selectNorms.get(category) as
          | Record<string, unknown>
          | undefined;
        // The aggregator returns a single-row result; sample_size is
        // the only field that distinguishes "no rows" from "rows with
        // null medians". A sample of zero is the null case — the IRA
        // sees no norms for this category and gracefully emits null
        // relatives.
        const sampleSize = Number(row?.sample_size ?? 0);
        if (sampleSize === 0) return null;
        return {
          category,
          windowDrains: n,
          sampleSize,
          medianIterationCount: nullableNum(row?.median_iteration_count),
          p95IterationCount: nullableNum(row?.p95_iteration_count),
          medianWallTimeMs: nullableNum(row?.median_wall_time_ms),
          p95WallTimeMs: nullableNum(row?.p95_wall_time_ms),
          reviewerRejectionRate: Number(row?.reviewer_rejection_rate ?? 0),
          revertRate: Number(row?.revert_rate ?? 0),
          hitlEscapeRate: Number(row?.hitl_escape_rate ?? 0),
          infraErrorRate: Number(row?.infra_error_rate ?? 0),
        } satisfies CapturedNorms;
      });
    },

    loadIssueProcessesForDrain(traceId) {
      return wrap("loadIssueProcessesForDrain", () => {
        const rows = selectIssueProcessesForDrain.all(traceId) as Array<
          Record<string, unknown>
        >;
        return rows.map(projectIssueProcessRow);
      });
    },

    countDistinctIssuesForDrain(traceId) {
      return wrap("countDistinctIssuesForDrain", () => {
        const row = selectDistinctIssueCount.get(traceId) as
          | Record<string, unknown>
          | undefined;
        return Number(row?.n ?? 0);
      });
    },

    countCompletedRunReviews(traceId) {
      return wrap("countCompletedRunReviews", () => {
        const row = selectCompletedRunReviewCount.get(traceId) as
          | Record<string, unknown>
          | undefined;
        return Number(row?.n ?? 0);
      });
    },

    countDrainReviews(traceId) {
      return wrap("countDrainReviews", () => {
        const row = selectDrainReviewCount.get(traceId) as
          | Record<string, unknown>
          | undefined;
        return Number(row?.n ?? 0);
      });
    },

    loadDrainMetaRows(traceId) {
      return wrap("loadDrainMetaRows", () => {
        const rows = selectDrainMetaRows.all(traceId) as Array<
          Record<string, unknown>
        >;
        return rows.map((row) => ({
          id: String(row.id ?? ""),
          kind: String(row.kind ?? ""),
          issueId: nullableStr(row.issue_id),
          contentJson: String(row.content_json ?? ""),
          templateVersion: String(row.template_version ?? ""),
          createdAt: String(row.created_at ?? ""),
        } satisfies DrainMetaRow));
      });
    },

    loadRunReviewsInWindow(startIso, endIso) {
      return wrap("loadRunReviewsInWindow", () => {
        const rows = selectRunReviewsInWindow.all(startIso, endIso) as Array<
          Record<string, unknown>
        >;
        return rows.map(projectWindowedMetaRow);
      });
    },

    loadDrainReviewsInWindow(startIso, endIso) {
      return wrap("loadDrainReviewsInWindow", () => {
        const rows = selectDrainReviewsInWindow.all(
          startIso,
          endIso,
        ) as Array<Record<string, unknown>>;
        return rows.map(projectWindowedMetaRow);
      });
    },

    loadRecentWeeklyReviews(limit) {
      return wrap("loadRecentWeeklyReviews", () => {
        const n = Math.max(0, Math.floor(limit));
        if (n === 0) return [];
        const rows = selectRecentWeeklyReviews.all(n) as Array<
          Record<string, unknown>
        >;
        return rows.map(projectWindowedMetaRow);
      });
    },

    loadPostShipMetrics(category, sinceIso) {
      return wrap("loadPostShipMetrics", () => {
        // ISO → unix nanos for the SQL bind. `Date.parse` returns ms;
        // multiply to nanos so the comparison against the column's
        // int64-as-text value lines up. A malformed ISO falls through
        // to NaN; the comparison then returns no rows (sample_size: 0)
        // which the caller treats as PENDING.
        const ms = Date.parse(sinceIso);
        if (!Number.isFinite(ms)) return null;
        const sinceNanos = String(ms * 1_000_000);
        const row = selectPostShipMetrics.get(sinceNanos, category) as
          | Record<string, unknown>
          | undefined;
        const sampleSize = Number(row?.sample_size ?? 0);
        if (sampleSize === 0) return null;
        return {
          category,
          sinceIso,
          sampleSize,
          medianIterationCount: nullableNum(row?.median_iteration_count),
          p95IterationCount: nullableNum(row?.p95_iteration_count),
          medianWallTimeMs: nullableNum(row?.median_wall_time_ms),
          p95WallTimeMs: nullableNum(row?.p95_wall_time_ms),
          reviewerRejectionRate: Number(row?.reviewer_rejection_rate ?? 0),
          revertRate: Number(row?.revert_rate ?? 0),
          hitlEscapeRate: Number(row?.hitl_escape_rate ?? 0),
          infraErrorRate: Number(row?.infra_error_rate ?? 0),
        } satisfies PostShipMetrics;
      });
    },
  };
}

// VA-408: shared row projection for the windowed meta-review reads.
// Kept module-private since the projection couples directly to the
// SQL SELECT column shape.
function projectWindowedMetaRow(
  row: Record<string, unknown>,
): WindowedMetaRow {
  return {
    id: String(row.id ?? ""),
    kind: String(row.kind ?? ""),
    drainId: nullableStr(row.drain_id),
    issueId: nullableStr(row.issue_id),
    contentJson: String(row.content_json ?? ""),
    templateVersion: String(row.template_version ?? ""),
    createdAt: String(row.created_at ?? ""),
  };
}

// VA-406: shared row projection for both single-row (`loadIssueProcess`)
// and per-drain (`loadIssueProcessesForDrain`) reads. Kept module-private
// because the projection couples directly to the SQL column shape.
function projectIssueProcessRow(
  row: Record<string, unknown>,
): CapturedIssueProcess {
  return {
    traceId: String(row.trace_id ?? ""),
    spanId: String(row.span_id ?? ""),
    issueIdentifier: String(row.issue_identifier ?? ""),
    issueId: nullableStr(row.issue_id),
    issueTitle: nullableStr(row.issue_title),
    issueLabels: parseIssueLabels(row.issue_labels),
    branch: nullableStr(row.branch),
    outcomeKind: nullableStr(row.outcome_kind),
    outcomeDetail: nullableStr(row.outcome_detail),
    prUrl: nullableStr(row.pr_url),
    hitlReason: nullableStr(row.hitl_reason),
    startTimeUnixNano: String(row.start_time_unix_nano ?? ""),
    endTimeUnixNano: String(row.end_time_unix_nano ?? ""),
  };
}

function parseIssueLabels(raw: unknown): readonly string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function nullableStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length === 0 ? null : s;
}

function nullableNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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
