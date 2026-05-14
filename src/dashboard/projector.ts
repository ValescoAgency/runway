import {
  attrMap,
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
  readonly endTimeUnixNano: string;
  readonly attempts: number | null;
  readonly opened: number | null;
  readonly hitl: number | null;
  readonly errored: number | null;
  readonly statusCode: number | null;
  readonly statusMessage: string | null;
}

export interface IssueProcessRow {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly issueIdentifier: string;
  readonly issueId: string | null;
  readonly branch: string | null;
  readonly outcomeKind: string | null;
  readonly outcomeDetail: string | null;
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
    branch: strAttr(m["runway.branch"]) ?? null,
    outcomeKind: strAttr(m["runway.outcome.kind"]) ?? null,
    outcomeDetail: strAttr(m["runway.outcome.detail"]) ?? null,
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

function strAttr(v: string | number | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function numAttr(v: string | number | boolean | undefined): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
