import type { StoredIssueProcess, StoredLogRecord } from "./storage.js";

/**
 * VA-386: minimal SSR HTML for the dashboard list view. No framework,
 * no client JS — slice 1 just needs one row per issue process with
 * its identifier and outcome (per AC). The detail view, polling, and
 * live tail land in later slices; ADR-0002 picks the eventual
 * @effect/platform HTTP layer.
 *
 * `escapeHtml` is the only XSS guard between SQLite and the rendered
 * page — every dynamic field passes through it.
 */

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
  <style>
    body { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
           background: #0e0e10; color: #e5e5e5; margin: 0; padding: 24px; }
    h1 { font-size: 16px; font-weight: 600; margin: 0 0 16px; }
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
    code { background: #1f2937; padding: 1px 6px; border-radius: 3px; }
  </style>
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
  const href = `/trace/${encodeURIComponent(r.traceId)}`;
  return `<tr>
    <td class="id"><a href="${escapeHtml(href)}">${escapeHtml(r.issueIdentifier)}</a></td>
    <td class="${outcomeCls}">${escapeHtml(kind)}</td>
    <td class="detail">${escapeHtml(r.outcomeDetail ?? "")}</td>
    <td>${escapeHtml(r.insertedAt)}</td>
  </tr>`;
}

export interface DetailViewModel {
  readonly traceId: string;
  readonly issueProcess: StoredIssueProcess | undefined;
  readonly logs: readonly StoredLogRecord[];
}

/**
 * VA-388 detail pane: one issue-process header + a chronological log
 * tail correlated by trace id. The log section renders timestamp +
 * level + message + attributes (per AC), ordered ascending — newest
 * lines at the bottom matches how operators read a tail.
 */
export function renderDetailView(model: DetailViewModel): string {
  const header = model.issueProcess
    ? renderDetailHeader(model.issueProcess)
    : `<div class="empty">No issue process found for trace
       <code>${escapeHtml(model.traceId)}</code>.</div>`;

  const logs =
    model.logs.length === 0
      ? `<div class="empty">No log records yet for this trace.</div>`
      : `<table class="logs">
           <thead>
             <tr>
               <th>Timestamp</th>
               <th>Level</th>
               <th>Message</th>
               <th>Attributes</th>
             </tr>
           </thead>
           <tbody>${model.logs.map(renderLogRow).join("")}</tbody>
         </table>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>runway · trace ${escapeHtml(model.traceId)}</title>
  <style>
    body { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
           background: #0e0e10; color: #e5e5e5; margin: 0; padding: 24px; }
    h1 { font-size: 16px; font-weight: 600; margin: 0 0 16px; }
    h2 { font-size: 14px; font-weight: 600; margin: 24px 0 8px; color: #d4d4d8; }
    a { color: #93c5fd; }
    .meta { font-size: 13px; color: #9ca3af; }
    .meta dt { float: left; clear: left; min-width: 120px; }
    .meta dd { margin: 0 0 4px 120px; color: #e5e5e5; }
    .empty { color: #9ca3af; padding: 16px 0; }
    table { border-collapse: collapse; width: 100%; font-size: 12px; }
    th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #2a2a2e;
             vertical-align: top; }
    th { color: #9ca3af; font-weight: 500; }
    .level { font-weight: 600; }
    .level-INFO { color: #93c5fd; }
    .level-WARN { color: #facc15; }
    .level-ERROR { color: #f87171; }
    .level-FATAL { color: #f87171; }
    .level-DEBUG { color: #9ca3af; }
    .level-TRACE { color: #6b7280; }
    .attrs { color: #d4d4d8; }
    code { background: #1f2937; padding: 1px 6px; border-radius: 3px; }
  </style>
</head>
<body>
  <h1><a href="/">runway</a> · trace <code>${escapeHtml(model.traceId)}</code></h1>
  ${header}
  <h2>Logs</h2>
  ${logs}
</body>
</html>`;
}

function renderDetailHeader(p: StoredIssueProcess): string {
  const kind = p.outcomeKind ?? "pending";
  return `<dl class="meta">
    <dt>Issue</dt><dd>${escapeHtml(p.issueIdentifier)}</dd>
    <dt>Branch</dt><dd>${escapeHtml(p.branch ?? "—")}</dd>
    <dt>Outcome</dt><dd>${escapeHtml(kind)}</dd>
    <dt>Detail</dt><dd>${escapeHtml(p.outcomeDetail ?? "—")}</dd>
    <dt>Seen at</dt><dd>${escapeHtml(p.insertedAt)}</dd>
  </dl>`;
}

function renderLogRow(r: StoredLogRecord): string {
  const level = (r.level || "INFO").toUpperCase();
  const lvlCls = `level level-${escapeHtml(level)}`;
  return `<tr>
    <td>${escapeHtml(formatTimestamp(r.timeUnixNano))}</td>
    <td class="${lvlCls}">${escapeHtml(level)}</td>
    <td>${escapeHtml(r.message)}</td>
    <td class="attrs">${escapeHtml(formatAttrs(r.attributes))}</td>
  </tr>`;
}

/**
 * OTLP timestamps are nanoseconds-since-epoch as a stringified int64.
 * Convert to ISO-8601 for display; fall back to the raw string when
 * the input isn't a valid integer (defensive — collector should never
 * write a bad timestamp, but the view shouldn't crash on it).
 */
function formatTimestamp(nanos: string): string {
  if (!nanos) return "";
  // Trim the trailing 6 digits (ns→ms) before constructing a Date.
  // Using BigInt avoids precision loss for the int64 range.
  try {
    const ns = BigInt(nanos);
    const ms = Number(ns / 1_000_000n);
    if (!Number.isFinite(ms)) return nanos;
    return new Date(ms).toISOString();
  } catch {
    return nanos;
  }
}

function formatAttrs(
  attrs: Record<string, string | number | boolean>,
): string {
  const keys = Object.keys(attrs).sort();
  if (keys.length === 0) return "";
  return keys.map((k) => `${k}=${String(attrs[k])}`).join(" ");
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
