import { DatabaseSync } from "node:sqlite";
import type {
  PlannerActionRow,
  PlannerActionStatus,
  PlannerCapability,
  PlannerCapabilityMode,
  PlannerCapabilityModeRow,
  PlannerRecommendationRow,
  RecommendationSource,
  RecommendationStatus,
} from "./dashboard/storage.js";

/**
 * VA-476: a row from `linear_snapshots` filtered to "ready for the
 * agent" — has the configured ready label, is in the Todo queue
 * (`queue_position` non-null), and is not already in a started /
 * completed / canceled `WorkflowState.type`. Drives the
 * queue-selection capability's pick.
 */
export interface ReadyForAgentRow {
  readonly issueIdentifier: string;
  readonly title: string;
  readonly queuePosition: number;
  readonly projectId: string | null;
  readonly projectName: string | null;
}

/**
 * VA-477: one PR the planner's shepherd-mergeability capability
 * iterates. Derived from `issue_processes` rows that finalized with
 * `outcome_kind = 'opened'` and a non-null `pr_url`, deduplicated to
 * the most recent record per PR URL.
 *
 * The `branch` column on `issue_processes` is nullable in the schema
 * but populated for every `opened` outcome the orchestrator writes —
 * filtered to non-null in SQL so the row interface can promise a
 * concrete string.
 */
export interface OpenShepherdedPrRow {
  readonly issueIdentifier: string;
  readonly issueId: string | null;
  readonly issueTitle: string | null;
  readonly issueLabels: readonly string[];
  readonly branch: string;
  readonly prUrl: string;
  /** Parsed from `pr_url`. */
  readonly prNumber: number;
}

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
  /**
   * VA-476: ready-for-agent issues in queue-position order. The label
   * + status_type filter happens in JS because labels round-trip as
   * JSON in SQLite (no efficient indexed predicate). Rows are
   * naturally bounded by Linear's queue size, so the filter is cheap.
   */
  readonly listReadyForAgent: (opts: {
    readonly readyLabel: string;
  }) => readonly ReadyForAgentRow[];
  /**
   * VA-476: targets that already carry ANY recommendation row,
   * regardless of status (proposed | accepted | rejected). Queue-
   * selection skips these so the planner doesn't recommend the
   * same issue tick after tick. A rejected target is treated as
   * terminal — the operator removes + re-adds the ready-for-agent
   * label on Linear to retry. (The dashboard's `INSERT OR IGNORE`
   * absorbed duplicate emits before this fix, but the planner was
   * generating needless OTLP traffic on every tick.)
   */
  readonly listKnownRecommendationTargets: () => readonly string[];
  /**
   * VA-476: targets with an action currently in `started` status.
   * Once VA-480 wires drain spawning, an `accept` flips the action
   * to `started` for the duration of the drain.
   */
  readonly listInFlightActionTargets: () => readonly string[];
  /**
   * VA-477: open shepherded PRs the mergeability capability iterates.
   * One row per PR URL — issue_processes can fire multiple `opened`
   * spans for the same PR (re-run of the same issue), so SQL picks
   * the most recent record per `pr_url`. PRs that the GH gateway
   * later reports as `merged: true` come back as `quiet` in the
   * watcher and are dropped from the planner's view next tick by the
   * dashboard's projection rebuild (out-of-scope for VA-477 — the
   * watcher's defensive merged check handles the interim window).
   */
  readonly listOpenShepherdedPrs: () => readonly OpenShepherdedPrRow[];
  /**
   * VA-477: actions tied to a specific recommendation_id. The
   * mergeability capability uses this to decide whether an
   * accepted recommendation has already been acted on — if any
   * row exists (started / completed / failed), the capability
   * skips re-firing this tick.
   */
  readonly getActionsForRecommendation: (
    recommendationId: string,
  ) => readonly PlannerActionRow[];
  /**
   * VA-480: accepted recommendations for a given capability whose
   * `recommendation_id` is not yet referenced by any
   * `planner_actions` row. Used by the drain-spawn capability to
   * find pending queue-selection accepts that still need an action
   * spawn. Ordered by proposed_unix_nano ASC so the oldest accept
   * goes first.
   */
  readonly listAcceptedRecommendationsWithoutAction: (
    capability: string,
  ) => readonly PlannerRecommendationRow[];
  /**
   * VA-481: capability mode lookup. Returns the explicit row when
   * one exists, or `undefined` for never-set capabilities (the
   * caller defaults missing rows to `suggest`).
   */
  readonly getCapabilityMode: (
    capability: PlannerCapability,
  ) => PlannerCapabilityModeRow | undefined;
  /** VA-481: list every explicit capability-mode row. */
  readonly listCapabilityModes: () => readonly PlannerCapabilityModeRow[];
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
  // VA-476: queue-selection-supporting queries.
  //
  // `linear_snapshots` stores labels as JSON, status_type as TEXT.
  // The SQL pre-filters by `queue_position IS NOT NULL` (the dashboard
  // populates this only for issues in the Todo queue) and a small
  // allowlist of pre-pick status types; the JS-level filter then
  // intersects labels with the configured readyLabel. Snapshot rows
  // emit a stable `queue_position` ordering — newest sync's positions
  // overwrite older ones via the PK upsert, so the planner naturally
  // tracks the live queue.
  const listReadyForAgentStmt = db.prepare(`
    SELECT issue_identifier, snapshot_at, status, title, labels_json,
           queue_position, project_id, project_name, status_type
    FROM linear_snapshots
    WHERE queue_position IS NOT NULL
      AND (
        status_type IS NULL
        OR status_type = ''
        OR status_type IN ('triage', 'backlog', 'unstarted')
      )
    ORDER BY queue_position ASC
  `);
  const listKnownRecommendationTargetsStmt = db.prepare(`
    SELECT DISTINCT target
    FROM planner_recommendations
  `);
  const listInFlightActionTargetsStmt = db.prepare(`
    SELECT DISTINCT target
    FROM planner_actions
    WHERE status = 'started'
  `);
  // VA-477: open shepherded PRs. Dedup to the most-recent record per
  // pr_url so a re-run of the same issue (which writes a new
  // issue_processes row with the same pr_url) collapses to one row.
  // SQLite's GROUP BY semantics: when a non-aggregated column appears
  // without aggregation, SQLite returns the value from the row that
  // matched the MAX/MIN aggregate. We rely on this for issue_*
  // columns paired with `MAX(inserted_at)`.
  const listOpenShepherdedPrsStmt = db.prepare(`
    SELECT
      issue_identifier,
      issue_id,
      issue_title,
      issue_labels,
      branch,
      pr_url,
      MAX(inserted_at) AS latest
    FROM issue_processes
    WHERE outcome_kind = 'opened'
      AND pr_url IS NOT NULL
      AND branch IS NOT NULL
    GROUP BY pr_url
    ORDER BY latest DESC
    LIMIT 100
  `);
  const getActionsForRecommendationStmt = db.prepare(`
    SELECT
      action_id, recommendation_id, capability, target, status,
      started_unix_nano, ended_unix_nano, outcome, error
    FROM planner_actions
    WHERE recommendation_id = ?
    ORDER BY CAST(started_unix_nano AS INTEGER) DESC
  `);
  // VA-480: accepted recommendations that don't yet have a
  // corresponding planner_actions row. LEFT JOIN absent row → pending
  // accept. Ordered oldest-first so FIFO accepts fire in the order the
  // operator approved them.
  const listAcceptedRecommendationsWithoutActionStmt = db.prepare(`
    SELECT
      r.recommendation_id, r.capability, r.target, r.summary, r.evidence_json,
      r.status, r.proposed_unix_nano, r.decided_unix_nano, r.decided_by,
      r.decision_reason, r.auto_approve_eligible
    FROM planner_recommendations r
    LEFT JOIN planner_actions a ON a.recommendation_id = r.recommendation_id
    WHERE r.capability = ?
      AND r.status = 'accepted'
      AND a.action_id IS NULL
    ORDER BY CAST(r.proposed_unix_nano AS INTEGER) ASC
  `);
  // VA-481: capability-mode reads.
  const getCapabilityModeStmt = db.prepare(`
    SELECT capability, mode, updated_unix_nano, updated_by
    FROM planner_capability_modes
    WHERE capability = ?
  `);
  const listCapabilityModesStmt = db.prepare(`
    SELECT capability, mode, updated_unix_nano, updated_by
    FROM planner_capability_modes
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

  const listReadyForAgent = ({
    readyLabel,
  }: {
    readyLabel: string;
  }): readonly ReadyForAgentRow[] => {
    const rows = listReadyForAgentStmt.all() as unknown as ReadonlyArray<
      Record<string, unknown>
    >;
    const out: ReadyForAgentRow[] = [];
    for (const r of rows) {
      const labels = parseLabelsJson(r.labels_json);
      if (!labels.includes(readyLabel)) continue;
      const queuePosition = Number(r.queue_position);
      if (!Number.isFinite(queuePosition)) continue;
      out.push({
        issueIdentifier: String(r.issue_identifier ?? ""),
        title: String(r.title ?? ""),
        queuePosition,
        projectId:
          r.project_id === null || r.project_id === undefined
            ? null
            : String(r.project_id),
        projectName:
          r.project_name === null || r.project_name === undefined
            ? null
            : String(r.project_name),
      });
    }
    return out;
  };
  const listKnownRecommendationTargets = (): readonly string[] => {
    const rows = listKnownRecommendationTargetsStmt.all() as unknown as ReadonlyArray<
      Record<string, unknown>
    >;
    return rows.map((r) => String(r.target ?? "")).filter((t) => t.length > 0);
  };
  const listInFlightActionTargets = (): readonly string[] => {
    const rows = listInFlightActionTargetsStmt.all() as unknown as ReadonlyArray<
      Record<string, unknown>
    >;
    return rows.map((r) => String(r.target ?? "")).filter((t) => t.length > 0);
  };
  const listOpenShepherdedPrs = (): readonly OpenShepherdedPrRow[] => {
    const rows = listOpenShepherdedPrsStmt.all() as unknown as ReadonlyArray<
      Record<string, unknown>
    >;
    const out: OpenShepherdedPrRow[] = [];
    for (const r of rows) {
      const prUrl = String(r.pr_url ?? "");
      const branch = String(r.branch ?? "");
      if (prUrl.length === 0 || branch.length === 0) continue;
      const prNumber = parsePrNumberLoose(prUrl);
      if (prNumber === null) continue;
      out.push({
        issueIdentifier: String(r.issue_identifier ?? ""),
        issueId:
          r.issue_id === null || r.issue_id === undefined
            ? null
            : String(r.issue_id),
        issueTitle:
          r.issue_title === null || r.issue_title === undefined
            ? null
            : String(r.issue_title),
        issueLabels: parseLabelsJson(r.issue_labels),
        branch,
        prUrl,
        prNumber,
      });
    }
    return out;
  };
  const getActionsForRecommendation = (
    recommendationId: string,
  ): readonly PlannerActionRow[] => {
    const rows = getActionsForRecommendationStmt.all(
      recommendationId,
    ) as unknown as ReadonlyArray<Record<string, unknown>>;
    return rows.map(rowToAction);
  };
  const listAcceptedRecommendationsWithoutAction = (
    capability: string,
  ): readonly PlannerRecommendationRow[] => {
    const rows = listAcceptedRecommendationsWithoutActionStmt.all(
      capability,
    ) as unknown as ReadonlyArray<Record<string, unknown>>;
    return rows.map(rowToRecommendation);
  };
  const getCapabilityMode = (
    capability: PlannerCapability,
  ): PlannerCapabilityModeRow | undefined => {
    const row = getCapabilityModeStmt.get(capability) as unknown as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return rowToCapabilityMode(row);
  };
  const listCapabilityModes = (): readonly PlannerCapabilityModeRow[] => {
    const rows = listCapabilityModesStmt.all() as unknown as ReadonlyArray<
      Record<string, unknown>
    >;
    return rows.map(rowToCapabilityMode);
  };

  return {
    getRecentRecommendations,
    getRecommendation,
    getActions,
    listReadyForAgent,
    listKnownRecommendationTargets,
    listInFlightActionTargets,
    listOpenShepherdedPrs,
    getActionsForRecommendation,
    listAcceptedRecommendationsWithoutAction,
    getCapabilityMode,
    listCapabilityModes,
    close: () => db.close(),
  };
}

function rowToCapabilityMode(
  row: Record<string, unknown>,
): PlannerCapabilityModeRow {
  return {
    capability: String(row.capability ?? "") as PlannerCapability,
    mode: String(row.mode ?? "suggest") as PlannerCapabilityMode,
    updatedUnixNano: String(row.updated_unix_nano ?? ""),
    updatedBy: String(row.updated_by ?? "operator"),
  };
}

// VA-477: local PR-number parser. Mirrors `parsePrNumber` in
// shepherd.ts but returns null on a malformed URL instead of throwing
// — this is row-level filtering, not a precondition assertion.
function parsePrNumberLoose(prUrl: string): number | null {
  const m = prUrl.match(/\/pull\/(\d+)(?:[/?#]|$)/);
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  return Number.isFinite(n) ? n : null;
}

// Tolerant labels-json decoder: malformed JSON or non-array payloads
// collapse to []. The dashboard's writer never produces malformed
// values, but a defensive read avoids crashing the planner on a
// row inserted by a future / older / hand-edited writer.
function parseLabelsJson(raw: unknown): readonly string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
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
