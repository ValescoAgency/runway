import { DatabaseSync } from "node:sqlite";
import type { DrainRow, IssueProcessRow, RawSpanRow } from "./projector.js";

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

export interface Storage {
  saveDrain(d: DrainRow): void;
  saveIssueProcess(p: IssueProcessRow): void;
  saveRawSpan(r: RawSpanRow): void;
  listIssueProcesses(filter?: IssueProcessFilter): readonly StoredIssueProcess[];
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

  const close = (): void => {
    db.close();
  };

  return {
    saveDrain,
    saveIssueProcess,
    saveRawSpan,
    listIssueProcesses,
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

function nullableStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

function nullableNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
