import {
  attrMap,
  type OtlpAttribute,
  type OtlpLogRecord,
  type OtlpLogsPayload,
  type OtlpResourceSpans,
  type OtlpSpan,
  type OtlpTracesPayload,
} from "./otlp.js";

/**
 * VA-386 (dashboard slice 1): pure span → domain projection.
 *
 * The collector receives OTLP `ResourceSpans` from runway and needs to
 * project the two top-level domain spans (`drainQueue`,
 * `processIssue`) into typed rows so the dashboard can query them
 * without grovelling through JSON on every page render. Everything
 * else lands in `raw_spans` as the original JSON for debugging.
 *
 * This module is deliberately pure — no I/O, no SQLite, no logging —
 * so it's covered by hand-built fixture tests (see projector.test.ts).
 * Storage and HTTP plumbing live in storage.ts and server.ts.
 */

export interface DrainRow {
  readonly traceId: string;
  readonly spanId: string;
  readonly startTimeUnixNano: string;
  /**
   * VA-455: nullable so the dashboard can persist an in-flight drain
   * inserted by the `drain.started` log marker before the drainQueue
   * span has ended. The trace exporter fills this in when the span
   * lands; up until then, `null` means "still running".
   */
  readonly endTimeUnixNano: string | null;
  /**
   * VA-455: most recent log-record timestamp for this drain's trace.
   * Drives the staleness TTL in `getActiveDrain` — drains whose
   * last_seen is older than the staleness floor are treated as
   * crashed. `null` on rows that pre-date VA-455.
   */
  readonly lastSeenUnixNano: string | null;
  readonly attempts: number | null;
  readonly opened: number | null;
  readonly hitl: number | null;
  readonly errored: number | null;
  readonly statusCode: number | null;
  readonly statusMessage: string | null;
}

/**
 * VA-455: one "drain.started" log record translated into the fields
 * `storage.markDrainActive` needs. `startTimeUnixNano` and
 * `lastSeenUnixNano` both come from the log record's timestamp —
 * runway emits the marker at the very top of the drainQueue span, so
 * it's the earliest signal we have for "this drain began".
 */
export interface ActiveDrainMarker {
  readonly traceId: string;
  readonly spanId: string;
  readonly startTimeUnixNano: string;
  readonly lastSeenUnixNano: string;
}

export interface IssueProcessRow {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly issueIdentifier: string;
  readonly issueId: string | null;
  /**
   * VA-387: Linear issue title, attached at span-emit time so the
   * detail pane can render a recognisable header without re-fetching
   * from Linear. `null` for in-flight rows whose emit predates this
   * field (or for projectors fed by an older runway).
   */
  readonly issueTitle: string | null;
  /**
   * VA-387: full set of Linear labels at fetch time. `readonly []`
   * when the issue had no labels (vs. `null` would conflate "no
   * labels" with "older projector"); historic rows still surface as
   * an empty list.
   */
  readonly issueLabels: readonly string[];
  readonly branch: string | null;
  readonly outcomeKind: string | null;
  readonly outcomeDetail: string | null;
  /**
   * VA-387: extracted from `runway.pr.url` when the run finalised
   * with `kind=opened`. Same value as `outcomeDetail` for the opened
   * branch, but a separate column means the detail pane can render
   * it as a typed GitHub link without sniffing the kind.
   */
  readonly prUrl: string | null;
  /**
   * VA-387: human-review reason — set when `kind=hitl` (planned or
   * failure-routed). Same value as `outcomeDetail` for those cases;
   * typed separately so a UI that wants "show me the reason iff
   * this went to HITL" doesn't have to branch on kind.
   */
  readonly hitlReason: string | null;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly statusCode: number | null;
  readonly statusMessage: string | null;
}

export interface RawSpanRow {
  readonly traceId: string;
  readonly spanId: string;
  readonly name: string;
  readonly payload: string;
}

/**
 * VA-389 (dashboard slice 4): one row per implement-loop iteration.
 * `issueProcessSpanId` is the parent `processIssue` span id — the
 * detail pane joins iterations to their issue process on that key.
 * `iterationIndex` is parsed from the span name (`impl-iter-N`); we
 * don't trust the `runway.iteration` attribute as the source of truth
 * because the name is what classifies the span as an iteration in
 * the first place.
 */
export interface AgentIterationRow {
  readonly traceId: string;
  readonly spanId: string;
  readonly issueProcessSpanId: string | null;
  readonly iterationIndex: number;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly sandcastleRunId: string | null;
  readonly exitStatus: string | null;
}

/**
 * VA-388: one row per Effect log record forwarded over OTLP. The
 * `traceId` / `spanId` pair correlates the record back to the
 * issue_process row that was active when the log emitted, so the
 * detail pane can render the logs alongside that issue's phase
 * timeline. `attributes` carries Effect's annotated log context
 * (e.g. `{ issue: "VA-388", branch: "agent/va-388" }`) as a flat
 * string→string map — non-string values are stringified at projection
 * time so the storage column stays predictable.
 */
export interface LogRecordRow {
  readonly traceId: string;
  readonly spanId: string;
  /** Int64 unix nanoseconds, kept as a string for precision. */
  readonly timestampUnixNano: string;
  /**
   * Severity label as emitted by the SDK — `INFO`, `WARN`, `ERROR`, etc.
   * Falls back to `severityNumber`'s OTel range when `severityText` is
   * absent.
   */
  readonly level: string;
  readonly message: string;
  readonly attributes: Record<string, string>;
}

export interface Projection {
  readonly drains: readonly DrainRow[];
  readonly issueProcesses: readonly IssueProcessRow[];
  readonly agentIterations: readonly AgentIterationRow[];
  readonly rawSpans: readonly RawSpanRow[];
}

const DRAIN_SPAN = "drainQueue";
const ISSUE_PROCESS_SPAN = "processIssue";
const IMPL_ITER_SPAN_RE = /^impl-iter-(\d+)$/;

/**
 * Project an OTLP traces payload into typed runway rows + the raw
 * escape hatch. Every span (typed or not) lands in `raw_spans`; the
 * domain spans additionally project into their typed tables.
 */
export function projectPayload(payload: OtlpTracesPayload): Projection {
  const drains: DrainRow[] = [];
  const issueProcesses: IssueProcessRow[] = [];
  const agentIterations: AgentIterationRow[] = [];
  const rawSpans: RawSpanRow[] = [];

  for (const rs of payload.resourceSpans ?? []) {
    collectFromResourceSpan(rs, drains, issueProcesses, agentIterations, rawSpans);
  }

  return { drains, issueProcesses, agentIterations, rawSpans };
}

function collectFromResourceSpan(
  rs: OtlpResourceSpans,
  drains: DrainRow[],
  issueProcesses: IssueProcessRow[],
  agentIterations: AgentIterationRow[],
  rawSpans: RawSpanRow[],
): void {
  for (const ss of rs.scopeSpans ?? []) {
    for (const span of ss.spans ?? []) {
      rawSpans.push(projectRawSpan(span));
      if (span.name === DRAIN_SPAN) {
        drains.push(projectDrain(span));
      } else if (span.name === ISSUE_PROCESS_SPAN) {
        const ip = projectIssueProcess(span);
        if (ip) issueProcesses.push(ip);
      } else {
        const iter = projectAgentIteration(span);
        if (iter) agentIterations.push(iter);
      }
    }
  }
}

function projectRawSpan(span: OtlpSpan): RawSpanRow {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    name: span.name,
    payload: JSON.stringify(span),
  };
}

function projectDrain(span: OtlpSpan): DrainRow {
  const m = attrMap(span.attributes);
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    startTimeUnixNano: span.startTimeUnixNano,
    endTimeUnixNano: span.endTimeUnixNano,
    // VA-455: an ended drain's "last activity" is its end time —
    // the storage layer keeps last_seen monotonic, so setting it
    // here ensures the value never regresses below the real end.
    lastSeenUnixNano: span.endTimeUnixNano,
    attempts: numAttr(m["runway.drain.attempts"]),
    opened: numAttr(m["runway.drain.opened"]),
    hitl: numAttr(m["runway.drain.hitl"]),
    errored: numAttr(m["runway.drain.errored"]),
    statusCode: span.status?.code ?? null,
    statusMessage: span.status?.message ?? null,
  };
}

/**
 * `processIssue` rows are keyed on `runway.issue.identifier`. A span
 * named `processIssue` without that attribute is dropped from the
 * typed table (it still lands in `raw_spans`) — without a stable
 * identifier we have nothing to render on the row, and a silently
 * blank row is more confusing than no row.
 */
function projectIssueProcess(span: OtlpSpan): IssueProcessRow | undefined {
  const m = attrMap(span.attributes);
  const identifier = strAttr(m["runway.issue.identifier"]);
  if (!identifier) return undefined;

  return {
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId ?? null,
    issueIdentifier: identifier,
    issueId: strAttr(m["runway.issue.id"]) ?? null,
    issueTitle: strAttr(m["runway.issue.title"]) ?? null,
    issueLabels: strArrayAttr(m["runway.issue.labels"]),
    branch: strAttr(m["runway.branch"]) ?? null,
    outcomeKind: strAttr(m["runway.outcome.kind"]) ?? null,
    outcomeDetail: strAttr(m["runway.outcome.detail"]) ?? null,
    prUrl: strAttr(m["runway.pr.url"]) ?? null,
    hitlReason: strAttr(m["runway.hitl.reason"]) ?? null,
    startTimeUnixNano: span.startTimeUnixNano,
    endTimeUnixNano: span.endTimeUnixNano,
    statusCode: span.status?.code ?? null,
    statusMessage: span.status?.message ?? null,
  };
}

/**
 * VA-389: project a span named `impl-iter-N` into an `AgentIteration`
 * row. Iteration index comes from the span name (the canonical
 * classifier); `runway.iteration.exit_status` and
 * `runway.iteration.sandcastle_run_id` (annotated by the implement
 * loop) carry the per-iteration metadata the detail pane shows.
 */
function projectAgentIteration(span: OtlpSpan): AgentIterationRow | undefined {
  const match = IMPL_ITER_SPAN_RE.exec(span.name);
  if (!match) return undefined;
  const idx = Number(match[1]);
  if (!Number.isFinite(idx)) return undefined;
  const m = attrMap(span.attributes);
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    issueProcessSpanId: span.parentSpanId ?? null,
    iterationIndex: idx,
    startTimeUnixNano: span.startTimeUnixNano,
    endTimeUnixNano: span.endTimeUnixNano,
    sandcastleRunId: strAttr(m["runway.iteration.sandcastle_run_id"]) ?? null,
    exitStatus: strAttr(m["runway.iteration.exit_status"]) ?? null,
  };
}

function strAttr(
  v: string | number | boolean | readonly string[] | undefined,
): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function numAttr(
  v: string | number | boolean | readonly string[] | undefined,
): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * VA-387: decode an OTLP arrayValue attribute into a string array.
 * Older spans (or spans from a runway that never set the attribute)
 * become an empty list so callers don't have to null-guard.
 */
function strArrayAttr(
  v: string | number | boolean | readonly string[] | undefined,
): readonly string[] {
  return Array.isArray(v) ? (v as readonly string[]) : [];
}

/**
 * VA-455: the canonical body string runway emits at the top of the
 * `drainQueue` span. The projector matches on this exact value to
 * decide which log records become active-drain markers — keep them
 * in lock-step with `orchestrator.ts`.
 */
export const DRAIN_STARTED_LOG = "drain.started";

/**
 * VA-474: log body strings the planner daemon emits for its six
 * event types (ADR 0004 § Writer model). Kept in lock-step with the
 * planner's `Effect.logInfo` call sites — drift between projector
 * and planner means events stop projecting into the read-model.
 */
export const PLANNER_RECOMMENDATION_PROPOSED_LOG =
  "planner.recommendation.proposed";
export const PLANNER_RECOMMENDATION_ACCEPTED_LOG =
  "planner.recommendation.accepted";
export const PLANNER_RECOMMENDATION_REJECTED_LOG =
  "planner.recommendation.rejected";
export const PLANNER_ACTION_STARTED_LOG = "planner.action.started";
export const PLANNER_ACTION_COMPLETED_LOG = "planner.action.completed";
export const PLANNER_ACTION_FAILED_LOG = "planner.action.failed";
/**
 * VA-481: emitted by the planner's HTTP PUT /planner/capabilities/:capability
 * handler when an operator (or the planner's auto-promotion logic)
 * changes a capability's mode (manual / suggest / auto). The dashboard
 * projects each event into the `planner_capability_modes` table; the
 * planner reads the table on every tick so toggles take effect on
 * the next iteration without a daemon restart.
 */
export const PLANNER_CAPABILITY_MODE_CHANGED_LOG =
  "planner.capability.mode_changed";

export const PLANNER_CAPABILITY_MODES = new Set<string>([
  "manual",
  "suggest",
  "auto",
]);

const PLANNER_CAPABILITIES = new Set<string>([
  "queue-selection",
  "shepherd-mergeability",
  "shepherd-ci",
  "shepherd-reviewer",
]);

export interface PlannerRecommendationProposedLogMarker {
  readonly kind: "recommendation.proposed";
  readonly recommendationId: string;
  readonly capability:
    | "queue-selection"
    | "shepherd-mergeability"
    | "shepherd-ci"
    | "shepherd-reviewer";
  readonly target: string;
  readonly summary: string;
  readonly evidence: Record<string, unknown>;
  readonly autoApproveEligible: boolean;
  readonly timestampUnixNano: string;
}

export interface PlannerRecommendationDecisionLogMarker {
  readonly kind: "recommendation.accepted" | "recommendation.rejected";
  readonly recommendationId: string;
  readonly status: "accepted" | "rejected";
  readonly source: "operator" | "auto";
  readonly reason: string | null;
  readonly timestampUnixNano: string;
}

export interface PlannerActionStartedLogMarker {
  readonly kind: "action.started";
  readonly actionId: string;
  readonly recommendationId: string | null;
  readonly capability:
    | "queue-selection"
    | "shepherd-mergeability"
    | "shepherd-ci"
    | "shepherd-reviewer";
  readonly target: string;
  readonly timestampUnixNano: string;
}

export interface PlannerActionCompletedLogMarker {
  readonly kind: "action.completed";
  readonly actionId: string;
  readonly outcome: string;
  readonly timestampUnixNano: string;
}

export interface PlannerActionFailedLogMarker {
  readonly kind: "action.failed";
  readonly actionId: string;
  readonly error: string;
  readonly timestampUnixNano: string;
}

export interface PlannerCapabilityModeChangedLogMarker {
  readonly kind: "capability.mode_changed";
  readonly capability:
    | "queue-selection"
    | "shepherd-mergeability"
    | "shepherd-ci"
    | "shepherd-reviewer";
  readonly mode: "manual" | "suggest" | "auto";
  /** "operator" for HTTP PUT, "auto" for planner-initiated promotions. */
  readonly updatedBy: string;
  readonly timestampUnixNano: string;
}

export type PlannerLogMarker =
  | PlannerRecommendationProposedLogMarker
  | PlannerRecommendationDecisionLogMarker
  | PlannerActionStartedLogMarker
  | PlannerActionCompletedLogMarker
  | PlannerActionFailedLogMarker
  | PlannerCapabilityModeChangedLogMarker;

/**
 * VA-474: scan an OTLP logs payload for the six planner-event
 * markers. Records that fail validation (missing required
 * attribute, unknown capability, unparseable `evidence`) are
 * dropped — the projector never crashes on a bad payload, but it
 * also never fabricates fields the emitter didn't send.
 */
export function extractPlannerMarkers(
  payload: OtlpLogsPayload,
): readonly PlannerLogMarker[] {
  const out: PlannerLogMarker[] = [];
  for (const rl of payload.resourceLogs ?? []) {
    for (const sl of rl.scopeLogs ?? []) {
      for (const rec of sl.logRecords ?? []) {
        const body = rec.body?.stringValue;
        if (!body || !body.startsWith("planner.")) continue;
        const ts = rec.timeUnixNano ?? rec.observedTimeUnixNano;
        if (!ts) continue;
        const attrs = attributesToStringMap(rec.attributes);

        if (body === PLANNER_RECOMMENDATION_PROPOSED_LOG) {
          const recommendationId = attrs.recommendationId;
          const capability = attrs.capability;
          const target = attrs.target;
          const summary = attrs.summary;
          if (
            !recommendationId ||
            !capability ||
            !PLANNER_CAPABILITIES.has(capability) ||
            !target ||
            !summary
          ) {
            continue;
          }
          let evidence: Record<string, unknown> = {};
          const rawEvidence = attrs.evidence;
          if (rawEvidence) {
            try {
              const parsed = JSON.parse(rawEvidence);
              if (
                parsed &&
                typeof parsed === "object" &&
                !Array.isArray(parsed)
              ) {
                evidence = parsed as Record<string, unknown>;
              }
            } catch {
              // Malformed evidence JSON is non-fatal — emit with {}
              // so the recommendation still lands.
            }
          }
          out.push({
            kind: "recommendation.proposed",
            recommendationId,
            capability:
              capability as PlannerRecommendationProposedLogMarker["capability"],
            target,
            summary,
            evidence,
            autoApproveEligible: attrs.autoApproveEligible === "true",
            timestampUnixNano: ts,
          });
        } else if (
          body === PLANNER_RECOMMENDATION_ACCEPTED_LOG ||
          body === PLANNER_RECOMMENDATION_REJECTED_LOG
        ) {
          const recommendationId = attrs.recommendationId;
          const source = attrs.source;
          if (
            !recommendationId ||
            (source !== "operator" && source !== "auto")
          ) {
            continue;
          }
          const status =
            body === PLANNER_RECOMMENDATION_ACCEPTED_LOG
              ? "accepted"
              : "rejected";
          out.push({
            kind:
              status === "accepted"
                ? "recommendation.accepted"
                : "recommendation.rejected",
            recommendationId,
            status,
            source,
            reason: attrs.reason ?? null,
            timestampUnixNano: ts,
          });
        } else if (body === PLANNER_ACTION_STARTED_LOG) {
          const actionId = attrs.actionId;
          const capability = attrs.capability;
          const target = attrs.target;
          if (
            !actionId ||
            !capability ||
            !PLANNER_CAPABILITIES.has(capability) ||
            !target
          ) {
            continue;
          }
          out.push({
            kind: "action.started",
            actionId,
            recommendationId: attrs.recommendationId ?? null,
            capability:
              capability as PlannerActionStartedLogMarker["capability"],
            target,
            timestampUnixNano: ts,
          });
        } else if (body === PLANNER_ACTION_COMPLETED_LOG) {
          const actionId = attrs.actionId;
          const outcome = attrs.outcome;
          if (!actionId || !outcome) continue;
          out.push({
            kind: "action.completed",
            actionId,
            outcome,
            timestampUnixNano: ts,
          });
        } else if (body === PLANNER_ACTION_FAILED_LOG) {
          const actionId = attrs.actionId;
          const error = attrs.error;
          if (!actionId || !error) continue;
          out.push({
            kind: "action.failed",
            actionId,
            error,
            timestampUnixNano: ts,
          });
        } else if (body === PLANNER_CAPABILITY_MODE_CHANGED_LOG) {
          const capability = attrs.capability;
          const mode = attrs.mode;
          if (
            !capability ||
            !PLANNER_CAPABILITIES.has(capability) ||
            !mode ||
            !PLANNER_CAPABILITY_MODES.has(mode)
          ) {
            continue;
          }
          out.push({
            kind: "capability.mode_changed",
            capability:
              capability as PlannerCapabilityModeChangedLogMarker["capability"],
            mode: mode as PlannerCapabilityModeChangedLogMarker["mode"],
            updatedBy: attrs.updatedBy ?? "operator",
            timestampUnixNano: ts,
          });
        }
      }
    }
  }
  return out;
}

/**
 * VA-455: scan an OTLP logs payload for `drain.started` markers.
 * Each match becomes an `ActiveDrainMarker` carrying the drain's
 * trace_id, the drainQueue span_id, and the log timestamp. The
 * storage layer's `markDrainActive` upserts a `drains` row on each
 * marker so the dashboard's active-drain card lights up within ~1s
 * of `runway run` starting, instead of waiting for the first
 * `processIssue` span to end.
 *
 * Records missing trace_id, span_id, or a timestamp are dropped —
 * we won't fabricate any of those, and a drain.started marker
 * without them has nothing useful to bind.
 */
export function extractActiveDrainMarkers(
  payload: OtlpLogsPayload,
): readonly ActiveDrainMarker[] {
  const out: ActiveDrainMarker[] = [];
  for (const rl of payload.resourceLogs ?? []) {
    for (const sl of rl.scopeLogs ?? []) {
      for (const rec of sl.logRecords ?? []) {
        if (rec.body?.stringValue !== DRAIN_STARTED_LOG) continue;
        const traceId = rec.traceId?.trim();
        if (!traceId) continue;
        const spanId = rec.spanId?.trim();
        if (!spanId) continue;
        const ts = rec.timeUnixNano ?? rec.observedTimeUnixNano;
        if (!ts) continue;
        out.push({
          traceId,
          spanId,
          startTimeUnixNano: ts,
          lastSeenUnixNano: ts,
        });
      }
    }
  }
  return out;
}


/**
 * VA-388: project an OTLP logs payload into `LogRecordRow`s. Records
 * without a trace_id are dropped — every Effect log emitted under
 * `Effect.withSpan` has one, so a missing value here means the record
 * came from outside the orchestrator's traced path (e.g. a stray
 * library log) and the dashboard has nowhere to show it.
 *
 * `timeUnixNano` falls back to `observedTimeUnixNano` when absent;
 * either is enough for chronological ordering. Records that carry
 * neither are dropped (we won't fabricate a timestamp).
 */
export function projectLogs(payload: OtlpLogsPayload): readonly LogRecordRow[] {
  const out: LogRecordRow[] = [];
  for (const rl of payload.resourceLogs ?? []) {
    for (const sl of rl.scopeLogs ?? []) {
      for (const rec of sl.logRecords ?? []) {
        const row = projectLogRecord(rec);
        if (row) out.push(row);
      }
    }
  }
  return out;
}

function projectLogRecord(rec: OtlpLogRecord): LogRecordRow | undefined {
  const traceId = rec.traceId?.trim();
  if (!traceId) return undefined;
  const timestamp = rec.timeUnixNano ?? rec.observedTimeUnixNano;
  if (!timestamp) return undefined;
  return {
    traceId,
    spanId: rec.spanId ?? "",
    timestampUnixNano: timestamp,
    level: severityLabel(rec),
    message: rec.body?.stringValue ?? "",
    attributes: attributesToStringMap(rec.attributes),
  };
}

/**
 * OTel's `severityNumber` is a 1-24 enum; map it back to the standard
 * coarse labels when `severityText` is absent. Effect's logger always
 * sets `severityText` in practice, but the OTLP spec marks it optional
 * so we don't rely on it.
 */
function severityLabel(rec: OtlpLogRecord): string {
  if (rec.severityText) return rec.severityText.toUpperCase();
  const n = rec.severityNumber ?? 0;
  if (n >= 21) return "FATAL";
  if (n >= 17) return "ERROR";
  if (n >= 13) return "WARN";
  if (n >= 9) return "INFO";
  if (n >= 5) return "DEBUG";
  if (n >= 1) return "TRACE";
  return "UNSET";
}

function attributesToStringMap(
  attrs: readonly OtlpAttribute[] | undefined,
): Record<string, string> {
  const m = attrMap(attrs);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m)) {
    if (Array.isArray(v)) {
      out[k] = v.join(", ");
    } else {
      out[k] = String(v);
    }
  }
  return out;
}
