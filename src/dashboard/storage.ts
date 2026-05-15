import { DatabaseSync } from "node:sqlite";
import type {
  AgentIterationRow,
  DrainRow,
  IssueProcessRow,
  LogRecordRow,
  RawSpanRow,
} from "./projector.js";

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

export interface Storage {
  saveDrain(d: DrainRow): void;
  saveIssueProcess(p: IssueProcessRow): void;
  saveAgentIteration(a: AgentIterationRow): void;
  saveRawSpan(r: RawSpanRow): void;
  listIssueProcesses(filter?: IssueProcessFilter): readonly StoredIssueProcess[];
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
  close(): void;
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
  CREATE TABLE IF NOT EXISTS drains (
    trace_id TEXT NOT NULL,
    span_id TEXT NOT NULL,
    start_time_unix_nano TEXT NOT NULL,
    end_time_unix_nano TEXT NOT NULL,
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
    queue_position INTEGER
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
  ]) {
    try {
      db.exec(sql);
    } catch {
      // Column already present — fresh CREATE TABLE path, or a prior
      // dashboard boot ran the same migration.
    }
  }
  // VA-399: install the evaluator-facing read-model view after the
  // base tables exist (and after VA-387's column migrations above),
  // but before any prepared statement is created — a
  // `SELECT FROM evaluator_aggregates_v1` would otherwise race the
  // DDL on first use.
  db.exec(aggregatesViewDdl(opts.aggregateWindowDrains ?? DEFAULT_AGGREGATE_WINDOW));

  const insertDrain = db.prepare(`
    INSERT INTO drains (
      trace_id, span_id, start_time_unix_nano, end_time_unix_nano,
      attempts, opened, hitl, errored, status_code, status_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (trace_id, span_id) DO UPDATE SET
      start_time_unix_nano = excluded.start_time_unix_nano,
      end_time_unix_nano = excluded.end_time_unix_nano,
      attempts = excluded.attempts,
      opened = excluded.opened,
      hitl = excluded.hitl,
      errored = excluded.errored,
      status_code = excluded.status_code,
      status_message = excluded.status_message
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
  const listAll = db.prepare(`
    SELECT ${ISSUE_PROCESS_COLUMNS}
    FROM issue_processes
    ORDER BY inserted_at DESC, span_id DESC
    LIMIT ?
  `);

  const listByTrace = db.prepare(`
    SELECT ${ISSUE_PROCESS_COLUMNS}
    FROM issue_processes
    WHERE trace_id = ?
    ORDER BY inserted_at DESC, span_id DESC
    LIMIT ?
  `);

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
      issue_identifier, snapshot_at, status, title, labels_json, queue_position
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (issue_identifier) DO UPDATE SET
      snapshot_at = excluded.snapshot_at,
      status = excluded.status,
      title = excluded.title,
      labels_json = excluded.labels_json,
      queue_position = excluded.queue_position
  `);

  const clearQueuePositionsStmt = db.prepare(
    `UPDATE linear_snapshots SET queue_position = NULL`,
  );

  const listTodoQueueStmt = db.prepare(`
    SELECT issue_identifier, snapshot_at, status, title, labels_json, queue_position
    FROM linear_snapshots
    WHERE queue_position IS NOT NULL
    ORDER BY queue_position ASC
  `);

  const listAllSnapshotsStmt = db.prepare(`
    SELECT issue_identifier, snapshot_at, status, title, labels_json, queue_position
    FROM linear_snapshots
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
      asInt(d.attempts),
      asInt(d.opened),
      asInt(d.hitl),
      asInt(d.errored),
      asInt(d.statusCode),
      d.statusMessage,
    );
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
    const rows = filter?.traceId
      ? listByTrace.all(filter.traceId, limit)
      : listAll.all(limit);
    return rows.map(rowToIssueProcess);
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
  };

  const streamLogsFor = (traceId: string): readonly StoredLogRecord[] =>
    listLogsByTrace.all(traceId).map(rowToLogRecord);

  const close = (): void => {
    db.close();
  };

  return {
    saveDrain,
    saveIssueProcess,
    saveAgentIteration,
    saveRawSpan,
    listIssueProcesses,
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
