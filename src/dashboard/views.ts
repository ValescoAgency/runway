import type {
  ActiveDrain,
  LinearSnapshotRow,
  PhaseSpan,
  StoredAgentIteration,
  StoredIssueProcess,
  StoredLogRecord,
} from "./storage.js";

/**
 * VA-386: minimal SSR HTML for the dashboard list view. No framework,
 * no client JS — slice 1 just needs one row per issue process with
 * its identifier and outcome (per AC). VA-389 adds the per-issue
 * detail pane (phase timeline + agent iterations).
 *
 * `escapeHtml` is the only XSS guard between SQLite and the rendered
 * page — every dynamic field passes through it.
 */

const SHARED_STYLE = `
    body { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
           background: #0e0e10; color: #e5e5e5; margin: 0; padding: 24px; }
    a { color: #93c5fd; text-decoration: none; }
    a:hover { text-decoration: underline; }
    h1 { font-size: 16px; font-weight: 600; margin: 0 0 16px; }
    h2 { font-size: 13px; font-weight: 500; color: #9ca3af;
         margin: 24px 0 8px; text-transform: uppercase; letter-spacing: 0.05em; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #2a2a2e; }
    th { color: #9ca3af; font-weight: 500; }
    .outcome { font-weight: 600; }
    .outcome-opened { color: #4ade80; }
    .outcome-hitl { color: #facc15; }
    .outcome-reverted { color: #fb923c; }
    .outcome-errored { color: #f87171; }
    .outcome-pending { color: #9ca3af; }
    .empty { color: #9ca3af; padding: 24px; text-align: center; }
    .id { color: #93c5fd; }
    .detail { color: #d4d4d8; }
    .muted { color: #9ca3af; }
    code { background: #1f2937; padding: 1px 6px; border-radius: 3px; }
    .status-badge { display: inline-block; margin-left: 8px;
                    padding: 1px 6px; border-radius: 3px; font-size: 11px;
                    background: #1f2937; color: #9ca3af; }
    .queue-note { color: #9ca3af; font-size: 12px; margin: 0 0 16px; }
`;

/**
 * VA-390 (dashboard slice 6): optional Linear-side data the list view
 * weaves in when `LINEAR_API_KEY` is configured. When absent, the
 * server passes `linearEnabled: false` and the queue preview is
 * hidden + the per-row status badge falls back to the snapshot-at-
 * emit value (i.e. just the existing outcome cell with no extra
 * Linear-status decoration).
 */
export interface ListViewModel {
  readonly rows: readonly StoredIssueProcess[];
  readonly linearEnabled: boolean;
  readonly todoQueue: readonly LinearSnapshotRow[];
  /** Latest Linear snapshot keyed by issue_identifier. Empty when sync disabled. */
  readonly snapshotsByIdentifier: ReadonlyMap<string, LinearSnapshotRow>;
  /**
   * VA-391: present when an in-flight drain is running, null when the
   * dashboard is idle. The drain summary strip renders one or the
   * other based on this field; null is the explicit "idle" signal.
   * Pre-VA-391 callers (legacy tests passing a bare row array) get
   * the idle state by default.
   */
  readonly activeDrain?: ActiveDrain | null;
}

export function renderListView(input: ListViewModel | readonly StoredIssueProcess[]): string {
  const vm: ListViewModel = Array.isArray(input)
    ? {
        rows: input as readonly StoredIssueProcess[],
        linearEnabled: false,
        todoQueue: [],
        snapshotsByIdentifier: new Map(),
        activeDrain: null,
      }
    : (input as ListViewModel);

  const tableBody = renderIssueProcessRows({
    rows: vm.rows,
    linearEnabled: vm.linearEnabled,
    snapshotsByIdentifier: vm.snapshotsByIdentifier,
  });

  const queueSection = vm.linearEnabled ? renderTodoQueue(vm.todoQueue) : "";
  // VA-391: drain summary strip renders ABOVE the queue + run list
  // so the operator sees in-flight progress at the top of the page.
  const drainStrip = renderDrainStrip(vm.activeDrain ?? null);

  // VA-391: htmx + sse extension are loaded once at the top of the
  // page. Polling on the rows tbody refreshes the recent-runs section
  // every 3s without rerendering the queue preview or drain strip.
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>runway dashboard</title>
  <style>${SHARED_STYLE}
    .drain-strip { padding: 8px 12px; margin: 0 0 16px;
                   border: 1px solid #2a2a2e; border-radius: 4px;
                   font-size: 12px; display: flex; align-items: center;
                   gap: 12px; flex-wrap: wrap; }
    .drain-strip.active { border-color: #60a5fa; background: #0c1a30; }
    .drain-strip.idle   { color: #9ca3af; }
    .drain-strip .strip-label { color: #9ca3af; }
    .drain-strip .strip-counter { color: #d4d4d8; }
    .drain-strip .strip-counter strong { color: #e5e5e5; }
    .drain-strip .counter-hitl   strong { color: #facc15; }
    .drain-strip .counter-err    strong { color: #f87171; }
  </style>
  <script src="https://unpkg.com/htmx.org@1.9.12" integrity="sha384-ujb1lZYygJmzgSwoxRggbCHcjc0rB2XoQrxeTUQyRjrOnlCoYta87iKBWq3EsdM2" crossorigin="anonymous"></script>
</head>
<body>
  <h1>runway · issue processes</h1>
  ${drainStrip}
  ${queueSection}
  <h2>Recent runs</h2>
  <table>
    <thead>
      <tr>
        <th>Issue</th>
        <th>Outcome</th>
        <th>Detail</th>
        <th>Seen at</th>
      </tr>
    </thead>
    <tbody id="issue-process-rows"
           hx-get="/issue-processes"
           hx-trigger="every 3s"
           hx-swap="innerHTML">${tableBody}</tbody>
  </table>
</body>
</html>`;
}

/**
 * VA-391: drain summary strip. Renders the in-flight drain's progress
 * when one is active; otherwise emits the explicit "Idle" indicator
 * so the operator can tell at a glance that no drain is running.
 */
function renderDrainStrip(active: ActiveDrain | null): string {
  if (!active) {
    return `<div class="drain-strip idle">Idle — no active drain</div>`;
  }
  const startedAt = formatTimestamp(parseNs(active.startedAtUnixNano));
  // The AC's "X/N issues" phrasing maps to current/expected. The
  // expected count isn't knowable without a drain-attempts signal,
  // so we report "completed-so-far of total-issued"; both are
  // tracked, and once the drain ends they collapse to N/N. The
  // wording stays close to the AC's spelling.
  const completed =
    active.openedCount + active.hitlCount + active.erroredCount;
  return `<div class="drain-strip active">
    <span class="strip-label">Drain started</span>
    <span>${escapeHtml(startedAt)}</span>
    <span class="strip-counter"><strong>${completed}</strong>/<strong>${active.issueCount}</strong> issues</span>
    <span class="strip-counter counter-hitl"><strong>${active.hitlCount}</strong> HITL</span>
    <span class="strip-counter counter-err"><strong>${active.erroredCount}</strong> errors</span>
  </div>`;
}

/**
 * VA-391: tbody fragment for the issue-processes table. Used by the
 * htmx-polled fragment endpoint (`GET /issue-processes`) and as the
 * initial render inside the full list page — keeps the polling /
 * static render symmetric.
 */
export function renderIssueProcessRows(input: {
  readonly rows: readonly StoredIssueProcess[];
  readonly linearEnabled: boolean;
  readonly snapshotsByIdentifier: ReadonlyMap<string, LinearSnapshotRow>;
}): string {
  if (input.rows.length === 0) {
    return `<tr><td colspan="4" class="empty">No issue processes yet. Run <code>runway run</code> with <code>OTEL_EXPORTER_OTLP_ENDPOINT</code> pointing here to populate.</td></tr>`;
  }
  return input.rows
    .map((r) => renderRow(r, input.snapshotsByIdentifier))
    .join("");
}

/**
 * VA-390: "Todo queue (next up)" section. Rendered above the
 * issue-process list when `LINEAR_API_KEY` is set; hidden entirely
 * when it isn't. An empty queue still renders the section heading
 * with an empty-state row so the operator knows the poller ran and
 * found nothing to pick up.
 */
function renderTodoQueue(queue: readonly LinearSnapshotRow[]): string {
  const body =
    queue.length === 0
      ? `<tr><td colspan="3" class="empty">Linear Todo queue is empty.</td></tr>`
      : queue.map(renderQueueRow).join("");
  return `<h2>Todo queue (next up)</h2>
  <table>
    <thead>
      <tr>
        <th>Issue</th>
        <th>Title</th>
        <th>Labels</th>
      </tr>
    </thead>
    <tbody>${body}</tbody>
  </table>`;
}

function renderQueueRow(s: LinearSnapshotRow): string {
  const labels = s.labels.length === 0 ? "" : s.labels.join(", ");
  return `<tr>
    <td class="id">${escapeHtml(s.issueIdentifier)}</td>
    <td class="detail">${escapeHtml(s.title)}</td>
    <td class="muted">${escapeHtml(labels)}</td>
  </tr>`;
}

function renderRow(
  r: StoredIssueProcess,
  snapshots: ReadonlyMap<string, LinearSnapshotRow>,
): string {
  const kind = r.outcomeKind ?? "pending";
  const outcomeCls = `outcome outcome-${escapeHtml(kind)}`;
  // VA-387: canonical detail link uses the span_id alone.
  const href = `/issue-processes/${encodeURIComponent(r.spanId)}`;
  // VA-390: overlay the Linear status badge when the poller has a
  // fresher snapshot for this identifier. "Fresher" is the only thing
  // the snapshot guarantees — it was recorded after the row's emit by
  // construction (the poller runs continuously and the emit captured
  // the run's terminal state, not Linear's). When absent (sync off
  // or issue not yet snapshotted) the row degrades to the existing
  // outcome cell with no badge.
  const snapshot = snapshots.get(r.issueIdentifier);
  const statusBadge = snapshot
    ? `<span class="status-badge">${escapeHtml(snapshot.status)}</span>`
    : "";
  return `<tr>
    <td class="id"><a href="${escapeHtml(href)}">${escapeHtml(r.issueIdentifier)}</a>${statusBadge}</td>
    <td class="${outcomeCls}">${escapeHtml(kind)}</td>
    <td class="detail">${escapeHtml(r.outcomeDetail ?? "")}</td>
    <td>${escapeHtml(r.insertedAt)}</td>
  </tr>`;
}

// ---------------------------------------------------------------------------
// VA-389: detail view — phase timeline + expanded implement iterations
// ---------------------------------------------------------------------------

export interface DetailViewModel {
  readonly issueProcess: StoredIssueProcess;
  readonly iterations: readonly StoredAgentIteration[];
  readonly phaseSpans: readonly PhaseSpan[];
  /**
   * VA-388: log records correlated to this trace (every record sharing
   * the trace_id, regardless of which span emitted it). Ordered
   * ascending by `timestampUnixNano` so the Logs section reads
   * chronologically. Empty when nothing has flowed through OTLP yet
   * (the section is omitted in that case).
   */
  readonly logs?: readonly StoredLogRecord[];
}

interface PhaseRow {
  readonly name: "implement" | "review" | "finalize";
  readonly startNs: bigint;
  readonly endNs: bigint;
}

const FINALIZE_PHASE_NAMES = ["pushBranch", "openPullRequest"] as const;

/**
 * VA-389: render the per-issue detail page. The phase timeline is the
 * core of the page — it shows implement / review / finalize as a
 * horizontal bar with durations and per-iteration expansion for
 * implement. Phases without timing data (e.g. a HITL run that never
 * reached finalize) are silently skipped.
 */
export function renderDetailView(vm: DetailViewModel): string {
  const phases = computePhases(vm);
  const phaseTimeline = renderPhaseTimeline(phases);
  const phaseTable = renderPhaseTable(phases, vm.iterations);
  const logsSection = renderLogsSection(vm.logs ?? []);

  const ip = vm.issueProcess;
  const kind = ip.outcomeKind ?? "pending";
  const outcomeCls = `outcome outcome-${escapeHtml(kind)}`;
  const titleLine = ip.issueTitle
    ? `<div class="title">${escapeHtml(ip.issueTitle)}</div>`
    : "";
  const prLine = ip.prUrl
    ? `<div><span class="label">PR:</span><a href="${escapeHtml(ip.prUrl)}" rel="noopener noreferrer" target="_blank">${escapeHtml(ip.prUrl)}</a></div>`
    : "";
  // HITL reason is only rendered when present (HITL or errored runs).
  // For opened/reverted outcomes we omit the row entirely rather than
  // showing an empty label.
  const hitlLine = ip.hitlReason
    ? `<div><span class="label">HITL reason:</span><span class="detail">${escapeHtml(ip.hitlReason)}</span></div>`
    : "";

  // VA-391: SSE stream URL is the detail page URL + `/stream`. The
  // htmx sse extension auto-connects on page load and dispatches
  // named events that `sse-swap` consumes.
  const streamUrl = `/issue-processes/${encodeURIComponent(ip.spanId)}/stream`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(ip.issueIdentifier)} · runway dashboard</title>
  <script src="https://unpkg.com/htmx.org@1.9.12" integrity="sha384-ujb1lZYygJmzgSwoxRggbCHcjc0rB2XoQrxeTUQyRjrOnlCoYta87iKBWq3EsdM2" crossorigin="anonymous"></script>
  <script src="https://unpkg.com/htmx-ext-sse@2.2.2/sse.js" crossorigin="anonymous"></script>
  <style>${SHARED_STYLE}
    .breadcrumb { color: #9ca3af; margin-bottom: 16px; font-size: 12px; }
    .title { font-size: 14px; color: #d4d4d8; margin: -8px 0 12px; }
    .meta { margin: 4px 0 16px; }
    .meta .label { color: #9ca3af; margin-right: 4px; }
    .timeline { position: relative; height: 28px; background: #18181b;
                border-radius: 4px; margin: 12px 0 4px; overflow: hidden; }
    .timeline .phase { position: absolute; top: 0; bottom: 0;
                       display: flex; align-items: center; padding: 0 8px;
                       font-size: 11px; color: #0e0e10; font-weight: 600;
                       white-space: nowrap; overflow: hidden; }
    .timeline .phase-implement { background: #60a5fa; }
    .timeline .phase-review    { background: #facc15; }
    .timeline .phase-finalize  { background: #4ade80; }
    .timeline-legend { font-size: 11px; color: #9ca3af; margin-bottom: 16px; }
    .iter-row td { background: #16161a; padding-left: 32px; }
    .iter-status { font-weight: 600; }
    .iter-status-done     { color: #4ade80; }
    .iter-status-blocked  { color: #f87171; }
    .iter-status-continue { color: #facc15; }
    .iter-status-missing  { color: #9ca3af; }
    .logs-pane { margin-top: 8px; }
    .logs { font-size: 12px; }
    .logs td { vertical-align: top; }
    .logs td.log-ts { color: #9ca3af; white-space: nowrap; }
    .logs td.log-level { width: 60px; font-weight: 600; }
    .log-level-INFO  { color: #93c5fd; }
    .log-level-WARN  { color: #facc15; }
    .log-level-ERROR { color: #f87171; }
    .log-level-FATAL { color: #f87171; }
    .log-level-DEBUG { color: #9ca3af; }
    .log-level-TRACE { color: #9ca3af; }
    .log-attrs { color: #9ca3af; font-size: 11px; margin-top: 4px;
                 white-space: pre-wrap; word-break: break-all; }
  </style>
</head>
<body>
  <div class="breadcrumb"><a href="/">← all issue processes</a></div>
  <h1>${escapeHtml(ip.issueIdentifier)} · <span class="${outcomeCls}">${escapeHtml(kind)}</span></h1>
  ${titleLine}
  <div class="meta">
    <div><span class="label">branch:</span><code>${escapeHtml(ip.branch ?? "—")}</code></div>
    ${prLine}
    ${hitlLine}
    <div><span class="label">detail:</span><span class="detail">${escapeHtml(ip.outcomeDetail ?? "")}</span></div>
    <div><span class="label">seen at:</span>${escapeHtml(ip.insertedAt)}</div>
  </div>

  <h2>Phase timeline</h2>
  ${phaseTimeline}
  ${phaseTable}
  <div hx-ext="sse" sse-connect="${escapeHtml(streamUrl)}">
    <div class="logs-pane" sse-swap="logsRefresh">
      ${logsSection}
    </div>
  </div>
</body>
</html>`;
}

/**
 * VA-388: detail-pane Logs section. Renders every log record correlated
 * to this trace in chronological order (timestamp ASC). Level gets a
 * color per severity; annotated attributes render below the message as
 * a `key=value` line. Section is omitted entirely when there are no
 * records — keeps the page clean for old issue processes that
 * predate the OTLP logs pipeline.
 *
 * VA-391 also re-uses this for SSE log refreshes — the `logsRefresh`
 * frame body is the full section HTML, and htmx's `sse-swap` replaces
 * the surrounding pane's children with it.
 */
export function renderLogsSection(logs: readonly StoredLogRecord[]): string {
  if (logs.length === 0) return "";
  const rows = logs.map(renderLogRow).join("");
  return `
  <h2>Logs</h2>
  <table class="logs">
    <thead>
      <tr>
        <th>Time</th>
        <th>Level</th>
        <th>Message</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderLogRow(r: StoredLogRecord): string {
  const ts = formatTimestamp(parseNs(r.timestampUnixNano));
  const level = r.level || "UNSET";
  const levelCls = `log-level log-level-${escapeHtml(level)}`;
  const attrEntries = Object.entries(r.attributes);
  const attrs =
    attrEntries.length === 0
      ? ""
      : `<div class="log-attrs">${escapeHtml(
          attrEntries.map(([k, v]) => `${k}=${v}`).join(" · "),
        )}</div>`;
  return `<tr>
    <td class="log-ts">${escapeHtml(ts)}</td>
    <td class="log-level"><span class="${levelCls}">${escapeHtml(level)}</span></td>
    <td><div>${escapeHtml(r.message)}</div>${attrs}</td>
  </tr>`;
}

/**
 * Assemble the three phase rows from the typed iteration table
 * (implement) and the raw_spans phase lookup (review, finalize).
 * Returns the phases that actually have timing data — a hitl issue
 * that never reached review still renders cleanly.
 */
function computePhases(vm: DetailViewModel): readonly PhaseRow[] {
  const phases: PhaseRow[] = [];

  if (vm.iterations.length > 0) {
    const startNs = minBigInt(vm.iterations.map((i) => parseNs(i.startTimeUnixNano)));
    const endNs = maxBigInt(vm.iterations.map((i) => parseNs(i.endTimeUnixNano)));
    phases.push({ name: "implement", startNs, endNs });
  }

  const review = vm.phaseSpans.find((p) => p.name === "review");
  if (review) {
    phases.push({
      name: "review",
      startNs: parseNs(review.startTimeUnixNano),
      endNs: parseNs(review.endTimeUnixNano),
    });
  }

  const finalize = vm.phaseSpans.filter((p) =>
    (FINALIZE_PHASE_NAMES as readonly string[]).includes(p.name),
  );
  if (finalize.length > 0) {
    const startNs = minBigInt(finalize.map((p) => parseNs(p.startTimeUnixNano)));
    const endNs = maxBigInt(finalize.map((p) => parseNs(p.endTimeUnixNano)));
    phases.push({ name: "finalize", startNs, endNs });
  }

  return phases;
}

function renderPhaseTimeline(phases: readonly PhaseRow[]): string {
  if (phases.length === 0) {
    return `<div class="empty">No phase spans recorded yet.</div>`;
  }
  const totalStart = minBigInt(phases.map((p) => p.startNs));
  const totalEnd = maxBigInt(phases.map((p) => p.endNs));
  const totalSpanNs = totalEnd - totalStart;
  // Guard against a single-point timeline (all phases collapsed).
  // Render each phase at fixed width so the bar still appears.
  const denom = totalSpanNs === 0n ? 1n : totalSpanNs;

  const bars = phases
    .map((p) => {
      const leftPct = pct(p.startNs - totalStart, denom);
      const widthPct = pct(p.endNs - p.startNs, denom);
      const safeWidth = widthPct < 1 ? 1 : widthPct;
      return `<div class="phase phase-${p.name}" style="left:${leftPct}%;width:${safeWidth}%">${p.name} · ${escapeHtml(formatDuration(p.endNs - p.startNs))}</div>`;
    })
    .join("");

  return `
  <div class="timeline">${bars}</div>
  <div class="timeline-legend">${escapeHtml(formatTimestamp(totalStart))} → ${escapeHtml(formatTimestamp(totalEnd))} (total ${escapeHtml(formatDuration(totalSpanNs))})</div>`;
}

function renderPhaseTable(
  phases: readonly PhaseRow[],
  iterations: readonly StoredAgentIteration[],
): string {
  if (phases.length === 0) {
    return "";
  }
  const rows = phases
    .map((p) => {
      const dur = formatDuration(p.endNs - p.startNs);
      const start = formatTimestamp(p.startNs);
      const end = formatTimestamp(p.endNs);
      const head = `<tr>
      <td>${escapeHtml(p.name)}</td>
      <td>${escapeHtml(start)}</td>
      <td>${escapeHtml(end)}</td>
      <td>${escapeHtml(dur)}</td>
    </tr>`;
      if (p.name === "implement") {
        return head + iterations.map(renderIterationRow).join("");
      }
      return head;
    })
    .join("");

  return `<table>
    <thead>
      <tr>
        <th>Phase</th>
        <th>Start</th>
        <th>End</th>
        <th>Duration</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderIterationRow(it: StoredAgentIteration): string {
  const status = it.exitStatus ?? "missing";
  const statusCls = `iter-status iter-status-${escapeHtml(status)}`;
  const dur = formatDuration(
    parseNs(it.endTimeUnixNano) - parseNs(it.startTimeUnixNano),
  );
  return `<tr class="iter-row">
    <td class="muted">↳ iter ${it.iterationIndex}</td>
    <td colspan="2"><span class="${statusCls}">${escapeHtml(status)}</span></td>
    <td>${escapeHtml(dur)}</td>
  </tr>`;
}

/**
 * Parse an OTLP int64 unix-nanos string into a BigInt. The OTLP wire
 * keeps these as strings so we don't lose precision through `number`;
 * the dashboard never displays sub-microsecond detail so we drop back
 * to `Number` only at format time.
 */
function parseNs(ns: string): bigint {
  if (!ns) return 0n;
  try {
    return BigInt(ns);
  } catch {
    return 0n;
  }
}

function minBigInt(xs: readonly bigint[]): bigint {
  let m = xs[0] ?? 0n;
  for (const x of xs) if (x < m) m = x;
  return m;
}

function maxBigInt(xs: readonly bigint[]): bigint {
  let m = xs[0] ?? 0n;
  for (const x of xs) if (x > m) m = x;
  return m;
}

function pct(num: bigint, denom: bigint): number {
  if (denom === 0n) return 0;
  // Multiply by 10000 in BigInt land first, then drop to Number — keeps
  // sub-percent precision on long traces without overflowing.
  const scaled = Number((num * 10000n) / denom);
  return scaled / 100;
}

function formatDuration(ns: bigint): string {
  if (ns <= 0n) return "0ms";
  const ms = Number(ns / 1_000_000n);
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(2)}s`;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}m${rem.toFixed(1)}s`;
}

function formatTimestamp(ns: bigint): string {
  if (ns <= 0n) return "—";
  const ms = Number(ns / 1_000_000n);
  return new Date(ms).toISOString();
}

const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => ESC[c] ?? c);
}
