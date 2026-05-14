import type { StoredIssueProcess } from "./storage.js";

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
  return `<tr>
    <td class="id">${escapeHtml(r.issueIdentifier)}</td>
    <td class="${outcomeCls}">${escapeHtml(kind)}</td>
    <td class="detail">${escapeHtml(r.outcomeDetail ?? "")}</td>
    <td>${escapeHtml(r.insertedAt)}</td>
  </tr>`;
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
