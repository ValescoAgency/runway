import type {
  PhaseSpan,
  StoredAgentIteration,
  StoredIssueProcess,
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
`;

export function renderListView(rows: readonly StoredIssueProcess[]): string {
  const tableBody =
    rows.length === 0
      ? `<tr><td colspan="4" class="empty">No issue processes yet. Run <code>runway run</code> with <code>OTEL_EXPORTER_OTLP_ENDPOINT</code> pointing here to populate.</td></tr>`
      : rows.map(renderRow).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>runway dashboard</title>
  <style>${SHARED_STYLE}</style>
</head>
<body>
  <h1>runway · issue processes</h1>
  <table>
    <thead>
      <tr>
        <th>Issue</th>
        <th>Outcome</th>
        <th>Detail</th>
        <th>Seen at</th>
      </tr>
    </thead>
    <tbody>${tableBody}</tbody>
  </table>
</body>
</html>`;
}

function renderRow(r: StoredIssueProcess): string {
  const kind = r.outcomeKind ?? "pending";
  const outcomeCls = `outcome outcome-${escapeHtml(kind)}`;
  // VA-387: canonical detail link uses the span_id alone.
  const href = `/issue-processes/${encodeURIComponent(r.spanId)}`;
  return `<tr>
    <td class="id"><a href="${escapeHtml(href)}">${escapeHtml(r.issueIdentifier)}</a></td>
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

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(ip.issueIdentifier)} · runway dashboard</title>
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
</body>
</html>`;
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
