import { DatabaseSync } from "node:sqlite";
import type {
  ActiveDrainMarker,
  AgentIterationRow,
  DrainRow,
  IssueProcessRow,
  LogRecordRow,
  RawSpanRow,
} from "./projector.js";

/**
 * VA-455: how stale a drain's last_seen can be before getActiveDrain
 * treats it as crashed and hides it. Runway emits a heartbeat log
 * every 30s while drainQueue is active; 90s gives 3× headroom so a
 * single dropped heartbeat doesn't toggle the dashboard card.
 */
export const ACTIVE_DRAIN_STALENESS_NANOS = 90n * 1_000_000_000n;

/**
 * VA-386 (dashboard slice 1): SQLite storage for the typed projections
 * plus the `raw_spans` JSON escape hatch (per ADR-0001). Schema is
 * intentionally denormalised — every row carries enough to render
 * directly without joins. `raw_spans` lets us debug whatever the
 * projector hasn't promoted to a typed column yet.
 *
 * The module is "deep": callers pass it `DrainRow` / `IssueProcessRow`
 * shapes (defined in projector.ts) and get back row arrays for the
 * list view. The SQL surface stays inside this file so the rest of
 * the dashboard never imports `node:sqlite`.
 */

export interface IssueProcessFilter {
  /** Limit results, default 100 (deep enough for a single drain page). */
  readonly limit?: number;
  /** Optional drain trace id; useful when scoping the list to a drain. */
  readonly traceId?: string;
  /**
   * VA-392: filter to rows whose `outcome_kind` matches one of the
   * given kinds. The synthetic `"in-flight"` kind matches rows where
   * `outcome_kind IS NULL` (i.e. an issue_process that hasn't reached
   * a terminal outcome yet). An empty / undefined array means "any
   * outcome" — the SQL doesn't add a WHERE clause for it.
   */
  readonly outcomes?: readonly OutcomeFilterKind[];
  /**
   * VA-392: lower bound on `inserted_at` (inclusive). Expects the
   * SQLite `datetime('now')` format (`YYYY-MM-DD HH:MM:SS`); the
   * column stores that format and lex-sorts identically to numeric
   * ordering. Undefined means "no lower bound."
   */
  readonly insertedSince?: string;
}

/**
 * VA-392: outcome chip kinds. The four AC-listed values plus the
 * synthetic `"in-flight"` (= `outcome_kind IS NULL`) — i.e. an
 * issue_process whose terminal outcome hasn't been recorded yet.
 */
export type OutcomeFilterKind =
  | "opened"
  | "hitl"
  | "errored"
  | "in-flight";

/**
 * VA-392: one entry in the recent-drains chip set. `traceId` is the
 * drain's trace id (a drain is one trace, end-to-end); the start time
 * is the earliest `issue_processes.start_time_unix_nano` in that
 * trace, mirroring `getActiveDrain`'s clock. `issueCount` is the
 * landed-so-far count so the chip can show a hint like "Drain @ 12:05
 * (3 issues)" even before the drain finishes.
 */
export interface RecentDrain {
  readonly traceId: string;
  readonly startedAtUnixNano: string;
  readonly issueCount: number;
}

export interface StoredIssueProcess extends IssueProcessRow {
  readonly insertedAt: string;
}

export interface StoredAgentIteration extends AgentIterationRow {
  readonly insertedAt: string;
}

/**
 * VA-399: one row per issue-category from `evaluator_aggregates_v1`.
 * Field semantics + versioning policy live in `read-model.md`. The
 * field names mirror the SQL view's columns (snake_case → camelCase)
 * so a SQL query and an HTTP response refer to the same things — IRA
 * prompts reference these by name, and the dashboard UI consumes the
 * exact same shape over `/api/aggregates`.
 */
export interface EvaluatorAggregate {
  readonly category: string;
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
 * VA-389: a generic phase-span row pulled out of `raw_spans` via
 * `json_extract`. The detail pane uses this to render the
 * implement / review / finalize timeline without each phase needing
 * its own typed table — only the implement iterations get a typed
 * table because they're the only phase the AC drills into.
 */
export interface PhaseSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly name: string;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
}

/**
 * VA-390 (dashboard slice 6): one row per Linear issue snapshotted by
 * the poller. `snapshot_at` is when the poller observed the value;
 * `queue_position` is non-null when the issue was returned by
 * `getTodoQueue` (ordered as Linear would pick them up next), and
 * `null` when the row came from `refreshStatus` on a recently-touched
 * issue. PK on `issue_identifier` keeps it to one row per issue —
 * subsequent polls upsert, last writer wins.
 */
export interface LinearSnapshotRow {
  readonly issueIdentifier: string;
  readonly snapshotAt: string;
  readonly status: string;
  readonly title: string;
  readonly labels: readonly string[];
  /** Non-null when the issue is in the Todo queue at last poll. */
  readonly queuePosition: number | null;
  /** VA-450: Linear project UUID, or null when the issue is unprojected. */
  readonly projectId: string | null;
  /** VA-450: Linear project display name, or null when the issue is unprojected. */
  readonly projectName: string | null;
  /**
   * VA-453: Linear `WorkflowState.type` — triage / backlog / unstarted
   * / started / completed / canceled. `""` for rows recorded before
   * the migration; the sync poller only filters when this is a known
   * value, so old rows behave exactly as they did before.
   */
  readonly statusType: string;
}

/**
 * VA-388: row shape returned by `streamLogsFor`. Mirrors `LogRecordRow`
 * (the projector's input shape) plus an `insertedAt` audit timestamp.
 * The dashboard surfaces `level` + `message` + `attributes` in the
 * detail-pane Logs section; the trace_id / span_id pair is what
 * correlates a log record to an issue process row.
 */
export interface StoredLogRecord extends LogRecordRow {
  readonly insertedAt: string;
}

/**
 * VA-391: snapshot of an in-flight drain, computed from `issue_processes`
 * rows whose parent drain hasn't ended yet (the OTel SDK emits span
 * rows on end; an "unfinished drainQueue span" therefore means a
 * trace with one or more issue_processes but no corresponding row
 * in `drains`).
 *
 * `startedAtUnixNano` is the earliest issue_process start in the
 * drain — close-enough to "drain start" for the dashboard's clock.
 * The four counters reflect the rows landed so far for that drain.
 */
export interface ActiveDrain {
  readonly traceId: string;
  readonly startedAtUnixNano: string;
  readonly issueCount: number;
  readonly openedCount: number;
  readonly hitlCount: number;
  readonly erroredCount: number;
}

/**
 * VA-465: per-PR shepherding state, surfaced as a sub-card under the
 * active-drain card. One row per (trace_id, pr_number).
 *
 *   acting — a fix action is currently running
 *   ready  — loop exited cleanly; PR awaits human merge
 *   merged — PR landed (terminal)
 *   hitl   — loop escalated to HITL (terminal)
 */
export type ShepherdingState = "acting" | "ready" | "merged" | "hitl";

export interface ShepherdingPr {
  readonly traceId: string;
  readonly prNumber: number;
  readonly subscription: string | null;
  readonly iteration: number | null;
  readonly maxIterations: number | null;
  readonly state: ShepherdingState;
  readonly description: string | null;
  readonly startedUnixNano: string;
  readonly lastSeenUnixNano: string;
  readonly endedUnixNano: string | null;
}

export interface ShepherdIterationStartMarker {
  readonly traceId: string;
  readonly prNumber: number;
  readonly subscription: string;
  readonly iteration: number;
  readonly maxIterations: number | null;
  readonly description: string;
  readonly timestampUnixNano: string;
}

export interface ShepherdIterationEndMarker {
  readonly traceId: string;
  readonly prNumber: number;
  readonly outcome: "fixed" | "hitl";
  readonly detail: string;
  readonly timestampUnixNano: string;
}

export interface ShepherdEndedMarker {
  readonly traceId: string;
  readonly prNumber: number;
  readonly outcome: "merged" | "ready" | "hitl";
  readonly timestampUnixNano: string;
}

export interface Storage {
  saveDrain(d: DrainRow): void;
  /**
   * VA-455: record an in-flight drain ahead of its end span. Called
   * for every `drain.started` log marker the projector surfaces. The
   * insert is no-op once the drain has actually ended (end_time !=
   * NULL) so late-arriving markers can't reanimate a closed drain.
   */
  markDrainActive(m: ActiveDrainMarker): void;
  saveIssueProcess(p: IssueProcessRow): void;
  saveAgentIteration(a: AgentIterationRow): void;
  saveRawSpan(r: RawSpanRow): void;
  listIssueProcesses(filter?: IssueProcessFilter): readonly StoredIssueProcess[];
  /**
   * VA-392: recent drains for the filter-chip set. Drains are inferred
   * from `issue_processes` grouped by `trace_id` (so both finished and
   * in-flight drains are surfaced), ordered by earliest-start
   * descending. The chip URL filters the list view via `?drain=<id>`.
   */
  listRecentDrains(limit?: number): readonly RecentDrain[];
  /**
   * VA-389: look up an issue process by its (trace_id, span_id) pair.
   * Returns undefined when the row isn't yet known — typical when the
   * dashboard navigates to a detail page from an external link before
   * the OTLP flush has landed.
   */
  getIssueProcess(
    traceId: string,
    spanId: string,
  ): StoredIssueProcess | undefined;
  /**
   * VA-387: look up an issue process by its span_id alone. The detail
   * route at `/issue-processes/:id` keys on span_id so shareable URLs
   * stay short. Span IDs are random 64-bit values; collisions are
   * astronomically unlikely. If two rows somehow share a span_id the
   * most recently inserted one wins.
   */
  getIssueProcessBySpanId(spanId: string): StoredIssueProcess | undefined;
  /**
   * VA-389: iterations sorted ascending by `iteration_index` so the
   * detail pane can render them in execution order without a second
   * pass.
   */
  listAgentIterations(
    traceId: string,
    issueProcessSpanId: string,
  ): readonly StoredAgentIteration[];
  /**
   * VA-389: pull review/finalize phase spans for a given issue
   * process. The names argument is an allowlist — the dashboard
   * passes `["review", "pushBranch", "openPullRequest"]` and gets
   * back the matching spans (if any) with their timing.
   */
  listPhaseSpans(
    traceId: string,
    issueProcessSpanId: string,
    names: readonly string[],
  ): readonly PhaseSpan[];
  /**
   * VA-399: read the evaluator-facing aggregates view. The view
   * computes over the rolling window passed to `createStorage`
   * (defaulting to the last 30 drains). External evaluators can also
   * `SELECT * FROM evaluator_aggregates_v1` directly against the
   * SQLite file — this method is the convenience accessor for the
   * dashboard UI and `/api/aggregates`.
   */
  listAggregates(): readonly EvaluatorAggregate[];
  /**
   * VA-390: upsert a Linear-side snapshot. Driven by the poller's
   * `getTodoQueue` / `refreshStatus` calls. PK is `issue_identifier`,
   * so re-polling the same issue overwrites the prior row.
   */
  saveLinearSnapshot(s: LinearSnapshotRow): void;
  /**
   * VA-390: clear the `queue_position` column for every row. Called
   * by the poller before saving a fresh Todo queue, so issues that
   * dropped out of Todo since the last poll stop appearing in the
   * "Todo queue (next up)" section.
   */
  clearLinearQueuePositions(): void;
  /**
   * VA-390: snapshots for issues currently in the Todo queue
   * (`queue_position IS NOT NULL`), ordered by `queue_position ASC`
   * so the dashboard renders them in pickup order.
   */
  listLinearTodoQueue(): readonly LinearSnapshotRow[];
  /**
   * VA-390: snapshots keyed by `issue_identifier`. The dashboard list
   * view calls this once and overlays per-row status badges without
   * an N+1 round-trip.
   */
  listLinearSnapshots(): readonly LinearSnapshotRow[];
  /**
   * VA-388: append a single log record. The (trace_id, span_id,
   * timestamp_unix_nano) triple is the PK — OTLP delivery is
   * at-least-once, so an exporter retry on a flush would otherwise
   * double-insert. Last writer wins on a duplicate.
   */
  appendLogRecord(r: LogRecordRow): void;
  /**
   * VA-388: log records for a given trace_id, ordered ascending by
   * `timestamp_unix_nano` (the SDK-supplied time, not the receive
   * time) so a Logs section reads chronologically even if records
   * arrived out of order. The detail pane filters this set in JS
   * (cheap — a single drain's log records are bounded).
   *
   * Despite the name "stream", this is a synchronous list read; the
   * verb matches VA-388's AC and signals "everything for this trace,
   * not just one span" without the dashboard having to spell out
   * pagination.
   */
  streamLogsFor(traceId: string): readonly StoredLogRecord[];
  /**
   * VA-391: return the currently in-flight drain, or null when no
   * drain is active. "Active" = a trace_id has issue_processes
   * rows but no `drains` row (the parent drain span hasn't ended
   * yet). When multiple traces match (parallel drains aren't
   * supported in v1 but the SQL doesn't care), the most-recently-
   * started one wins.
   */
  getActiveDrain(): ActiveDrain | null;
  /**
   * VA-465: upsert a shepherding row when an iteration begins. Sets
   * state to `acting`, refreshes subscription/iteration/description,
   * bumps last_seen. Idempotent across out-of-order marker arrival —
   * older timestamps don't clobber newer state.
   */
  markShepherdIterationStart(m: ShepherdIterationStartMarker): void;
  /**
   * VA-465: update last_seen + description on a shepherding row when
   * an iteration completes. `outcome=hitl` does NOT terminate the
   * row (that's `markShepherdEnded`'s job); it only refreshes the
   * sub-card with the last action's verdict.
   */
  markShepherdIterationEnd(m: ShepherdIterationEndMarker): void;
  /**
   * VA-465: terminate a shepherding row (merged / ready / hitl). Sets
   * state to the terminal value, fills ended_unix_nano. Subsequent
   * markers on the same (trace, pr) are ignored when state is
   * already terminal.
   */
  markShepherdEnded(m: ShepherdEndedMarker): void;
  /**
   * VA-465: return active (non-terminal) shepherding rows for the
   * given trace. The sub-card renders one per row. Sorted by
   * started_unix_nano ascending so the operator sees PRs in the
   * order the drain opened them.
   */
  getActiveShepherding(traceId: string): readonly ShepherdingPr[];
  /**
   * VA-402: upsert one row in `meta_reviews`. The IRA's three passes
   * (Run Review, Drain Review, Weekly Review) all write through this
   * single seam. PK is the synthetic `id`, so a re-run of `runway
   * review run` on the same (drain, issue) pair produces a NEW row —
   * historical Run Reviews are preserved for trend analysis. The
   * skip / failed stub rows take the same shape (kind discriminates).
   */
  saveMetaReview(r: MetaReviewRow): void;
  /**
   * VA-402: read meta-reviews matching a scope filter. The IRA's
   * Drain Review pass (VA-406) reads all per-issue rows for one
   * drain; the dashboard UI route (VA-407) reads by `kind` or by
   * synthetic id. Returns rows ordered by `created_at` descending so
   * the freshest review for a given scope is at index 0.
   */
  listMetaReviews(
    filter?: MetaReviewFilter,
  ): readonly StoredMetaReview[];
  /**
   * VA-407: count matching `meta_reviews` rows for a filter. Powers the
   * pagination footer on the `/meta-reviews` list view ("Showing 1–20
   * of 47"). Mirrors `listMetaReviews`' filter shape — same `kind` /
   * `drainId` / `issueId` semantics, ignores `limit` / `offset`.
   */
  countMetaReviews(filter?: MetaReviewFilter): number;
  /**
   * VA-407: fetch one meta_reviews row by synthetic id. The
   * `/meta-reviews/:id` detail route uses this to render the
   * structured review. Returns undefined when the id doesn't match
   * (typo in URL, row deleted, fresh dashboard).
   */
  getMetaReview(id: string): StoredMetaReview | undefined;
  /**
   * VA-407: cross-link helper — given a (trace_id, issue_identifier)
   * pair, return the matching `issue_processes` row so the meta-review
   * detail view can link back to the underlying run via the canonical
   * `/issue-processes/:spanId` route. Returns undefined when no row
   * matches (older runs whose `issue_processes` was never populated,
   * or a Run Review that pointed at the wrong drain).
   */
  findIssueProcessByIdentifier(
    traceId: string,
    issueIdentifier: string,
  ): StoredIssueProcess | undefined;
  close(): void;
}

/**
 * VA-402: one row per IRA output across the three passes. `kind`
 * discriminates between successful reviews and the stub rows the
 * failure / pre-filter paths emit. `template_version` is the SemVer
 * the writing pass used; consumers (the dashboard UI, the next IRA
 * pass) check it before parsing `content_json`.
 *
 *   - `meta-run-review`     — VA-402 (this slice)
 *   - `meta-drain-review`   — VA-406
 *   - `meta-weekly-review`  — VA-408
 *   - `meta-skipped`        — VA-404 heuristic pre-filter skip
 *   - `meta-failed`         — retry exhaustion stub
 *
 * `drain_id` / `issue_id` are populated to the appropriate scope —
 * a Run Review row carries both; a Drain Review carries just
 * `drain_id` (with `issue_id = null`); a Weekly Review carries
 * neither (both null).
 */
export type MetaReviewKind =
  | "meta-run-review"
  | "meta-drain-review"
  | "meta-weekly-review"
  | "meta-skipped"
  | "meta-failed";

/**
 * VA-406: named constants for the `meta_reviews.kind` alphabet.
 * Used by the IRA passes when stamping rows + by gateway queries
 * that filter by kind, so the literal strings live in one place.
 * Type narrows automatically via `as const`.
 */
export const META_REVIEW_KIND = {
  RUN: "meta-run-review",
  DRAIN: "meta-drain-review",
  WEEKLY: "meta-weekly-review",
  SKIPPED: "meta-skipped",
  FAILED: "meta-failed",
} as const satisfies Record<string, MetaReviewKind>;

/**
 * VA-406: kinds that count as "Run Review pass produced a terminal
 * outcome for this issue" — the completion gate for the Drain Review
 * trigger. `meta-skipped` and `meta-failed` both count, per AC.
 */
export const META_RUN_REVIEW_COMPLETION_KINDS = [
  META_REVIEW_KIND.RUN,
  META_REVIEW_KIND.SKIPPED,
  META_REVIEW_KIND.FAILED,
] as const satisfies readonly MetaReviewKind[];

export interface MetaReviewRow {
  readonly id: string;
  readonly kind: MetaReviewKind;
  readonly scope: string;
  readonly drainId: string | null;
  readonly issueId: string | null;
  readonly contentJson: string;
  readonly templateVersion: string;
  readonly createdAt: string;
}

export interface StoredMetaReview extends MetaReviewRow {}

export interface MetaReviewFilter {
  readonly kind?: MetaReviewKind;
  readonly drainId?: string;
  readonly issueId?: string;
  readonly limit?: number;
  /**
   * VA-407: offset-based pagination for the `/meta-reviews` list view.
   * Defaults to 0 (first page). Combined with `limit` to produce the
   * familiar OFFSET/LIMIT pair. Cursor pagination would scale better
   * past ~10k rows, but the meta_reviews table is bounded by the IRA's
   * write cadence (~tens per drain × handful of drains per day) so
   * offset is fine for the dashboard UI's lifetime.
   */
  readonly offset?: number;
}

export interface StorageOptions {
  /**
   * VA-399: rolling-window size for the evaluator aggregates view.
   * Defaults to 30 drains; the dashboard process reads
   * `DASHBOARD_AGGREGATE_WINDOW` and forwards it here. The view is
   * recreated with this N on every `createStorage` call — restart
   * the dashboard to change the window.
   */
  readonly aggregateWindowDrains?: number;
}

const SCHEMA = `
  -- VA-455: end_time_unix_nano is nullable so an "active drain" row
  -- inserted by the drain.started log marker can exist before the
  -- drainQueue span has actually ended. last_seen_unix_nano carries
  -- the most recent log record's timestamp for the trace so the
  -- dashboard's active-drain query can age out crashed drains.
  CREATE TABLE IF NOT EXISTS drains (
    trace_id TEXT NOT NULL,
    span_id TEXT NOT NULL,
    start_time_unix_nano TEXT NOT NULL,
    end_time_unix_nano TEXT,
    last_seen_unix_nano TEXT,
    attempts INTEGER,
    opened INTEGER,
    hitl INTEGER,
    errored INTEGER,
    status_code INTEGER,
    status_message TEXT,
    inserted_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (trace_id, span_id)
  );

  CREATE TABLE IF NOT EXISTS issue_processes (
    trace_id TEXT NOT NULL,
    span_id TEXT NOT NULL,
    parent_span_id TEXT,
    issue_identifier TEXT NOT NULL,
    issue_id TEXT,
    issue_title TEXT,
    issue_labels TEXT,
    branch TEXT,
    outcome_kind TEXT,
    outcome_detail TEXT,
    pr_url TEXT,
    hitl_reason TEXT,
    start_time_unix_nano TEXT NOT NULL,
    end_time_unix_nano TEXT NOT NULL,
    status_code INTEGER,
    status_message TEXT,
    inserted_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (trace_id, span_id)
  );

  CREATE INDEX IF NOT EXISTS idx_issue_processes_inserted_at
    ON issue_processes(inserted_at DESC);

  CREATE INDEX IF NOT EXISTS idx_issue_processes_trace_id
    ON issue_processes(trace_id);

  CREATE INDEX IF NOT EXISTS idx_issue_processes_span_id
    ON issue_processes(span_id);

  CREATE TABLE IF NOT EXISTS raw_spans (
    trace_id TEXT NOT NULL,
    span_id TEXT NOT NULL,
    name TEXT NOT NULL,
    payload TEXT NOT NULL,
    inserted_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (trace_id, span_id)
  );

  CREATE TABLE IF NOT EXISTS agent_iterations (
    trace_id TEXT NOT NULL,
    id TEXT NOT NULL,
    issue_process_id TEXT,
    iteration_index INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    sandcastle_run_id TEXT,
    exit_status TEXT,
    inserted_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (trace_id, id)
  );

  CREATE INDEX IF NOT EXISTS idx_agent_iterations_issue_process
    ON agent_iterations(trace_id, issue_process_id, iteration_index);

  CREATE TABLE IF NOT EXISTS linear_snapshots (
    issue_identifier TEXT PRIMARY KEY,
    snapshot_at TEXT NOT NULL,
    status TEXT NOT NULL,
    title TEXT NOT NULL,
    labels_json TEXT,
    queue_position INTEGER,
    project_id TEXT,
    project_name TEXT,
    status_type TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_linear_snapshots_queue_position
    ON linear_snapshots(queue_position);

  CREATE TABLE IF NOT EXISTS log_records (
    trace_id TEXT NOT NULL,
    span_id TEXT NOT NULL,
    timestamp_unix_nano TEXT NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    attributes_json TEXT,
    inserted_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (trace_id, span_id, timestamp_unix_nano)
  );

  CREATE INDEX IF NOT EXISTS idx_log_records_trace_timestamp
    ON log_records(trace_id, timestamp_unix_nano);

  -- VA-402: IRA outputs. One row per Run / Drain / Weekly review,
  -- plus stub rows for pre-filter skips and retry exhaustions. The
  -- dashboard UI (VA-407) renders by \`kind\`; subsequent IRA passes
  -- read prior rows for context (Weekly reads the week's Run +
  -- Drain reviews; Drain reads the run reviews for its drain).
  CREATE TABLE IF NOT EXISTS meta_reviews (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    scope TEXT NOT NULL,
    drain_id TEXT,
    issue_id TEXT,
    content_json TEXT NOT NULL,
    template_version TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_meta_reviews_drain
    ON meta_reviews(drain_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_meta_reviews_issue
    ON meta_reviews(issue_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_meta_reviews_kind_created
    ON meta_reviews(kind, created_at DESC);

  -- VA-465: per-PR shepherding state surfaced as a sub-card under the
  -- active-drain card. One row per (trace_id, pr_number); the watcher
  -- loop may iterate multiple times per PR before exiting. State
  -- transitions acting -> ready/merged/hitl; the latter three are
  -- terminal and set ended_unix_nano. The projector's three
  -- shepherd.* log markers feed this table; the list view reads
  -- getActiveShepherding(traceId) (non-terminal rows only).
  CREATE TABLE IF NOT EXISTS shepherding_prs (
    trace_id TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    subscription TEXT,
    iteration INTEGER,
    max_iterations INTEGER,
    state TEXT NOT NULL,
    description TEXT,
    started_unix_nano TEXT NOT NULL,
    last_seen_unix_nano TEXT NOT NULL,
    ended_unix_nano TEXT,
    inserted_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (trace_id, pr_number)
  );

  CREATE INDEX IF NOT EXISTS idx_shepherding_prs_trace_active
    ON shepherding_prs(trace_id, ended_unix_nano);
`;

const DEFAULT_AGGREGATE_WINDOW = 30;

/**
 * VA-399: SQL VIEW that computes the evaluator-facing aggregates over
 * the last N drains. N is interpolated at view-creation time because
 * SQLite views can't take parameters — when the dashboard process
 * starts with a different `DASHBOARD_AGGREGATE_WINDOW`, the view is
 * dropped and recreated with the new LIMIT.
 *
 * Median uses the "average of the two middle values when N is even,
 * the middle value when N is odd" convention; p95 uses the
 * nearest-rank method (smallest observed value whose rank meets-or-
 * exceeds 95%). See `read-model.md` for the field-by-field contract.
 *
 * `reviewer_rejection_rate` keys on the detail prefix emitted by
 * `src/review.ts` ("Sub-agent review rejected: ..."). It's a subset
 * of `hitl_escape_rate` — a review rejection routes to HITL, so both
 * rates count the same row.
 */
/**
 * VA-455: relax the `end_time_unix_nano TEXT NOT NULL` constraint on
 * pre-VA-455 `drains` tables so the log-driven active-drain row can
 * land with end_time = NULL. SQLite has no `ALTER COLUMN`, so the
 * idiomatic move is a rebuild — guarded by PRAGMA so fresh installs
 * (which already created the new schema) skip the work.
 */
function relaxDrainsEndTimeNotNull(db: DatabaseSync): void {
  const cols = db
    .prepare("PRAGMA table_info('drains')")
    .all() as unknown as ReadonlyArray<{ name: string; notnull: number }>;
  const endTime = cols.find((c) => c.name === "end_time_unix_nano");
  if (!endTime || endTime.notnull === 0) return;

  // Single transaction so the `drains` name is never absent from the
  // schema between DROP and RENAME — concurrent readers (none today,
  // but cheap insurance) keep seeing the old table until COMMIT.
  db.prepare("BEGIN").run();
  try {
    db.prepare(
      `CREATE TABLE drains_v2 (
        trace_id TEXT NOT NULL,
        span_id TEXT NOT NULL,
        start_time_unix_nano TEXT NOT NULL,
        end_time_unix_nano TEXT,
        last_seen_unix_nano TEXT,
        attempts INTEGER,
        opened INTEGER,
        hitl INTEGER,
        errored INTEGER,
        status_code INTEGER,
        status_message TEXT,
        inserted_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (trace_id, span_id)
      )`,
    ).run();
    db.prepare(
      `INSERT INTO drains_v2 (
        trace_id, span_id, start_time_unix_nano, end_time_unix_nano,
        last_seen_unix_nano, attempts, opened, hitl, errored,
        status_code, status_message, inserted_at
      )
      SELECT
        trace_id, span_id, start_time_unix_nano, end_time_unix_nano,
        last_seen_unix_nano, attempts, opened, hitl, errored,
        status_code, status_message, inserted_at
      FROM drains`,
    ).run();
    db.prepare("DROP TABLE drains").run();
    db.prepare("ALTER TABLE drains_v2 RENAME TO drains").run();
    db.prepare("COMMIT").run();
  } catch (err) {
    db.prepare("ROLLBACK").run();
    throw err;
  }
}

function aggregatesViewDdl(windowDrains: number): string {
  // windowDrains is the only spot we interpolate rather than
  // parameter-bind (CREATE VIEW can't take params). Coerce to a
  // positive integer so a hostile env var can't smuggle SQL through.
  const n = Math.max(1, Math.floor(windowDrains));
  return `
    DROP VIEW IF EXISTS evaluator_aggregates_v1;
    CREATE VIEW evaluator_aggregates_v1 AS
    WITH recent_drains AS (
      SELECT trace_id
      FROM drains
      ORDER BY CAST(start_time_unix_nano AS INTEGER) DESC
      LIMIT ${n}
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
      WHERE ip.trace_id IN (SELECT trace_id FROM recent_drains)
    ),
    wt_ranked AS (
      SELECT
        category,
        wall_time_ms,
        ROW_NUMBER() OVER (PARTITION BY category ORDER BY wall_time_ms) AS rn,
        COUNT(*) OVER (PARTITION BY category) AS cnt
      FROM process_rows
    ),
    it_ranked AS (
      SELECT
        category,
        iteration_count,
        ROW_NUMBER() OVER (PARTITION BY category ORDER BY iteration_count) AS rn,
        COUNT(*) OVER (PARTITION BY category) AS cnt
      FROM process_rows
    ),
    wt_median AS (
      SELECT category, AVG(wall_time_ms * 1.0) AS value
      FROM wt_ranked
      WHERE rn IN ((cnt + 1) / 2, (cnt / 2) + 1)
      GROUP BY category
    ),
    wt_p95 AS (
      SELECT category, MIN(wall_time_ms) AS value
      FROM wt_ranked
      WHERE rn >= (cnt * 95 + 99) / 100
      GROUP BY category
    ),
    it_median AS (
      SELECT category, AVG(iteration_count * 1.0) AS value
      FROM it_ranked
      WHERE rn IN ((cnt + 1) / 2, (cnt / 2) + 1)
      GROUP BY category
    ),
    it_p95 AS (
      SELECT category, MIN(iteration_count) AS value
      FROM it_ranked
      WHERE rn >= (cnt * 95 + 99) / 100
      GROUP BY category
    ),
    rates AS (
      SELECT
        category,
        COUNT(*) AS sample_size,
        AVG(CASE WHEN outcome_kind = 'hitl' AND outcome_detail LIKE 'Sub-agent review rejected%'
                 THEN 1.0 ELSE 0.0 END) AS reviewer_rejection_rate,
        AVG(CASE WHEN outcome_kind = 'reverted' THEN 1.0 ELSE 0.0 END) AS revert_rate,
        AVG(CASE WHEN outcome_kind = 'hitl' THEN 1.0 ELSE 0.0 END) AS hitl_escape_rate,
        AVG(CASE WHEN outcome_kind = 'errored' THEN 1.0 ELSE 0.0 END) AS infra_error_rate
      FROM process_rows
      GROUP BY category
    )
    SELECT
      r.category                AS category,
      r.sample_size             AS sample_size,
      itm.value                 AS median_iteration_count,
      itp.value                 AS p95_iteration_count,
      wtm.value                 AS median_wall_time_ms,
      wtp.value                 AS p95_wall_time_ms,
      r.reviewer_rejection_rate AS reviewer_rejection_rate,
      r.revert_rate             AS revert_rate,
      r.hitl_escape_rate        AS hitl_escape_rate,
      r.infra_error_rate        AS infra_error_rate
    FROM rates r
    LEFT JOIN wt_median wtm ON wtm.category = r.category
    LEFT JOIN wt_p95    wtp ON wtp.category = r.category
    LEFT JOIN it_median itm ON itm.category = r.category
    LEFT JOIN it_p95    itp ON itp.category = r.category
    ORDER BY r.category;
  `;
}

/**
 * Open (or create) a SQLite database at `path` and return a typed
 * `Storage` handle. Pass `:memory:` for tests — the in-memory db
 * lives for the lifetime of the returned handle.
 *
 * INSERTs use `ON CONFLICT ... DO UPDATE` so retried emits (e.g. the
 * OTel SDK retrying a flush) don't blow up the receiver — last writer
 * wins on (trace_id, span_id).
 */
export function createStorage(
  path: string,
  opts: StorageOptions = {},
): Storage {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  // VA-387: idempotent column adds for DBs created against an older
  // schema. `CREATE TABLE IF NOT EXISTS` won't migrate an existing
  // table; SQLite has no `ADD COLUMN IF NOT EXISTS`, so we swallow
  // the duplicate-column error individually. Runs BEFORE VA-399's
  // view install — `evaluator_aggregates_v1` reads from
  // `issue_processes`, so the columns it may query must exist first.
  for (const sql of [
    `ALTER TABLE issue_processes ADD COLUMN issue_title TEXT`,
    `ALTER TABLE issue_processes ADD COLUMN issue_labels TEXT`,
    `ALTER TABLE issue_processes ADD COLUMN pr_url TEXT`,
    `ALTER TABLE issue_processes ADD COLUMN hitl_reason TEXT`,
    // VA-450: project Name + UUID for the Todo queue Project column.
    `ALTER TABLE linear_snapshots ADD COLUMN project_id TEXT`,
    `ALTER TABLE linear_snapshots ADD COLUMN project_name TEXT`,
    // VA-453: workflow-state TYPE (not name) for cancelled/done queue
    // filtering. Old rows decode to "" — the poller only filters on
    // known type values so pre-migration rows behave unchanged.
    `ALTER TABLE linear_snapshots ADD COLUMN status_type TEXT`,
    // VA-455: per-trace heartbeat timestamp for the log-driven active
    // drain query (see SCHEMA above for semantics). Older DBs need
    // the column added in-place.
    `ALTER TABLE drains ADD COLUMN last_seen_unix_nano TEXT`,
  ]) {
    try {
      db.exec(sql);
    } catch {
      // Column already present — fresh CREATE TABLE path, or a prior
      // dashboard boot ran the same migration.
    }
  }

  // VA-469: drop `evaluator_aggregates_v1` before the VA-455 rebuild.
  // SQLite 3.45+ (bundled with Node 26) validates view dependencies
  // during DDL, so `DROP TABLE drains` inside relaxDrainsEndTimeNotNull
  // is rejected with `error in view evaluator_aggregates_v1: no such
  // table: main.drains` when a legacy boot had already installed the
  // view. The view is unconditionally recreated by `aggregatesViewDdl`
  // below, so dropping it here is free on the fresh-install path too.
  db.exec(`DROP VIEW IF EXISTS evaluator_aggregates_v1`);

  // VA-455: SQLite has no `ALTER COLUMN`, so relaxing the original
  // `end_time_unix_nano TEXT NOT NULL` constraint on legacy DBs
  // requires a table-rebuild. Only fire when PRAGMA reports the
  // column is still NOT NULL — fresh installs go through the new
  // SCHEMA above and skip this branch.
  relaxDrainsEndTimeNotNull(db);

  // VA-399: install the evaluator-facing read-model view after the
  // base tables exist (and after VA-387's column migrations above),
  // but before any prepared statement is created — a
  // `SELECT FROM evaluator_aggregates_v1` would otherwise race the
  // DDL on first use.
  db.exec(aggregatesViewDdl(opts.aggregateWindowDrains ?? DEFAULT_AGGREGATE_WINDOW));

  const insertDrain = db.prepare(`
    INSERT INTO drains (
      trace_id, span_id, start_time_unix_nano, end_time_unix_nano,
      last_seen_unix_nano,
      attempts, opened, hitl, errored, status_code, status_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (trace_id, span_id) DO UPDATE SET
      start_time_unix_nano = excluded.start_time_unix_nano,
      end_time_unix_nano = excluded.end_time_unix_nano,
      last_seen_unix_nano = excluded.last_seen_unix_nano,
      attempts = excluded.attempts,
      opened = excluded.opened,
      hitl = excluded.hitl,
      errored = excluded.errored,
      status_code = excluded.status_code,
      status_message = excluded.status_message
  `);

  // VA-455: insert (or refresh last_seen on) the active-drain row
  // when runway emits its `drain.started` log marker. ON CONFLICT
  // guards against two cases:
  //   1. The drainQueue span has already ended (end_time NOT NULL)
  //      — a late-arriving marker can't reanimate a closed drain,
  //      so we leave the row untouched.
  //   2. Repeated markers (shouldn't happen, but if they do we just
  //      bump last_seen forward; monotonic via the MAX comparison).
  const markActiveDrainStmt = db.prepare(`
    INSERT INTO drains (
      trace_id, span_id, start_time_unix_nano,
      end_time_unix_nano, last_seen_unix_nano,
      attempts, opened, hitl, errored,
      status_code, status_message
    ) VALUES (?, ?, ?, NULL, ?, 0, 0, 0, 0, NULL, NULL)
    ON CONFLICT (trace_id, span_id) DO UPDATE SET
      last_seen_unix_nano = excluded.last_seen_unix_nano
    WHERE drains.end_time_unix_nano IS NULL
      AND (
        drains.last_seen_unix_nano IS NULL
        OR CAST(drains.last_seen_unix_nano AS INTEGER)
           < CAST(excluded.last_seen_unix_nano AS INTEGER)
      )
  `);

  // VA-455: every log record carrying a trace_id pushes that
  // trace's active drain's last_seen forward, so the active-drain
  // query can age out crashed drains. UPDATE-only (never inserts)
  // so a stray log record from a trace without a `drain.started`
  // marker doesn't fabricate an active drain.
  const bumpDrainLastSeenStmt = db.prepare(`
    UPDATE drains
    SET last_seen_unix_nano = ?
    WHERE trace_id = ?
      AND end_time_unix_nano IS NULL
      AND (
        last_seen_unix_nano IS NULL
        OR CAST(last_seen_unix_nano AS INTEGER) < CAST(? AS INTEGER)
      )
  `);

  const insertIssueProcess = db.prepare(`
    INSERT INTO issue_processes (
      trace_id, span_id, parent_span_id, issue_identifier, issue_id,
      issue_title, issue_labels, branch, outcome_kind, outcome_detail,
      pr_url, hitl_reason,
      start_time_unix_nano, end_time_unix_nano, status_code, status_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (trace_id, span_id) DO UPDATE SET
      parent_span_id = excluded.parent_span_id,
      issue_identifier = excluded.issue_identifier,
      issue_id = excluded.issue_id,
      issue_title = excluded.issue_title,
      issue_labels = excluded.issue_labels,
      branch = excluded.branch,
      outcome_kind = excluded.outcome_kind,
      outcome_detail = excluded.outcome_detail,
      pr_url = excluded.pr_url,
      hitl_reason = excluded.hitl_reason,
      start_time_unix_nano = excluded.start_time_unix_nano,
      end_time_unix_nano = excluded.end_time_unix_nano,
      status_code = excluded.status_code,
      status_message = excluded.status_message
  `);

  const insertRawSpan = db.prepare(`
    INSERT INTO raw_spans (trace_id, span_id, name, payload)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (trace_id, span_id) DO UPDATE SET
      name = excluded.name,
      payload = excluded.payload
  `);

  const insertAgentIteration = db.prepare(`
    INSERT INTO agent_iterations (
      trace_id, id, issue_process_id, iteration_index,
      started_at, ended_at, sandcastle_run_id, exit_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (trace_id, id) DO UPDATE SET
      issue_process_id = excluded.issue_process_id,
      iteration_index = excluded.iteration_index,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      sandcastle_run_id = excluded.sandcastle_run_id,
      exit_status = excluded.exit_status
  `);

  // Two list variants instead of one with conditional SQL — keeps
  // each prepared statement static.
  const ISSUE_PROCESS_COLUMNS = `
      trace_id, span_id, parent_span_id, issue_identifier, issue_id,
      issue_title, issue_labels, branch, outcome_kind, outcome_detail,
      pr_url, hitl_reason,
      start_time_unix_nano, end_time_unix_nano, status_code, status_message,
      inserted_at
  `;
  // VA-392: listIssueProcesses composes its SQL dynamically because
  // the chip set (outcome / drain / date range) yields up to three
  // optional WHERE clauses with variable-length placeholders. Prepared
  // statements per shape would multiply combinatorially; one
  // dynamically-built statement per call is the simpler trade.

  const getProcessStmt = db.prepare(`
    SELECT ${ISSUE_PROCESS_COLUMNS}
    FROM issue_processes
    WHERE trace_id = ? AND span_id = ?
  `);

  // VA-387: span_id is unique in practice (random 64-bit ids); the
  // detail route at `/issue-processes/:id` keys on span_id alone so
  // operators don't have to type the trace_id in URLs.
  const getProcessBySpanStmt = db.prepare(`
    SELECT ${ISSUE_PROCESS_COLUMNS}
    FROM issue_processes
    WHERE span_id = ?
    ORDER BY inserted_at DESC
    LIMIT 1
  `);

  const listIterations = db.prepare(`
    SELECT
      trace_id, id, issue_process_id, iteration_index,
      started_at, ended_at, sandcastle_run_id, exit_status,
      inserted_at
    FROM agent_iterations
    WHERE trace_id = ? AND issue_process_id = ?
    ORDER BY iteration_index ASC
  `);

  const selectAggregates = db.prepare(
    `SELECT * FROM evaluator_aggregates_v1`,
  );

  const upsertLinearSnapshot = db.prepare(`
    INSERT INTO linear_snapshots (
      issue_identifier, snapshot_at, status, title, labels_json, queue_position,
      project_id, project_name, status_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (issue_identifier) DO UPDATE SET
      snapshot_at = excluded.snapshot_at,
      status = excluded.status,
      title = excluded.title,
      labels_json = excluded.labels_json,
      queue_position = excluded.queue_position,
      project_id = excluded.project_id,
      project_name = excluded.project_name,
      status_type = excluded.status_type
  `);

  const clearQueuePositionsStmt = db.prepare(
    `UPDATE linear_snapshots SET queue_position = NULL`,
  );

  const listTodoQueueStmt = db.prepare(`
    SELECT issue_identifier, snapshot_at, status, title, labels_json, queue_position,
           project_id, project_name, status_type
    FROM linear_snapshots
    WHERE queue_position IS NOT NULL
    ORDER BY queue_position ASC
  `);

  const listAllSnapshotsStmt = db.prepare(`
    SELECT issue_identifier, snapshot_at, status, title, labels_json, queue_position,
           project_id, project_name, status_type
    FROM linear_snapshots
  `);

  // VA-391 + VA-455: "active drain" comes from two paths today.
  //
  //  (a) VA-455 log-driven: a `drains` row with end_time NULL and a
  //      fresh `last_seen_unix_nano` (within the staleness window).
  //      runway emits `Effect.logInfo("drain.started")` at the top
  //      of the drainQueue span; the projector recognises that body
  //      and inserts the row via `markDrainActive`. Subsequent log
  //      records bump last_seen.
  //
  //  (b) VA-391 legacy fallback: a trace_id with issue_processes
  //      rows but no `drains` row at all. Kept so dashboards running
  //      against pre-VA-455 runway binaries still light up — once
  //      the first processIssue ends.
  //
  // The two paths are mutually exclusive by construction (path (a)
  // writes a `drains` row, which excludes the trace from path (b)).
  // Among candidates, most-recently-started wins; v1 only runs one
  // drain at a time but the SQL is robust to a future parallel mode.
  //
  // Bind param: the staleness floor in unix-nanos as a TEXT-encoded
  // integer. Pass `String(BigInt(Date.now()) * 1_000_000n - staleness)`
  // at call time so the query stays a static prepared statement.
  const getActiveDrainStmt = db.prepare(`
    WITH active_candidates AS (
      SELECT
        trace_id,
        start_time_unix_nano AS started_at_unix_nano
      FROM drains
      WHERE end_time_unix_nano IS NULL
        AND last_seen_unix_nano IS NOT NULL
        AND CAST(last_seen_unix_nano AS INTEGER) > CAST(? AS INTEGER)

      UNION ALL

      SELECT
        trace_id,
        CAST(MIN(CAST(start_time_unix_nano AS INTEGER)) AS TEXT)
          AS started_at_unix_nano
      FROM issue_processes
      WHERE trace_id NOT IN (SELECT trace_id FROM drains)
      GROUP BY trace_id
    ),
    chosen AS (
      SELECT trace_id, started_at_unix_nano
      FROM active_candidates
      ORDER BY CAST(started_at_unix_nano AS INTEGER) DESC
      LIMIT 1
    )
    SELECT
      c.trace_id,
      c.started_at_unix_nano,
      COUNT(ip.span_id) AS issue_count,
      COALESCE(SUM(CASE WHEN ip.outcome_kind = 'opened'  THEN 1 ELSE 0 END), 0) AS opened_count,
      COALESCE(SUM(CASE WHEN ip.outcome_kind = 'hitl'    THEN 1 ELSE 0 END), 0) AS hitl_count,
      COALESCE(SUM(CASE WHEN ip.outcome_kind = 'errored' THEN 1 ELSE 0 END), 0) AS errored_count
    FROM chosen c
    LEFT JOIN issue_processes ip ON ip.trace_id = c.trace_id
    GROUP BY c.trace_id, c.started_at_unix_nano
  `);

  const insertLogRecord = db.prepare(`
    INSERT INTO log_records (
      trace_id, span_id, timestamp_unix_nano, level, message, attributes_json
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (trace_id, span_id, timestamp_unix_nano) DO UPDATE SET
      level = excluded.level,
      message = excluded.message,
      attributes_json = excluded.attributes_json
  `);

  // VA-402: meta_reviews upsert. The synthetic `id` is the PK — a
  // re-run of `runway review run` produces a fresh row (callers
  // generate a new id) rather than overwriting prior reviews, so
  // the IRA's track record is preserved.
  const insertMetaReview = db.prepare(`
    INSERT INTO meta_reviews (
      id, kind, scope, drain_id, issue_id, content_json,
      template_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      kind = excluded.kind,
      scope = excluded.scope,
      drain_id = excluded.drain_id,
      issue_id = excluded.issue_id,
      content_json = excluded.content_json,
      template_version = excluded.template_version,
      created_at = excluded.created_at
  `);

  // VA-388: order by SDK-supplied timestamp (CAST to INTEGER so the
  // string-encoded int64 sorts numerically, not lexically) — exporter
  // retries can re-deliver out of order but the operator should see
  // chronological output.
  const listLogsByTrace = db.prepare(`
    SELECT
      trace_id, span_id, timestamp_unix_nano, level, message,
      attributes_json, inserted_at
    FROM log_records
    WHERE trace_id = ?
    ORDER BY CAST(timestamp_unix_nano AS INTEGER) ASC, span_id ASC
  `);

  const saveDrain = (d: DrainRow): void => {
    insertDrain.run(
      d.traceId,
      d.spanId,
      d.startTimeUnixNano,
      d.endTimeUnixNano,
      d.lastSeenUnixNano,
      asInt(d.attempts),
      asInt(d.opened),
      asInt(d.hitl),
      asInt(d.errored),
      asInt(d.statusCode),
      d.statusMessage,
    );
  };

  // VA-455: log-marker-driven insert for in-flight drains. Called
  // from server.ts when `projectLogs` surfaces a `drain.started`
  // record (see `extractActiveDrainMarkers`). The first call lands
  // the row with end_time NULL; subsequent calls (or any log on the
  // trace flowing through `appendLogRecord`) push last_seen forward.
  const markDrainActive = (m: ActiveDrainMarker): void => {
    markActiveDrainStmt.run(
      m.traceId,
      m.spanId,
      m.startTimeUnixNano,
      m.lastSeenUnixNano,
    );
  };

  // VA-465: shepherd-state prepared statements.
  //
  // `markShepherdIterationStartStmt` inserts on first iteration or
  // updates an existing row to bump the iteration / subscription /
  // description / last_seen. The CONFLICT branch only overwrites
  // when (a) the row isn't already terminated AND (b) the incoming
  // timestamp is newer than the stored last_seen — protects against
  // out-of-order batch arrival.
  const markShepherdIterationStartStmt = db.prepare(`
    INSERT INTO shepherding_prs (
      trace_id, pr_number, subscription, iteration, max_iterations,
      state, description, started_unix_nano, last_seen_unix_nano
    ) VALUES (?, ?, ?, ?, ?, 'acting', ?, ?, ?)
    ON CONFLICT (trace_id, pr_number) DO UPDATE SET
      subscription = excluded.subscription,
      iteration = excluded.iteration,
      max_iterations = COALESCE(excluded.max_iterations, shepherding_prs.max_iterations),
      state = 'acting',
      description = excluded.description,
      last_seen_unix_nano = excluded.last_seen_unix_nano
    WHERE shepherding_prs.ended_unix_nano IS NULL
      AND CAST(shepherding_prs.last_seen_unix_nano AS INTEGER)
        < CAST(excluded.last_seen_unix_nano AS INTEGER)
  `);
  // `markShepherdIterationEndStmt` bumps last_seen + description on
  // a row that exists. UPDATE-only (no INSERT) — an end without a
  // start is dropped silently.
  const markShepherdIterationEndStmt = db.prepare(`
    UPDATE shepherding_prs
    SET description = ?, last_seen_unix_nano = ?
    WHERE trace_id = ? AND pr_number = ?
      AND ended_unix_nano IS NULL
      AND CAST(last_seen_unix_nano AS INTEGER) < CAST(? AS INTEGER)
  `);
  // `markShepherdEndedStmt` terminates the row. The CASE WHEN guard
  // protects against a stale end-marker arriving after a fresher
  // start (which can happen with batched OTLP flushes).
  const markShepherdEndedStmt = db.prepare(`
    INSERT INTO shepherding_prs (
      trace_id, pr_number, state, started_unix_nano,
      last_seen_unix_nano, ended_unix_nano
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (trace_id, pr_number) DO UPDATE SET
      state = excluded.state,
      last_seen_unix_nano = excluded.last_seen_unix_nano,
      ended_unix_nano = excluded.ended_unix_nano
    WHERE shepherding_prs.ended_unix_nano IS NULL
      OR CAST(shepherding_prs.ended_unix_nano AS INTEGER)
        < CAST(excluded.ended_unix_nano AS INTEGER)
  `);
  const getActiveShepherdingStmt = db.prepare(`
    SELECT
      trace_id, pr_number, subscription, iteration, max_iterations,
      state, description, started_unix_nano, last_seen_unix_nano,
      ended_unix_nano
    FROM shepherding_prs
    WHERE trace_id = ? AND ended_unix_nano IS NULL
    ORDER BY CAST(started_unix_nano AS INTEGER) ASC
  `);

  const markShepherdIterationStart = (
    m: ShepherdIterationStartMarker,
  ): void => {
    markShepherdIterationStartStmt.run(
      m.traceId,
      m.prNumber,
      m.subscription,
      m.iteration,
      m.maxIterations,
      m.description,
      m.timestampUnixNano,
      m.timestampUnixNano,
    );
  };
  const markShepherdIterationEnd = (m: ShepherdIterationEndMarker): void => {
    markShepherdIterationEndStmt.run(
      m.detail,
      m.timestampUnixNano,
      m.traceId,
      m.prNumber,
      m.timestampUnixNano,
    );
  };
  const markShepherdEnded = (m: ShepherdEndedMarker): void => {
    markShepherdEndedStmt.run(
      m.traceId,
      m.prNumber,
      m.outcome,
      m.timestampUnixNano,
      m.timestampUnixNano,
      m.timestampUnixNano,
    );
  };
  const getActiveShepherding = (
    traceId: string,
  ): readonly ShepherdingPr[] => {
    const rows = getActiveShepherdingStmt.all(traceId) as unknown as ReadonlyArray<{
      trace_id: string;
      pr_number: number;
      subscription: string | null;
      iteration: number | null;
      max_iterations: number | null;
      state: ShepherdingState;
      description: string | null;
      started_unix_nano: string;
      last_seen_unix_nano: string;
      ended_unix_nano: string | null;
    }>;
    return rows.map((r) => ({
      traceId: r.trace_id,
      prNumber: r.pr_number,
      subscription: r.subscription,
      iteration: r.iteration,
      maxIterations: r.max_iterations,
      state: r.state,
      description: r.description,
      startedUnixNano: r.started_unix_nano,
      lastSeenUnixNano: r.last_seen_unix_nano,
      endedUnixNano: r.ended_unix_nano,
    }));
  };

  const saveIssueProcess = (p: IssueProcessRow): void => {
    insertIssueProcess.run(
      p.traceId,
      p.spanId,
      p.parentSpanId,
      p.issueIdentifier,
      p.issueId,
      p.issueTitle,
      // VA-387: labels round-trip as a JSON array string. Keeping them
      // in one column avoids a label-many-to-many table for a feature
      // that's read-only on the dashboard side.
      p.issueLabels.length === 0 ? null : JSON.stringify(p.issueLabels),
      p.branch,
      p.outcomeKind,
      p.outcomeDetail,
      p.prUrl,
      p.hitlReason,
      p.startTimeUnixNano,
      p.endTimeUnixNano,
      asInt(p.statusCode),
      p.statusMessage,
    );
  };

  const saveAgentIteration = (a: AgentIterationRow): void => {
    insertAgentIteration.run(
      a.traceId,
      a.spanId,
      a.issueProcessSpanId,
      asInt(a.iterationIndex),
      a.startTimeUnixNano,
      a.endTimeUnixNano,
      a.sandcastleRunId,
      a.exitStatus,
    );
  };

  const saveRawSpan = (r: RawSpanRow): void => {
    insertRawSpan.run(r.traceId, r.spanId, r.name, r.payload);
  };

  const listIssueProcesses = (
    filter?: IssueProcessFilter,
  ): readonly StoredIssueProcess[] => {
    const limit = filter?.limit ?? 100;
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.traceId) {
      where.push(`trace_id = ?`);
      params.push(filter.traceId);
    }
    if (filter?.insertedSince) {
      where.push(`inserted_at >= ?`);
      params.push(filter.insertedSince);
    }
    if (filter?.outcomes && filter.outcomes.length > 0) {
      // VA-392: the synthetic `"in-flight"` kind matches NULL, every
      // other kind matches the literal `outcome_kind` value. We split
      // the two so the SQL stays standard (`IS NULL` can't appear in
      // an `IN (...)` list).
      const concreteKinds = filter.outcomes.filter(
        (k): k is "opened" | "hitl" | "errored" => k !== "in-flight",
      );
      const includesInFlight = filter.outcomes.includes("in-flight");
      const clauses: string[] = [];
      if (concreteKinds.length > 0) {
        const placeholders = concreteKinds.map(() => "?").join(", ");
        clauses.push(`outcome_kind IN (${placeholders})`);
        params.push(...concreteKinds);
      }
      if (includesInFlight) clauses.push(`outcome_kind IS NULL`);
      if (clauses.length > 0) where.push(`(${clauses.join(" OR ")})`);
    }
    const whereSql = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
    const sql = `
      SELECT ${ISSUE_PROCESS_COLUMNS}
      FROM issue_processes
      ${whereSql}
      ORDER BY inserted_at DESC, span_id DESC
      LIMIT ?
    `;
    params.push(limit);
    const rows = db.prepare(sql).all(...(params as never[]));
    return rows.map(rowToIssueProcess);
  };

  // VA-392: recent drains derived from `issue_processes` so both
  // finished drains (which have a `drains` row) and in-flight ones
  // (which don't yet — BatchSpanProcessor flushes on end) are
  // surfaced together. The chip set is bounded so we don't keep
  // showing ancient drains forever; default to 5.
  const listRecentDrainsStmt = db.prepare(`
    SELECT
      trace_id,
      MIN(start_time_unix_nano) AS started_at_unix_nano,
      COUNT(*) AS issue_count
    FROM issue_processes
    GROUP BY trace_id
    ORDER BY MIN(CAST(start_time_unix_nano AS INTEGER)) DESC
    LIMIT ?
  `);

  const listRecentDrains = (limit = 5): readonly RecentDrain[] => {
    const rows = listRecentDrainsStmt.all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      traceId: String(r.trace_id ?? ""),
      startedAtUnixNano: String(r.started_at_unix_nano ?? ""),
      issueCount: Number(r.issue_count ?? 0),
    }));
  };

  const getIssueProcess = (
    traceId: string,
    spanId: string,
  ): StoredIssueProcess | undefined => {
    const row = getProcessStmt.get(traceId, spanId);
    return row ? rowToIssueProcess(row) : undefined;
  };

  const getIssueProcessBySpanId = (
    spanId: string,
  ): StoredIssueProcess | undefined => {
    const row = getProcessBySpanStmt.get(spanId);
    return row ? rowToIssueProcess(row) : undefined;
  };

  const listAgentIterations = (
    traceId: string,
    issueProcessSpanId: string,
  ): readonly StoredAgentIteration[] => {
    const rows = listIterations.all(traceId, issueProcessSpanId);
    return rows.map(rowToAgentIteration);
  };

  /**
   * VA-389: phase spans (review, pushBranch, openPullRequest) live in
   * `raw_spans` as JSON. SQLite's `json_extract` lets us pull
   * parentSpanId + start/end without re-projecting the payload at
   * insert time. The names allowlist becomes a comma-bind so each
   * call is one prepared statement; we don't precompute a fixed
   * statement because the allowlist could grow per slice.
   */
  const listPhaseSpans = (
    traceId: string,
    issueProcessSpanId: string,
    names: readonly string[],
  ): readonly PhaseSpan[] => {
    if (names.length === 0) return [];
    const placeholders = names.map(() => "?").join(", ");
    const sql = `
      SELECT
        trace_id,
        span_id,
        name,
        json_extract(payload, '$.parentSpanId') AS parent_span_id,
        json_extract(payload, '$.startTimeUnixNano') AS start_time_unix_nano,
        json_extract(payload, '$.endTimeUnixNano') AS end_time_unix_nano
      FROM raw_spans
      WHERE trace_id = ?
        AND json_extract(payload, '$.parentSpanId') = ?
        AND name IN (${placeholders})
      ORDER BY start_time_unix_nano ASC
    `;
    const rows = db
      .prepare(sql)
      .all(traceId, issueProcessSpanId, ...names);
    return rows.map(rowToPhaseSpan);
  };

  const listAggregates = (): readonly EvaluatorAggregate[] =>
    selectAggregates.all().map(rowToAggregate);

  const saveLinearSnapshot = (s: LinearSnapshotRow): void => {
    upsertLinearSnapshot.run(
      s.issueIdentifier,
      s.snapshotAt,
      s.status,
      s.title,
      s.labels.length === 0 ? null : JSON.stringify(s.labels),
      s.queuePosition,
      s.projectId,
      s.projectName,
      s.statusType,
    );
  };

  const clearLinearQueuePositions = (): void => {
    clearQueuePositionsStmt.run();
  };

  const listLinearTodoQueue = (): readonly LinearSnapshotRow[] =>
    listTodoQueueStmt.all().map(rowToLinearSnapshot);

  const listLinearSnapshots = (): readonly LinearSnapshotRow[] =>
    listAllSnapshotsStmt.all().map(rowToLinearSnapshot);

  const appendLogRecord = (r: LogRecordRow): void => {
    insertLogRecord.run(
      r.traceId,
      r.spanId,
      r.timestampUnixNano,
      r.level,
      r.message,
      // VA-388: attributes round-trip as a JSON object string. Same
      // shape as `issue_labels` — an empty/absent attribute set
      // becomes NULL so the column stays small for the common case.
      Object.keys(r.attributes).length === 0
        ? null
        : JSON.stringify(r.attributes),
    );
    // VA-455: piggy-back on every log record to keep the trace's
    // active-drain row "alive" — drives the staleness TTL in
    // getActiveDrain. No-op when no active drain exists for the
    // trace (UPDATE matches zero rows).
    bumpDrainLastSeenStmt.run(
      r.timestampUnixNano,
      r.traceId,
      r.timestampUnixNano,
    );
  };

  const streamLogsFor = (traceId: string): readonly StoredLogRecord[] =>
    listLogsByTrace.all(traceId).map(rowToLogRecord);

  const getActiveDrain = (): ActiveDrain | null => {
    // VA-455: staleness floor — drains whose most recent log record
    // is older than this no longer count as active. Matches the 30s
    // heartbeat cadence on the runway side with a 3× safety margin
    // so a single dropped heartbeat doesn't toggle the card to Idle.
    const stalenessFloorNanos =
      BigInt(Date.now()) * 1_000_000n - ACTIVE_DRAIN_STALENESS_NANOS;
    const row = getActiveDrainStmt.get(String(stalenessFloorNanos)) as
      | Record<string, unknown>
      | undefined;
    if (!row || row.trace_id == null) return null;
    return {
      traceId: String(row.trace_id ?? ""),
      startedAtUnixNano: String(row.started_at_unix_nano ?? ""),
      issueCount: Number(row.issue_count ?? 0),
      openedCount: Number(row.opened_count ?? 0),
      hitlCount: Number(row.hitl_count ?? 0),
      erroredCount: Number(row.errored_count ?? 0),
    };
  };

  const close = (): void => {
    db.close();
  };

  const saveMetaReview = (r: MetaReviewRow): void => {
    insertMetaReview.run(
      r.id,
      r.kind,
      r.scope,
      r.drainId,
      r.issueId,
      r.contentJson,
      r.templateVersion,
      r.createdAt,
    );
  };

  const buildMetaReviewWhere = (
    filter?: MetaReviewFilter,
  ): { sql: string; params: (string | number)[] } => {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter?.kind) {
      where.push(`kind = ?`);
      params.push(filter.kind);
    }
    if (filter?.drainId) {
      where.push(`drain_id = ?`);
      params.push(filter.drainId);
    }
    if (filter?.issueId) {
      where.push(`issue_id = ?`);
      params.push(filter.issueId);
    }
    return {
      sql: where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
      params,
    };
  };

  const listMetaReviews = (
    filter?: MetaReviewFilter,
  ): readonly StoredMetaReview[] => {
    const { sql: whereSql, params } = buildMetaReviewWhere(filter);
    const limit = filter?.limit ?? 100;
    const offset = Math.max(0, Math.floor(filter?.offset ?? 0));
    const sql = `
      SELECT id, kind, scope, drain_id, issue_id, content_json,
             template_version, created_at
      FROM meta_reviews
      ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `;
    const rows = db.prepare(sql).all(...params, limit, offset) as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => ({
      id: String(row.id ?? ""),
      kind: String(row.kind ?? "") as MetaReviewKind,
      scope: String(row.scope ?? ""),
      drainId: nullableStr(row.drain_id),
      issueId: nullableStr(row.issue_id),
      contentJson: String(row.content_json ?? ""),
      templateVersion: String(row.template_version ?? ""),
      createdAt: String(row.created_at ?? ""),
    }));
  };

  const countMetaReviews = (filter?: MetaReviewFilter): number => {
    const { sql: whereSql, params } = buildMetaReviewWhere(filter);
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM meta_reviews ${whereSql}`)
      .get(...params) as { n?: unknown } | undefined;
    return Number(row?.n ?? 0);
  };

  const getMetaReviewStmt = db.prepare(`
    SELECT id, kind, scope, drain_id, issue_id, content_json,
           template_version, created_at
    FROM meta_reviews
    WHERE id = ?
    LIMIT 1
  `);

  const getMetaReview = (id: string): StoredMetaReview | undefined => {
    const row = getMetaReviewStmt.get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id ?? ""),
      kind: String(row.kind ?? "") as MetaReviewKind,
      scope: String(row.scope ?? ""),
      drainId: nullableStr(row.drain_id),
      issueId: nullableStr(row.issue_id),
      contentJson: String(row.content_json ?? ""),
      templateVersion: String(row.template_version ?? ""),
      createdAt: String(row.created_at ?? ""),
    };
  };

  // VA-407: lookup the issue_processes row for a (trace, identifier)
  // pair so the meta-review detail page can cross-link to the canonical
  // `/issue-processes/:spanId` route. Ordered DESC by inserted_at so a
  // retried run picks up the freshest projection.
  const findProcessByIdentifierStmt = db.prepare(`
    SELECT ${ISSUE_PROCESS_COLUMNS}
    FROM issue_processes
    WHERE trace_id = ? AND issue_identifier = ?
    ORDER BY inserted_at DESC
    LIMIT 1
  `);

  const findIssueProcessByIdentifier = (
    traceId: string,
    issueIdentifier: string,
  ): StoredIssueProcess | undefined => {
    const row = findProcessByIdentifierStmt.get(traceId, issueIdentifier);
    return row ? rowToIssueProcess(row) : undefined;
  };

  return {
    saveDrain,
    markDrainActive,
    saveIssueProcess,
    saveAgentIteration,
    saveRawSpan,
    listIssueProcesses,
    listRecentDrains,
    getIssueProcess,
    getIssueProcessBySpanId,
    listAgentIterations,
    listPhaseSpans,
    listAggregates,
    saveLinearSnapshot,
    clearLinearQueuePositions,
    listLinearTodoQueue,
    listLinearSnapshots,
    appendLogRecord,
    streamLogsFor,
    getActiveDrain,
    markShepherdIterationStart,
    markShepherdIterationEnd,
    markShepherdEnded,
    getActiveShepherding,
    saveMetaReview,
    listMetaReviews,
    countMetaReviews,
    getMetaReview,
    findIssueProcessByIdentifier,
    close,
  };
}

// node:sqlite's bind types are TEXT/INTEGER/BLOB/REAL/null. `undefined`
// throws; coerce to `null` so an "unset counter" column round-trips
// cleanly.
function asInt(n: number | null | undefined): number | null {
  return n === null || n === undefined ? null : n;
}

function rowToIssueProcess(row: unknown): StoredIssueProcess {
  const r = row as Record<string, unknown>;
  return {
    traceId: String(r.trace_id ?? ""),
    spanId: String(r.span_id ?? ""),
    parentSpanId: nullableStr(r.parent_span_id),
    issueIdentifier: String(r.issue_identifier ?? ""),
    issueId: nullableStr(r.issue_id),
    issueTitle: nullableStr(r.issue_title),
    issueLabels: parseLabels(r.issue_labels),
    branch: nullableStr(r.branch),
    outcomeKind: nullableStr(r.outcome_kind),
    outcomeDetail: nullableStr(r.outcome_detail),
    prUrl: nullableStr(r.pr_url),
    hitlReason: nullableStr(r.hitl_reason),
    startTimeUnixNano: String(r.start_time_unix_nano ?? ""),
    endTimeUnixNano: String(r.end_time_unix_nano ?? ""),
    statusCode: nullableNum(r.status_code),
    statusMessage: nullableStr(r.status_message),
    insertedAt: String(r.inserted_at ?? ""),
  };
}

/**
 * VA-387: decode the JSON-encoded `issue_labels` column back into a
 * string array. A row stored before the column existed (or one with
 * NULL / malformed JSON) collapses to an empty list.
 */
function parseLabels(v: unknown): readonly string[] {
  if (v === null || v === undefined) return [];
  if (typeof v !== "string") return [];
  try {
    const parsed = JSON.parse(v) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

function rowToAgentIteration(row: unknown): StoredAgentIteration {
  const r = row as Record<string, unknown>;
  return {
    traceId: String(r.trace_id ?? ""),
    spanId: String(r.id ?? ""),
    issueProcessSpanId: nullableStr(r.issue_process_id),
    iterationIndex: Number(r.iteration_index ?? 0),
    startTimeUnixNano: String(r.started_at ?? ""),
    endTimeUnixNano: String(r.ended_at ?? ""),
    sandcastleRunId: nullableStr(r.sandcastle_run_id),
    exitStatus: nullableStr(r.exit_status),
    insertedAt: String(r.inserted_at ?? ""),
  };
}

function rowToPhaseSpan(row: unknown): PhaseSpan {
  const r = row as Record<string, unknown>;
  return {
    traceId: String(r.trace_id ?? ""),
    spanId: String(r.span_id ?? ""),
    parentSpanId: nullableStr(r.parent_span_id),
    name: String(r.name ?? ""),
    startTimeUnixNano: String(r.start_time_unix_nano ?? ""),
    endTimeUnixNano: String(r.end_time_unix_nano ?? ""),
  };
}

function nullableStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

function nullableNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function rowToLinearSnapshot(row: unknown): LinearSnapshotRow {
  const r = row as Record<string, unknown>;
  return {
    issueIdentifier: String(r.issue_identifier ?? ""),
    snapshotAt: String(r.snapshot_at ?? ""),
    status: String(r.status ?? ""),
    title: String(r.title ?? ""),
    labels: parseLabels(r.labels_json),
    queuePosition: nullableNum(r.queue_position),
    projectId: r.project_id == null ? null : String(r.project_id),
    projectName: r.project_name == null ? null : String(r.project_name),
    statusType: r.status_type == null ? "" : String(r.status_type),
  };
}

/**
 * VA-388: decode a `log_records` row back into the projector shape +
 * the audit `insertedAt`. `attributes_json` reverses the JSON-string
 * encoding written by `appendLogRecord`; malformed / null payloads
 * collapse to an empty record so callers can iterate without a
 * null-guard.
 */
function rowToLogRecord(row: unknown): StoredLogRecord {
  const r = row as Record<string, unknown>;
  return {
    traceId: String(r.trace_id ?? ""),
    spanId: String(r.span_id ?? ""),
    timestampUnixNano: String(r.timestamp_unix_nano ?? ""),
    level: String(r.level ?? ""),
    message: String(r.message ?? ""),
    attributes: parseAttributes(r.attributes_json),
    insertedAt: String(r.inserted_at ?? ""),
  };
}

function parseAttributes(v: unknown): Record<string, string> {
  if (v === null || v === undefined) return {};
  if (typeof v !== "string") return {};
  try {
    const parsed = JSON.parse(v) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof val === "string") out[k] = val;
      else if (val !== null && val !== undefined) out[k] = String(val);
    }
    return out;
  } catch {
    return {};
  }
}

function rowToAggregate(row: unknown): EvaluatorAggregate {
  const r = row as Record<string, unknown>;
  return {
    category: String(r.category ?? ""),
    sampleSize: Number(r.sample_size ?? 0),
    medianIterationCount: nullableNum(r.median_iteration_count),
    p95IterationCount: nullableNum(r.p95_iteration_count),
    medianWallTimeMs: nullableNum(r.median_wall_time_ms),
    p95WallTimeMs: nullableNum(r.p95_wall_time_ms),
    reviewerRejectionRate: Number(r.reviewer_rejection_rate ?? 0),
    revertRate: Number(r.revert_rate ?? 0),
    hitlEscapeRate: Number(r.hitl_escape_rate ?? 0),
    infraErrorRate: Number(r.infra_error_rate ?? 0),
  };
}
