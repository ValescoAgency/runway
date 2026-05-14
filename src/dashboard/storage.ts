import { DatabaseSync } from "node:sqlite";
import type {
  AgentIterationRow,
  DrainRow,
  IssueProcessRow,
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
  close(): void;
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
    branch TEXT,
    outcome_kind TEXT,
    outcome_detail TEXT,
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
`;

/**
 * Open (or create) a SQLite database at `path` and return a typed
 * `Storage` handle. Pass `:memory:` for tests — the in-memory db
 * lives for the lifetime of the returned handle.
 *
 * INSERTs use `ON CONFLICT ... DO UPDATE` so retried emits (e.g. the
 * OTel SDK retrying a flush) don't blow up the receiver — last writer
 * wins on (trace_id, span_id).
 */
export function createStorage(path: string): Storage {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);

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
      branch, outcome_kind, outcome_detail,
      start_time_unix_nano, end_time_unix_nano, status_code, status_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (trace_id, span_id) DO UPDATE SET
      parent_span_id = excluded.parent_span_id,
      issue_identifier = excluded.issue_identifier,
      issue_id = excluded.issue_id,
      branch = excluded.branch,
      outcome_kind = excluded.outcome_kind,
      outcome_detail = excluded.outcome_detail,
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
  const listAll = db.prepare(`
    SELECT
      trace_id, span_id, parent_span_id, issue_identifier, issue_id,
      branch, outcome_kind, outcome_detail,
      start_time_unix_nano, end_time_unix_nano, status_code, status_message,
      inserted_at
    FROM issue_processes
    ORDER BY inserted_at DESC, span_id DESC
    LIMIT ?
  `);

  const listByTrace = db.prepare(`
    SELECT
      trace_id, span_id, parent_span_id, issue_identifier, issue_id,
      branch, outcome_kind, outcome_detail,
      start_time_unix_nano, end_time_unix_nano, status_code, status_message,
      inserted_at
    FROM issue_processes
    WHERE trace_id = ?
    ORDER BY inserted_at DESC, span_id DESC
    LIMIT ?
  `);

  const getProcessStmt = db.prepare(`
    SELECT
      trace_id, span_id, parent_span_id, issue_identifier, issue_id,
      branch, outcome_kind, outcome_detail,
      start_time_unix_nano, end_time_unix_nano, status_code, status_message,
      inserted_at
    FROM issue_processes
    WHERE trace_id = ? AND span_id = ?
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
      p.branch,
      p.outcomeKind,
      p.outcomeDetail,
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
    listAgentIterations,
    listPhaseSpans,
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
    branch: nullableStr(r.branch),
    outcomeKind: nullableStr(r.outcome_kind),
    outcomeDetail: nullableStr(r.outcome_detail),
    startTimeUnixNano: String(r.start_time_unix_nano ?? ""),
    endTimeUnixNano: String(r.end_time_unix_nano ?? ""),
    statusCode: nullableNum(r.status_code),
    statusMessage: nullableStr(r.status_message),
    insertedAt: String(r.inserted_at ?? ""),
  };
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
