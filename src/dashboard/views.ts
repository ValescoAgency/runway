import type {
  ActiveDrain,
  LinearSnapshotRow,
  MetaReviewKind,
  OutcomeFilterKind,
  PhaseSpan,
  RecentDrain,
  StoredAgentIteration,
  StoredIssueProcess,
  StoredLogRecord,
  StoredMetaReview,
} from "./storage.js";

/**
 * VA-392: filter state encoded in the list-view URL query string. Each
 * chip group maps to one field. Empty / `"all"` / `null` mean "no
 * constraint" — the `?` form is shareable as long as the values are
 * present, so reloading the page re-applies the same filter set.
 */
export interface ListFilterState {
  readonly outcomes: readonly OutcomeFilterKind[];
  readonly range: "today" | "7d" | "30d" | "all";
  readonly drain: string | null;
}

const EMPTY_FILTER_STATE: ListFilterState = {
  outcomes: [],
  range: "all",
  drain: null,
};

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
  /**
   * VA-392: filter chip state. The view renders chip groups for
   * outcome / drain / date range; each chip's "active" class reflects
   * whether the chip's value is in `filterState`. Pre-VA-392 callers
   * default to the empty state (no chips active).
   */
  readonly filterState?: ListFilterState;
  /**
   * VA-392: recent drains for the drain chip set. The view caps the
   * displayed count to `MAX_DRAIN_CHIPS`; the server should pass the
   * top-N (default 5) which the view also caps defensively.
   */
  readonly recentDrains?: readonly RecentDrain[];
  /**
   * VA-392: whether the current filter state is constraining the row
   * set. The view uses this to distinguish "no issue processes match
   * this filter" (filtered + no rows) from "no data at all yet"
   * (unfiltered + no rows) in the empty-state row.
   */
  readonly isFiltered?: boolean;
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

  const filterState = vm.filterState ?? EMPTY_FILTER_STATE;
  const isFiltered = vm.isFiltered ?? false;
  const recentDrains = vm.recentDrains ?? [];

  const tableBody = renderIssueProcessRows({
    rows: vm.rows,
    linearEnabled: vm.linearEnabled,
    snapshotsByIdentifier: vm.snapshotsByIdentifier,
    isFiltered,
  });

  const queueSection = vm.linearEnabled ? renderTodoQueue(vm.todoQueue) : "";
  // VA-391: drain summary strip renders ABOVE the queue + run list
  // so the operator sees in-flight progress at the top of the page.
  const drainStrip = renderDrainStrip(vm.activeDrain ?? null);
  // VA-392: filter chips render between the drain strip and the table
  // so the operator can narrow the run list without leaving the page.
  const filterChips = renderFilterChips(filterState, recentDrains);

  // VA-391/392: the fragment endpoint preserves filter state by
  // re-passing the current query string on each poll. `hx-include`
  // grabs all `.filter-chip` anchors' hrefs — but those are HTML
  // links, not form fields, so we pass the params explicitly via the
  // tbody's `hx-get`. The simpler approach is to encode the filter
  // state directly in the `hx-get` URL.
  const fragmentHref = `/issue-processes${filterStateToQueryString(filterState)}`;

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
    .filters { margin: 0 0 16px; display: flex; flex-direction: column;
               gap: 6px; font-size: 12px; }
    .filter-row { display: flex; align-items: center; gap: 8px;
                  flex-wrap: wrap; }
    .filter-label { color: #9ca3af; min-width: 64px;
                    text-transform: uppercase; letter-spacing: 0.04em;
                    font-size: 11px; }
    .filter-chip { display: inline-block; padding: 2px 8px;
                   border-radius: 999px; border: 1px solid #2a2a2e;
                   color: #d4d4d8; background: #16161a; }
    .filter-chip:hover { border-color: #4b5563;
                         text-decoration: none; }
    .filter-chip.active { background: #1d4ed8; border-color: #2563eb;
                          color: #e5e5e5; }
    .filter-chip.outcome-opened.active   { background: #166534; border-color: #16a34a; }
    .filter-chip.outcome-hitl.active     { background: #854d0e; border-color: #ca8a04; }
    .filter-chip.outcome-errored.active  { background: #7f1d1d; border-color: #dc2626; }
    .filter-chip.outcome-in-flight.active { background: #374151; border-color: #6b7280; }
    .filter-chip.clear { color: #9ca3af; border-style: dashed; }
    /* VA-392: htmx-indicator is the standard class htmx toggles
       opacity on during an in-flight request. The thin bar sits
       above the table; opacity 0 → 1 keeps layout stable. */
    .progress-bar { height: 2px; background: #2a2a2e; border-radius: 1px;
                    margin: 0 0 8px; overflow: hidden; opacity: 0;
                    transition: opacity 120ms ease-in; }
    .progress-bar.htmx-indicator.htmx-request { opacity: 1; }
    .progress-bar::after { content: ""; display: block; width: 30%;
                           height: 100%; background: #60a5fa;
                           animation: runway-progress 1.2s linear infinite; }
    @keyframes runway-progress {
      0%   { transform: translateX(-100%); }
      100% { transform: translateX(400%); }
    }
  </style>
  <script src="https://unpkg.com/htmx.org@1.9.12" integrity="sha384-ujb1lZYygJmzgSwoxRggbCHcjc0rB2XoQrxeTUQyRjrOnlCoYta87iKBWq3EsdM2" crossorigin="anonymous"></script>
</head>
<body>
  <h1>runway · issue processes</h1>
  ${drainStrip}
  ${queueSection}
  ${filterChips}
  <h2>Recent runs</h2>
  <div class="progress-bar htmx-indicator" id="rows-progress"></div>
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
           hx-get="${escapeHtml(fragmentHref)}"
           hx-trigger="every 3s"
           hx-swap="innerHTML"
           hx-indicator="#rows-progress">${tableBody}</tbody>
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
  /**
   * VA-392: when true and `rows` is empty, the row renders a
   * "no issue processes match this filter" message instead of the
   * "no data at all yet" empty state. Defaults to false to keep
   * pre-VA-392 callers on the original empty message.
   */
  readonly isFiltered?: boolean;
}): string {
  if (input.rows.length === 0) {
    if (input.isFiltered) {
      return `<tr><td colspan="4" class="empty">No issue processes match this filter. <a href="/">Clear filters</a> to see everything.</td></tr>`;
    }
    return `<tr><td colspan="4" class="empty">No issue processes yet. Run <code>runway run</code> with <code>OTEL_EXPORTER_OTLP_ENDPOINT</code> pointing here to populate.</td></tr>`;
  }
  return input.rows
    .map((r) => renderRow(r, input.snapshotsByIdentifier))
    .join("");
}

// ---------------------------------------------------------------------------
// VA-392: filter chips
// ---------------------------------------------------------------------------

/**
 * Cap the number of drain chips rendered. Defensive — the server
 * already bounds the query, but a stale view model from a test or a
 * future caller shouldn't blow up the chip strip.
 */
const MAX_DRAIN_CHIPS = 5;

const OUTCOME_CHIP_LABELS: ReadonlyMap<OutcomeFilterKind, string> = new Map([
  ["opened", "opened"],
  ["hitl", "hitl"],
  ["errored", "errored"],
  ["in-flight", "in-flight"],
]);

const RANGE_CHIP_LABELS: ReadonlyMap<ListFilterState["range"], string> = new Map(
  [
    ["today", "today"],
    ["7d", "7d"],
    ["30d", "30d"],
    ["all", "all"],
  ],
);

function renderFilterChips(
  state: ListFilterState,
  recentDrains: readonly RecentDrain[],
): string {
  const outcomeRow = renderOutcomeChips(state);
  const rangeRow = renderRangeChips(state);
  const drainRow = renderDrainChips(state, recentDrains);
  const clearChip = isFilterStateEmpty(state)
    ? ""
    : `<a class="filter-chip clear" href="/">clear all</a>`;
  return `<div class="filters">
    <div class="filter-row"><span class="filter-label">Outcome</span>${outcomeRow}</div>
    <div class="filter-row"><span class="filter-label">Range</span>${rangeRow}</div>
    ${drainRow}
    ${clearChip ? `<div class="filter-row">${clearChip}</div>` : ""}
  </div>`;
}

function renderOutcomeChips(state: ListFilterState): string {
  // Each chip toggles its own outcome on/off; the URL preserves the
  // other chip groups so a click only flips one bit.
  return Array.from(OUTCOME_CHIP_LABELS.entries())
    .map(([kind, label]) => {
      const active = state.outcomes.includes(kind);
      const nextOutcomes = active
        ? state.outcomes.filter((o) => o !== kind)
        : [...state.outcomes, kind];
      const href = filterStateToQueryString({ ...state, outcomes: nextOutcomes }) || "/";
      const cls = `filter-chip outcome-${kind}${active ? " active" : ""}`;
      return `<a class="${cls}" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
    })
    .join("");
}

function renderRangeChips(state: ListFilterState): string {
  return Array.from(RANGE_CHIP_LABELS.entries())
    .map(([range, label]) => {
      const active = state.range === range;
      const href = filterStateToQueryString({ ...state, range }) || "/";
      const cls = `filter-chip range-${range}${active ? " active" : ""}`;
      return `<a class="${cls}" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
    })
    .join("");
}

function renderDrainChips(
  state: ListFilterState,
  recentDrains: readonly RecentDrain[],
): string {
  if (recentDrains.length === 0) return "";
  // The drain chip is a single-select; clicking the active one
  // clears it. "all drains" is rendered as a leading chip so the
  // operator always has a way back to the unfiltered view without
  // hunting for the "clear all" button.
  const allActive = state.drain === null;
  const allHref =
    filterStateToQueryString({ ...state, drain: null }) || "/";
  const allChip = `<a class="filter-chip${allActive ? " active" : ""}" href="${escapeHtml(allHref)}">all drains</a>`;
  const chips = recentDrains
    .slice(0, MAX_DRAIN_CHIPS)
    .map((d) => {
      const active = state.drain === d.traceId;
      const nextDrain = active ? null : d.traceId;
      const href = filterStateToQueryString({ ...state, drain: nextDrain }) || "/";
      const label = formatDrainChipLabel(d);
      const cls = `filter-chip${active ? " active" : ""}`;
      return `<a class="${cls}" href="${escapeHtml(href)}" title="trace ${escapeHtml(d.traceId)}">${escapeHtml(label)}</a>`;
    })
    .join("");
  return `<div class="filter-row"><span class="filter-label">Drain</span>${allChip}${chips}</div>`;
}

function formatDrainChipLabel(d: RecentDrain): string {
  const ts = formatTimestamp(parseNs(d.startedAtUnixNano));
  const time = ts.split(" ")[1] ?? ts;
  return `${time} (${d.issueCount})`;
}

function isFilterStateEmpty(state: ListFilterState): boolean {
  return (
    state.outcomes.length === 0 &&
    state.range === "all" &&
    state.drain === null
  );
}

/**
 * VA-392: encode the filter state as a URL query string the list view
 * can be reloaded from. Empty filter state returns "" so the link
 * collapses to "/". Outcomes serialize as a single comma-separated
 * `outcome=` value because that keeps the URL short for the common
 * case (most operators pick one outcome chip).
 */
export function filterStateToQueryString(state: ListFilterState): string {
  const parts: string[] = [];
  if (state.outcomes.length > 0) {
    parts.push(`outcome=${encodeURIComponent(state.outcomes.join(","))}`);
  }
  if (state.range !== "all") {
    parts.push(`range=${encodeURIComponent(state.range)}`);
  }
  if (state.drain) {
    parts.push(`drain=${encodeURIComponent(state.drain)}`);
  }
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
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

// ---------------------------------------------------------------------------
// VA-407: meta-reviews list + detail views. The list view paginates
// `meta_reviews` and lets the operator filter by `kind`; the detail
// view dispatches per kind to a tolerant renderer that walks the
// stored content_json shape with optional chaining so an older
// `template_version` row never crashes the page.
// ---------------------------------------------------------------------------

/**
 * Filter state encoded into the `/meta-reviews` URL. `kind === null` ⇒
 * "all kinds"; the chip strip renders both states. `page` is 1-based
 * so the URL reads naturally (`?page=2` is the second page). The
 * server clamps it to ≥ 1 before computing OFFSET.
 */
export interface MetaReviewListFilterState {
  readonly kind: MetaReviewKind | null;
  readonly page: number;
}

export const META_REVIEW_PAGE_SIZE = 20;

export interface MetaReviewListViewModel {
  readonly rows: readonly StoredMetaReview[];
  readonly totalCount: number;
  readonly filterState: MetaReviewListFilterState;
}

const META_REVIEW_KIND_LABELS: ReadonlyMap<MetaReviewKind, string> = new Map([
  ["meta-run-review", "run"],
  ["meta-drain-review", "drain"],
  ["meta-weekly-review", "weekly"],
  ["meta-skipped", "skipped"],
  ["meta-failed", "failed"],
]);

const META_REVIEW_KIND_ORDER: readonly MetaReviewKind[] = [
  "meta-run-review",
  "meta-drain-review",
  "meta-weekly-review",
  "meta-skipped",
  "meta-failed",
];

/**
 * VA-407: serialize the filter state back to the canonical query
 * string. Mirrors `filterStateToQueryString`'s pattern — chip clicks
 * pivot one field while keeping the others, page resets to 1 on every
 * filter change because the row set changes underneath.
 */
export function metaReviewFilterToQuery(
  state: MetaReviewListFilterState,
): string {
  const parts: string[] = [];
  if (state.kind !== null) parts.push(`kind=${encodeURIComponent(state.kind)}`);
  if (state.page > 1) parts.push(`page=${state.page}`);
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

const META_REVIEW_SHARED_STYLE = `
    .meta-row-skipped, .meta-row-failed { opacity: 0.55; }
    .meta-row-failed .kind { color: #f87171; }
    .meta-row-skipped .kind { color: #9ca3af; }
    .meta-row-skipped .kind::before { content: "⏭ "; }
    .meta-row-failed .kind::before { content: "✗ "; }
    .meta-row-meta-run-review .kind { color: #93c5fd; }
    .meta-row-meta-drain-review .kind { color: #c4b5fd; }
    .meta-row-meta-weekly-review .kind { color: #6ee7b7; }
    .meta-scope { color: #d4d4d8; font-size: 12px; }
    .meta-section { margin: 16px 0; }
    .meta-section h3 { font-size: 12px; color: #9ca3af; margin: 16px 0 4px;
                       text-transform: uppercase; letter-spacing: 0.05em; }
    .meta-grade { display: inline-block; padding: 1px 6px; border-radius: 3px;
                  font-size: 11px; margin-right: 4px; background: #1f2937; }
    .meta-grade-STRONG { background: #065f46; color: #d1fae5; }
    .meta-grade-ADEQUATE { background: #1e3a8a; color: #dbeafe; }
    .meta-grade-WEAK { background: #78350f; color: #fef3c7; }
    .meta-grade-FAILED { background: #7f1d1d; color: #fee2e2; }
    .meta-grade-BETTER { background: #065f46; color: #d1fae5; }
    .meta-grade-STEADY { background: #374151; color: #d4d4d8; }
    .meta-grade-WORSE { background: #7f1d1d; color: #fee2e2; }
    .meta-verdict-HELD { background: #065f46; color: #d1fae5; }
    .meta-verdict-PARTIAL { background: #78350f; color: #fef3c7; }
    .meta-verdict-MISSED { background: #7f1d1d; color: #fee2e2; }
    .meta-verdict-PENDING { background: #374151; color: #d4d4d8; }
    .meta-verdict-QUALITATIVE { background: #4c1d95; color: #ede9fe; }
    .pager { margin: 16px 0; font-size: 12px; color: #9ca3af; }
    .pager a { margin-right: 12px; }
    .pager-current { color: #d4d4d8; font-weight: 600; }
    .json-fallback { font-size: 11px; background: #16161a; padding: 8px;
                     overflow-x: auto; max-height: 320px; }
    .meta-failed-banner { background: #7f1d1d; color: #fee2e2;
                          padding: 8px 12px; border-radius: 4px; margin: 12px 0; }
    .meta-skipped-banner { background: #374151; color: #d4d4d8;
                           padding: 8px 12px; border-radius: 4px; margin: 12px 0; }
`;

export function renderMetaReviewListView(
  vm: MetaReviewListViewModel,
): string {
  const chips = renderMetaReviewKindChips(vm.filterState);
  const rows = vm.rows.length === 0
    ? `<tr><td class="empty" colspan="4">No meta-reviews match the filter.</td></tr>`
    : vm.rows.map(renderMetaReviewListRow).join("");
  const pager = renderMetaReviewPager(vm);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>meta-reviews · runway dashboard</title>
  <style>${SHARED_STYLE}${META_REVIEW_SHARED_STYLE}</style>
</head>
<body>
  <h1>meta-reviews</h1>
  <div class="breadcrumb"><a href="/">← back to issue processes</a></div>
  <div class="filters">
    <div class="filter-row"><span class="filter-label">Kind</span>${chips}</div>
  </div>
  <table>
    <thead>
      <tr>
        <th>Kind</th>
        <th>Scope</th>
        <th>Created</th>
        <th>Summary</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  ${pager}
</body>
</html>`;
}

function renderMetaReviewKindChips(
  state: MetaReviewListFilterState,
): string {
  const allActive = state.kind === null;
  // The query helper returns "" for the all-defaults state, so the
  // path concatenation naturally collapses to "/meta-reviews".
  const allHref = `/meta-reviews${metaReviewFilterToQuery({ kind: null, page: 1 })}`;
  const allChip = `<a class="filter-chip${allActive ? " active" : ""}" href="${escapeHtml(allHref)}">all</a>`;
  const chips = META_REVIEW_KIND_ORDER.map((kind) => {
    const active = state.kind === kind;
    const next = active ? null : kind;
    const href = `/meta-reviews${metaReviewFilterToQuery({ kind: next, page: 1 })}`;
    return `<a class="filter-chip${active ? " active" : ""}" href="${escapeHtml(href)}">${escapeHtml(META_REVIEW_KIND_LABELS.get(kind) ?? kind)}</a>`;
  }).join("");
  return allChip + chips;
}

function renderMetaReviewListRow(row: StoredMetaReview): string {
  const href = `/meta-reviews/${encodeURIComponent(row.id)}`;
  const kindLabel = META_REVIEW_KIND_LABELS.get(row.kind) ?? row.kind;
  // VA-407 AC: skipped + failed rows render with a distinct visual
  // treatment so they're scannable. Class hooks defined in
  // `META_REVIEW_SHARED_STYLE`.
  const rowCls = `meta-row-${row.kind}`;
  return `<tr class="${escapeHtml(rowCls)}">
    <td class="kind">${escapeHtml(kindLabel)}</td>
    <td class="meta-scope">${escapeHtml(row.scope || "(no scope)")}</td>
    <td>${escapeHtml(row.createdAt)}</td>
    <td><a href="${escapeHtml(href)}">${escapeHtml(summariseMetaReview(row))}</a></td>
  </tr>`;
}

/**
 * VA-407: one-line summary for the list view. Reads the row's
 * content_json with optional chaining so an older template_version
 * still surfaces a useful row. Falls back to "(no summary)" when the
 * content_json is unparseable or the expected fields are absent.
 */
function summariseMetaReview(row: StoredMetaReview): string {
  const parsed = safeParseJson(row.contentJson);
  if (!parsed) return "(unparseable content_json)";
  const obj = parsed as Record<string, unknown>;
  switch (row.kind) {
    case "meta-skipped": {
      const reason =
        typeof obj.reason === "string" ? obj.reason : "(no reason)";
      return `Skipped — ${reason}`;
    }
    case "meta-failed": {
      const reason =
        typeof obj.reason === "string" ? obj.reason : "(no reason)";
      return `FAILED — ${reason}`;
    }
    case "meta-run-review": {
      const review = obj.review as Record<string, unknown> | undefined;
      const agentAbsolute =
        (review?.agent_quality as { absolute?: unknown } | undefined)?.absolute;
      const recCount = Array.isArray(review?.recommendations)
        ? (review.recommendations as unknown[]).length
        : 0;
      return `agent=${typeof agentAbsolute === "string" ? agentAbsolute : "?"} · ${recCount} recommendations`;
    }
    case "meta-drain-review": {
      const review = obj.review as Record<string, unknown> | undefined;
      const severity =
        typeof review?.severity === "string" ? review.severity : "?";
      const issueCount =
        typeof review?.issue_count === "number" ? review.issue_count : 0;
      return `severity=${severity} · ${issueCount} issues`;
    }
    case "meta-weekly-review": {
      const review = obj.review as Record<string, unknown> | undefined;
      const promotions = Array.isArray(review?.promotions)
        ? (review.promotions as unknown[]).length
        : 0;
      const shipped = Array.isArray(review?.shipped_promotions)
        ? (review.shipped_promotions as unknown[]).length
        : 0;
      return `${promotions} promotions · ${shipped} shipped`;
    }
  }
  return "(no summary)";
}

function renderMetaReviewPager(vm: MetaReviewListViewModel): string {
  const { page } = vm.filterState;
  const totalPages = Math.max(
    1,
    Math.ceil(vm.totalCount / META_REVIEW_PAGE_SIZE),
  );
  const start = vm.totalCount === 0 ? 0 : (page - 1) * META_REVIEW_PAGE_SIZE + 1;
  const end = Math.min(vm.totalCount, page * META_REVIEW_PAGE_SIZE);
  const prevHref =
    page > 1
      ? `/meta-reviews${metaReviewFilterToQuery({ ...vm.filterState, page: page - 1 })}`
      : null;
  const nextHref =
    page < totalPages
      ? `/meta-reviews${metaReviewFilterToQuery({ ...vm.filterState, page: page + 1 })}`
      : null;
  const prev = prevHref
    ? `<a href="${escapeHtml(prevHref)}">← prev</a>`
    : `<span class="muted">← prev</span>`;
  const next = nextHref
    ? `<a href="${escapeHtml(nextHref)}">next →</a>`
    : `<span class="muted">next →</span>`;
  return `<div class="pager">
    ${prev}
    <span class="pager-current">${start}–${end} of ${vm.totalCount}</span>
    ${next}
  </div>`;
}

// ---------------------------------------------------------------------------
// VA-407: meta-review detail view
// ---------------------------------------------------------------------------

export interface MetaReviewDetailViewModel {
  readonly metaReview: StoredMetaReview;
  /**
   * For meta-run-review rows, the span_id of the source
   * `issue_processes` row — looked up server-side by
   * `findIssueProcessByIdentifier`. Used to cross-link the detail
   * header back to the canonical `/issue-processes/:spanId` route per
   * the AC. Null when no matching process row was found (older runs
   * or a Run Review pointing at the wrong drain).
   */
  readonly sourceIssueProcessSpanId?: string | null;
}

export function renderMetaReviewDetailView(
  vm: MetaReviewDetailViewModel,
): string {
  const { metaReview: r } = vm;
  const kindLabel = META_REVIEW_KIND_LABELS.get(r.kind) ?? r.kind;
  const parsed = safeParseJson(r.contentJson);
  const section = renderMetaReviewKindSection(vm, parsed);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(kindLabel)} · ${escapeHtml(r.scope || r.id)} · runway dashboard</title>
  <style>${SHARED_STYLE}${META_REVIEW_SHARED_STYLE}</style>
</head>
<body>
  <div class="breadcrumb"><a href="/meta-reviews">← all meta-reviews</a></div>
  <h1>${escapeHtml(kindLabel)} · ${escapeHtml(r.scope || "(no scope)")}</h1>
  <div class="meta">
    <div><span class="label">id:</span> <code>${escapeHtml(r.id)}</code></div>
    <div><span class="label">template_version:</span> <code>${escapeHtml(r.templateVersion)}</code></div>
    <div><span class="label">created:</span> ${escapeHtml(r.createdAt)}</div>
    ${r.drainId ? `<div><span class="label">drain:</span> <a href="/?drain=${encodeURIComponent(r.drainId)}"><code>${escapeHtml(shortenId(r.drainId))}</code></a></div>` : ""}
    ${r.issueId ? `<div><span class="label">issue:</span> <code>${escapeHtml(r.issueId)}</code></div>` : ""}
    ${vm.sourceIssueProcessSpanId ? `<div><span class="label">source run:</span> <a href="/issue-processes/${encodeURIComponent(vm.sourceIssueProcessSpanId)}">${escapeHtml(r.issueId ?? vm.sourceIssueProcessSpanId)}</a></div>` : ""}
  </div>
  ${section}
</body>
</html>`;
}

function renderMetaReviewKindSection(
  vm: MetaReviewDetailViewModel,
  parsed: unknown,
): string {
  const kind = vm.metaReview.kind;
  if (!parsed || typeof parsed !== "object") {
    return `<div class="meta-failed-banner">content_json could not be parsed.</div>
      <pre class="json-fallback">${escapeHtml(vm.metaReview.contentJson.slice(0, 4096))}</pre>`;
  }
  const obj = parsed as Record<string, unknown>;
  switch (kind) {
    case "meta-skipped":
      return renderSkippedSection(obj);
    case "meta-failed":
      return renderFailedSection(obj);
    case "meta-run-review":
      return renderRunReviewSection(vm, obj);
    case "meta-drain-review":
      return renderDrainReviewSection(vm, obj);
    case "meta-weekly-review":
      return renderWeeklyReviewSection(obj);
  }
  return "";
}

function renderSkippedSection(obj: Record<string, unknown>): string {
  const reason =
    typeof obj.reason === "string" ? obj.reason : "(no reason recorded)";
  return `<div class="meta-skipped-banner">Skipped — ${escapeHtml(reason)}</div>`;
}

function renderFailedSection(obj: Record<string, unknown>): string {
  const reason =
    typeof obj.reason === "string" ? obj.reason : "(no reason recorded)";
  const blocks: string[] = [
    `<div class="meta-failed-banner">FAILED — ${escapeHtml(reason)}</div>`,
  ];
  // Render the stub row when either a Linear identifier or URL is
  // present. `renderExternalAnchor` falls back to plain text when the
  // URL is rejected by the scheme allowlist so the operator still
  // sees the identifier even on a poisoned content_json.
  if (
    typeof obj.linear_identifier === "string" ||
    typeof obj.linear_url === "string"
  ) {
    const label = String(obj.linear_identifier ?? obj.linear_url ?? "");
    blocks.push(
      `<div class="meta"><span class="label">linear stub:</span> ${renderExternalAnchor(obj.linear_url, label)}</div>`,
    );
  }
  if (typeof obj.secondary_linear_error === "string") {
    blocks.push(
      `<div class="meta-failed-banner">${escapeHtml(String(obj.secondary_linear_error))}</div>`,
    );
  }
  // Preserved partial review (when the LLM succeeded but persistence
  // failed) — render as a JSON block so an operator can recover.
  if (obj.preserved_review && typeof obj.preserved_review === "object") {
    blocks.push(
      `<div class="meta-section"><h3>Preserved review</h3><pre class="json-fallback">${escapeHtml(JSON.stringify(obj.preserved_review, null, 2))}</pre></div>`,
    );
  }
  return blocks.join("\n");
}

function renderRunReviewSection(
  vm: MetaReviewDetailViewModel,
  obj: Record<string, unknown>,
): string {
  const review = (obj.review ?? obj) as Record<string, unknown>;
  const blocks: string[] = [];
  const linearUrl = safeExternalHref(obj.linear_url);
  const linearIdentifier =
    typeof obj.linear_issue_identifier === "string"
      ? obj.linear_issue_identifier
      : null;
  if (linearUrl && linearIdentifier) {
    blocks.push(
      `<div class="meta"><span class="label">linear:</span> ${renderExternalAnchor(linearUrl, linearIdentifier)}</div>`,
    );
  }
  if (typeof review.final_outcome === "string") {
    blocks.push(
      `<div class="meta"><span class="label">outcome:</span> <code>${escapeHtml(review.final_outcome)}</code></div>`,
    );
  }
  const qualityDims = [
    ["issue_quality", "issue_quality_relative", "Issue"],
    ["prompt_quality", "prompt_quality_relative", "Prompt"],
    ["agent_quality", "agent_quality_relative", "Agent"],
    ["reviewer_quality", "reviewer_quality_relative", "Reviewer"],
    ["orchestration_quality", "orchestration_quality_relative", "Orchestration"],
  ] as const;
  const qualityRows = qualityDims
    .map(([absKey, relKey, label]) => {
      const section = review[absKey] as
        | { absolute?: unknown; justification?: unknown }
        | undefined;
      if (!section || typeof section !== "object") return "";
      const absolute =
        typeof section.absolute === "string" ? section.absolute : null;
      const relative =
        typeof review[relKey] === "string" ? (review[relKey] as string) : null;
      const just =
        typeof section.justification === "string" ? section.justification : "";
      return `<tr>
        <td>${escapeHtml(label)}</td>
        <td>${absolute ? `<span class="meta-grade meta-grade-${escapeHtml(absolute)}">${escapeHtml(absolute)}</span>` : ""}</td>
        <td>${relative ? `<span class="meta-grade meta-grade-${escapeHtml(relative)}">${escapeHtml(relative)}</span>` : ""}</td>
        <td class="detail">${escapeHtml(just)}</td>
      </tr>`;
    })
    .filter((s) => s.length > 0)
    .join("");
  if (qualityRows.length > 0) {
    blocks.push(`<div class="meta-section"><h3>Quality grades</h3>
      <table>
        <thead><tr><th>Dimension</th><th>Absolute</th><th>Relative</th><th>Justification</th></tr></thead>
        <tbody>${qualityRows}</tbody>
      </table>
    </div>`);
  }
  if (Array.isArray(review.recommendations) && review.recommendations.length > 0) {
    const items = review.recommendations
      .map((rec) => {
        if (!rec || typeof rec !== "object") return "";
        const r = rec as { target?: unknown; change?: unknown; confidence?: unknown };
        return `<li><code>${escapeHtml(String(r.target ?? "?"))}</code> (${escapeHtml(String(r.confidence ?? "?"))}) — ${escapeHtml(String(r.change ?? ""))}</li>`;
      })
      .join("");
    blocks.push(`<div class="meta-section"><h3>Recommendations</h3><ul>${items}</ul></div>`);
  }
  // VA-403: hindsight signals (when present). Older v1.0.0 carried
  // hindsight_signals=null; we only render the section when populated.
  const hs = review.hindsight_signals as
    | {
        pr?: { url?: unknown; state?: unknown; merged_at?: unknown } | null;
        human_verdict?: { sentiment?: unknown; comment_count?: unknown; summary?: unknown } | null;
        follow_up_issues?: ReadonlyArray<{ identifier?: unknown; title?: unknown }>;
      }
      | null
      | undefined;
  if (hs && typeof hs === "object") {
    const parts: string[] = [];
    if (hs.pr && typeof hs.pr === "object") {
      const prUrl = safeExternalHref(hs.pr.url);
      const prState = typeof hs.pr.state === "string" ? hs.pr.state : "?";
      parts.push(
        `<div><span class="label">PR:</span> ${prUrl ? renderExternalAnchor(prUrl, prUrl) : "—"} (<code>${escapeHtml(prState)}</code>)</div>`,
      );
    }
    if (hs.human_verdict && typeof hs.human_verdict === "object") {
      parts.push(
        `<div><span class="label">human verdict:</span> ${escapeHtml(String(hs.human_verdict.sentiment ?? "?"))} (${escapeHtml(String(hs.human_verdict.comment_count ?? 0))} comments) — ${escapeHtml(String(hs.human_verdict.summary ?? ""))}</div>`,
      );
    }
    if (Array.isArray(hs.follow_up_issues) && hs.follow_up_issues.length > 0) {
      const items = hs.follow_up_issues
        .map(
          (i) =>
            `<li><code>${escapeHtml(String(i?.identifier ?? "?"))}</code> ${escapeHtml(String(i?.title ?? ""))}</li>`,
        )
        .join("");
      parts.push(
        `<div><span class="label">follow-ups:</span><ul>${items}</ul></div>`,
      );
    }
    if (parts.length > 0) {
      blocks.push(
        `<div class="meta-section"><h3>Hindsight signals</h3>${parts.join("")}</div>`,
      );
    }
  }
  // Cross-link footer to the source issue process if known. Also
  // rendered in the meta header but a footer reinforces the path.
  if (vm.sourceIssueProcessSpanId) {
    blocks.push(
      `<div class="meta-section"><a href="/issue-processes/${encodeURIComponent(vm.sourceIssueProcessSpanId)}">→ source run (${escapeHtml(vm.metaReview.issueId ?? vm.sourceIssueProcessSpanId)})</a></div>`,
    );
  }
  return blocks.join("\n");
}

function renderDrainReviewSection(
  vm: MetaReviewDetailViewModel,
  obj: Record<string, unknown>,
): string {
  const review = (obj.review ?? obj) as Record<string, unknown>;
  const blocks: string[] = [];
  const drainLinearUrl = safeExternalHref(obj.linear_url);
  if (drainLinearUrl && typeof obj.linear_identifier === "string") {
    blocks.push(
      `<div class="meta"><span class="label">linear:</span> ${renderExternalAnchor(drainLinearUrl, obj.linear_identifier)}</div>`,
    );
  }
  if (typeof review.severity === "string") {
    const sev = review.severity;
    const cls = sev === "critical" ? "meta-failed-banner" : "meta";
    blocks.push(
      `<div class="${cls}"><strong>severity:</strong> ${escapeHtml(sev)} — ${escapeHtml(String(review.severity_justification ?? ""))}</div>`,
    );
  }
  if (typeof review.sequencing_assessment === "string") {
    blocks.push(
      `<div class="meta-section"><h3>Sequencing</h3><div class="detail">${escapeHtml(review.sequencing_assessment)}</div></div>`,
    );
  }
  if (Array.isArray(review.cross_issue_patterns) && review.cross_issue_patterns.length > 0) {
    const items = review.cross_issue_patterns
      .map((p) => `<li>${escapeHtml(String(p))}</li>`)
      .join("");
    blocks.push(
      `<div class="meta-section"><h3>Cross-issue patterns</h3><ul>${items}</ul></div>`,
    );
  }
  if (review.outcomes_summary && typeof review.outcomes_summary === "object") {
    const entries = Object.entries(review.outcomes_summary as Record<string, unknown>)
      .map(([k, v]) => `<li><code>${escapeHtml(k)}</code>: ${escapeHtml(String(v))}</li>`)
      .join("");
    blocks.push(
      `<div class="meta-section"><h3>Outcomes</h3><ul>${entries}</ul></div>`,
    );
  }
  if (Array.isArray(review.notable_events) && review.notable_events.length > 0) {
    const items = review.notable_events
      .map((e) => {
        if (!e || typeof e !== "object") return "";
        const ev = e as { issue_identifier?: unknown; event?: unknown; run_review_url?: unknown };
        const idText = String(ev.issue_identifier ?? "?");
        const link = renderExternalAnchor(ev.run_review_url, idText);
        return `<li>${link}: ${escapeHtml(String(ev.event ?? ""))}</li>`;
      })
      .join("");
    blocks.push(`<div class="meta-section"><h3>Notable events</h3><ul>${items}</ul></div>`);
  }
  if (Array.isArray(review.recommendations) && review.recommendations.length > 0) {
    const items = review.recommendations
      .map((rec) => {
        if (!rec || typeof rec !== "object") return "";
        const r = rec as { target?: unknown; change?: unknown; confidence?: unknown };
        return `<li><code>${escapeHtml(String(r.target ?? "?"))}</code> (${escapeHtml(String(r.confidence ?? "?"))}) — ${escapeHtml(String(r.change ?? ""))}</li>`;
      })
      .join("");
    blocks.push(`<div class="meta-section"><h3>Recommendations</h3><ul>${items}</ul></div>`);
  }
  // VA-407 AC: drain detail links to drain's issue_processes list.
  if (vm.metaReview.drainId) {
    blocks.push(
      `<div class="meta-section"><a href="/?drain=${encodeURIComponent(vm.metaReview.drainId)}">→ drain's issue_processes</a></div>`,
    );
  }
  return blocks.join("\n");
}

function renderWeeklyReviewSection(obj: Record<string, unknown>): string {
  const review = (obj.review ?? obj) as Record<string, unknown>;
  const blocks: string[] = [];
  const weeklyLinearUrl = safeExternalHref(obj.linear_url);
  if (weeklyLinearUrl && typeof obj.linear_identifier === "string") {
    blocks.push(
      `<div class="meta"><span class="label">linear:</span> ${renderExternalAnchor(weeklyLinearUrl, obj.linear_identifier)}</div>`,
    );
  }
  if (typeof review.narrative === "string" && review.narrative.length > 0) {
    blocks.push(
      `<div class="meta-section"><h3>Narrative</h3><div class="detail">${escapeHtml(review.narrative)}</div></div>`,
    );
  }
  if (review.rates && typeof review.rates === "object") {
    const rates = review.rates as Record<string, unknown>;
    const rows = Object.entries(rates)
      .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`)
      .join("");
    blocks.push(
      `<div class="meta-section"><h3>Rates</h3><table>${rows}</table></div>`,
    );
  }
  // VA-409: *What we shipped* section. Cross-links each shipped row to
  // its runway-meta-promoted Linear issue.
  if (Array.isArray(review.shipped_promotions) && review.shipped_promotions.length > 0) {
    const items = review.shipped_promotions
      .map((s) => {
        if (!s || typeof s !== "object") return "";
        const sp = s as {
          linear_identifier?: unknown;
          linear_url?: unknown;
          linear_title?: unknown;
          verdict?: unknown;
          comment?: unknown;
        };
        const id = typeof sp.linear_identifier === "string" ? sp.linear_identifier : "?";
        const verdict = typeof sp.verdict === "string" ? sp.verdict : "?";
        const link = renderExternalAnchor(sp.linear_url, id);
        return `<li><span class="meta-grade meta-verdict-${escapeHtml(verdict)}">${escapeHtml(verdict)}</span> ${link} — ${escapeHtml(String(sp.linear_title ?? ""))} <br /><span class="muted">${escapeHtml(String(sp.comment ?? ""))}</span></li>`;
      })
      .join("");
    blocks.push(`<div class="meta-section"><h3>What we shipped</h3><ul>${items}</ul></div>`);
  }
  // VA-407 AC: promotions block cross-links to runway-meta Linear
  // issues. Promotion URLs live in `obj.promotion_filings[*].url`
  // (stamped by the weekly review pass after each runway-repo issue
  // is filed).
  if (Array.isArray(review.promotions) && review.promotions.length > 0) {
    const filings = Array.isArray(obj.promotion_filings)
      ? (obj.promotion_filings as ReadonlyArray<Record<string, unknown>>)
      : [];
    const filingByThemeKey = new Map<string, { identifier?: unknown; url?: unknown }>();
    for (const f of filings) {
      if (f && typeof f === "object" && typeof f.theme_key === "string") {
        filingByThemeKey.set(f.theme_key, f);
      }
    }
    const items = review.promotions
      .map((p) => {
        if (!p || typeof p !== "object") return "";
        const promo = p as { title?: unknown; theme_key?: unknown; target?: unknown };
        const themeKey =
          typeof promo.theme_key === "string" ? promo.theme_key : "";
        const filing = themeKey ? filingByThemeKey.get(themeKey) : undefined;
        const linearId =
          filing && typeof filing.identifier === "string" ? filing.identifier : null;
        // Render the identifier whenever it exists — `renderExternalAnchor`
        // degrades to plain text when the URL is rejected by the scheme
        // allowlist, so the operator still sees the cross-link target.
        const linkHtml = linearId
          ? ` → ${renderExternalAnchor(filing?.url, linearId)}`
          : "";
        return `<li><strong>${escapeHtml(String(promo.title ?? "(untitled)"))}</strong> <code>${escapeHtml(String(promo.target ?? "?"))}</code>${linkHtml}</li>`;
      })
      .join("");
    blocks.push(`<div class="meta-section"><h3>Promotions</h3><ul>${items}</ul></div>`);
  }
  return blocks.join("\n");
}

function safeParseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function shortenId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

/**
 * VA-407: scheme allowlist for URLs sourced from `meta_reviews.content_json`.
 * `escapeHtml` protects attribute syntax (escapes `"`/`<`/`>`) but does
 * NOT block `javascript:` / `data:` / `vbscript:` schemes, so a
 * prompt-injected or malformed review payload could otherwise smuggle
 * an executable link into the dashboard. We allow only `http(s)://`
 * URLs and return null otherwise so the renderer can fall back to
 * plain text.
 *
 * The runway IRA passes only ever stamp Linear (`https://linear.app/...`)
 * and GitHub PR (`https://github.com/...`) URLs into content_json
 * today; rejecting the rest is defense-in-depth, not a guard against
 * a known offender.
 */
export function safeExternalHref(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  // Tolerate leading whitespace — Linear's API has been known to
  // return URLs with surrounding spaces.
  const trimmed = raw.trim();
  // RFC-3986 scheme: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) followed
  // by ":". Reject anything that doesn't match `^https?:\/\/`.
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
}

/**
 * Convenience: render an anchor when the URL passes the allowlist,
 * else fall back to plain (escaped) text. Both branches HTML-escape
 * the label.
 */
function renderExternalAnchor(rawUrl: unknown, label: string): string {
  const safe = safeExternalHref(rawUrl);
  if (safe === null) return escapeHtml(label);
  return `<a href="${escapeHtml(safe)}" rel="noopener noreferrer" target="_blank">${escapeHtml(label)}</a>`;
}
