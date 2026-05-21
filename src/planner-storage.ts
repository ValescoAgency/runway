import { DatabaseSync } from "node:sqlite";
import type {
  PlannerActionRow,
  PlannerActionStatus,
  PlannerCapability,
  PlannerRecommendationRow,
  RecommendationSource,
  RecommendationStatus,
} from "./dashboard/storage.js";

/**
 * VA-475: read-only SQLite client for the planner daemon. The planner
 * shares the dashboard's SQLite file but never writes to it — ADR
 * 0004 § Writer model establishes the dashboard as the sole writer.
 * Opening with `{ readOnly: true }` enforces that at the SQLite layer
 * (any accidental UPDATE/INSERT throws). DDL never runs from this
 * connection, so the dashboard's schema is authoritative.
 *
 * The same `planner_recommendations` and `planner_actions` tables
 * the dashboard writes (VA-474) are read here. Row mappers mirror
 * the dashboard's, kept in lock-step.
 */

export interface PlannerReadClient {
  readonly getRecentRecommendations: (
    opts?: { status?: RecommendationStatus | "all"; limit?: number },
  ) => readonly PlannerRecommendationRow[];
  readonly getRecommendation: (
    recommendationId: string,
  ) => PlannerRecommendationRow | undefined;
  readonly getActions: (
    opts?: { status?: PlannerActionStatus | "all" },
  ) => readonly PlannerActionRow[];
  readonly close: () => void;
}

export interface PlannerReadClientOptions {
  readonly sqlitePath: string;
}

export function createPlannerReadClient(
  opts: PlannerReadClientOptions,
): PlannerReadClient {
  // `readOnly: true` requires the file to exist already — node:sqlite
  // refuses to create a fresh DB in this mode. That's exactly the
  // safety property we want: the planner cannot accidentally
  // bootstrap a half-schema'd file the dashboard later opens.
  const db = new DatabaseSync(opts.sqlitePath, { readOnly: true });

  const getRecentRecommendationsAllStmt = db.prepare(`
    SELECT
      recommendation_id, capability, target, summary, evidence_json,
      status, proposed_unix_nano, decided_unix_nano, decided_by,
      decision_reason, auto_approve_eligible
    FROM planner_recommendations
    ORDER BY CAST(proposed_unix_nano AS INTEGER) DESC
    LIMIT ?
  `);
  const getRecentRecommendationsByStatusStmt = db.prepare(`
    SELECT
      recommendation_id, capability, target, summary, evidence_json,
      status, proposed_unix_nano, decided_unix_nano, decided_by,
      decision_reason, auto_approve_eligible
    FROM planner_recommendations
    WHERE status = ?
    ORDER BY CAST(proposed_unix_nano AS INTEGER) DESC
    LIMIT ?
  `);
  const getRecommendationStmt = db.prepare(`
    SELECT
      recommendation_id, capability, target, summary, evidence_json,
      status, proposed_unix_nano, decided_unix_nano, decided_by,
      decision_reason, auto_approve_eligible
    FROM planner_recommendations
    WHERE recommendation_id = ?
  `);
  const getActionsAllStmt = db.prepare(`
    SELECT
      action_id, recommendation_id, capability, target, status,
      started_unix_nano, ended_unix_nano, outcome, error
    FROM planner_actions
    ORDER BY CAST(started_unix_nano AS INTEGER) DESC
    LIMIT 100
  `);
  const getActionsByStatusStmt = db.prepare(`
    SELECT
      action_id, recommendation_id, capability, target, status,
      started_unix_nano, ended_unix_nano, outcome, error
    FROM planner_actions
    WHERE status = ?
    ORDER BY CAST(started_unix_nano AS INTEGER) DESC
    LIMIT 100
  `);

  const getRecentRecommendations = (
    opts: { status?: RecommendationStatus | "all"; limit?: number } = {},
  ): readonly PlannerRecommendationRow[] => {
    const limit = opts.limit ?? 50;
    const status = opts.status ?? "all";
    const rows =
      status === "all"
        ? (getRecentRecommendationsAllStmt.all(
            limit,
          ) as unknown as ReadonlyArray<Record<string, unknown>>)
        : (getRecentRecommendationsByStatusStmt.all(
            status,
            limit,
          ) as unknown as ReadonlyArray<Record<string, unknown>>);
    return rows.map(rowToRecommendation);
  };
  const getRecommendation = (
    recommendationId: string,
  ): PlannerRecommendationRow | undefined => {
    const row = getRecommendationStmt.get(
      recommendationId,
    ) as unknown as Record<string, unknown> | undefined;
    return row ? rowToRecommendation(row) : undefined;
  };
  const getActions = (
    opts: { status?: PlannerActionStatus | "all" } = {},
  ): readonly PlannerActionRow[] => {
    const status = opts.status ?? "all";
    const rows =
      status === "all"
        ? (getActionsAllStmt.all() as unknown as ReadonlyArray<
            Record<string, unknown>
          >)
        : (getActionsByStatusStmt.all(status) as unknown as ReadonlyArray<
            Record<string, unknown>
          >);
    return rows.map(rowToAction);
  };

  return {
    getRecentRecommendations,
    getRecommendation,
    getActions,
    close: () => db.close(),
  };
}

function rowToRecommendation(
  row: Record<string, unknown>,
): PlannerRecommendationRow {
  let evidence: Record<string, unknown> = {};
  const raw = row.evidence_json;
  if (typeof raw === "string" && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        evidence = parsed as Record<string, unknown>;
      }
    } catch {
      // Drop to {} on malformed JSON.
    }
  }
  return {
    recommendationId: String(row.recommendation_id ?? ""),
    capability: String(row.capability ?? "") as PlannerCapability,
    target: String(row.target ?? ""),
    summary: String(row.summary ?? ""),
    evidence,
    status: String(row.status ?? "proposed") as RecommendationStatus,
    proposedUnixNano: String(row.proposed_unix_nano ?? ""),
    decidedUnixNano:
      row.decided_unix_nano === null || row.decided_unix_nano === undefined
        ? null
        : String(row.decided_unix_nano),
    decidedBy:
      row.decided_by === null || row.decided_by === undefined
        ? null
        : (String(row.decided_by) as RecommendationSource),
    decisionReason:
      row.decision_reason === null || row.decision_reason === undefined
        ? null
        : String(row.decision_reason),
    autoApproveEligible: Number(row.auto_approve_eligible ?? 0) === 1,
  };
}

function rowToAction(row: Record<string, unknown>): PlannerActionRow {
  return {
    actionId: String(row.action_id ?? ""),
    recommendationId:
      row.recommendation_id === null || row.recommendation_id === undefined
        ? null
        : String(row.recommendation_id),
    capability: String(row.capability ?? "") as PlannerCapability,
    target: String(row.target ?? ""),
    status: String(row.status ?? "started") as PlannerActionStatus,
    startedUnixNano: String(row.started_unix_nano ?? ""),
    endedUnixNano:
      row.ended_unix_nano === null || row.ended_unix_nano === undefined
        ? null
        : String(row.ended_unix_nano),
    outcome:
      row.outcome === null || row.outcome === undefined
        ? null
        : String(row.outcome),
    error:
      row.error === null || row.error === undefined ? null : String(row.error),
  };
}
