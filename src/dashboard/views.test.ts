import { describe, expect, it } from "vitest";
import type { StoredIssueProcess, StoredLogRecord } from "./storage.js";
import { escapeHtml, renderDetailView, renderListView } from "./views.js";

function row(over: Partial<StoredIssueProcess> = {}): StoredIssueProcess {
  return {
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    parentSpanId: null,
    issueIdentifier: "VA-1",
    issueId: null,
    branch: null,
    outcomeKind: "opened",
    outcomeDetail: "https://github.com/x/y/pull/1",
    startTimeUnixNano: "0",
    endTimeUnixNano: "0",
    statusCode: null,
    statusMessage: null,
    insertedAt: "2026-05-14 10:00:00",
    ...over,
  };
}

describe("renderListView (VA-386)", () => {
  it("renders one row per issue process with identifier and outcome", () => {
    const html = renderListView([
      row({ issueIdentifier: "VA-1", outcomeKind: "opened" }),
      row({ issueIdentifier: "VA-2", outcomeKind: "hitl" }),
    ]);
    expect(html).toContain("VA-1");
    expect(html).toContain("VA-2");
    expect(html).toContain("opened");
    expect(html).toContain("hitl");
  });

  it("renders a friendly empty state when no rows exist", () => {
    const html = renderListView([]);
    expect(html).toContain("No issue processes yet");
  });

  it("falls back to 'pending' when an issue process has no outcome yet", () => {
    const html = renderListView([row({ outcomeKind: null, outcomeDetail: null })]);
    expect(html).toContain("pending");
  });
});

describe("escapeHtml (VA-386)", () => {
  it("escapes the five HTML metacharacters", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
  });

  it("renders an XSS-shaped outcome detail without breaking out of the cell", () => {
    const html = renderListView([
      row({ outcomeDetail: `<script>alert("xss")</script>` }),
    ]);
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert");
  });
});

function logRow(over: Partial<StoredLogRecord> = {}): StoredLogRecord {
  return {
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    timeUnixNano: "1715000000000000000",
    level: "INFO",
    message: "base branch resolved",
    attributesJson: JSON.stringify({ issue: "VA-1", branch: "agent/va-1" }),
    attributes: { issue: "VA-1", branch: "agent/va-1" },
    ...over,
  };
}

describe("renderDetailView (VA-388)", () => {
  it("renders the issue process header and a logs table with timestamp/level/message/attrs", () => {
    const html = renderDetailView({
      traceId: "a".repeat(32),
      issueProcess: row({ issueIdentifier: "VA-99", branch: "agent/va-99" }),
      logs: [logRow({ message: "first" }), logRow({ message: "second", timeUnixNano: "1715000001000000000" })],
    });
    expect(html).toContain("VA-99");
    expect(html).toContain("agent/va-99");
    expect(html).toContain("Logs");
    expect(html).toContain("first");
    expect(html).toContain("second");
    expect(html).toContain("INFO");
    expect(html).toContain("issue=VA-1");
    // Logs render ascending — `first` precedes `second` in the HTML.
    expect(html.indexOf("first")).toBeLessThan(html.indexOf("second"));
  });

  it("renders an empty state for the Logs section when no records exist", () => {
    const html = renderDetailView({
      traceId: "a".repeat(32),
      issueProcess: row(),
      logs: [],
    });
    expect(html).toContain("No log records yet for this trace");
  });

  it("renders an empty state for the header when no issue process exists for the trace", () => {
    const html = renderDetailView({
      traceId: "ffffffffffffffffffffffffffffffff",
      issueProcess: undefined,
      logs: [],
    });
    expect(html).toContain("No issue process found");
    expect(html).toContain("ffffffffffffffffffffffffffffffff");
  });

  it("formats the nanosecond timestamp as ISO-8601 in the table", () => {
    const html = renderDetailView({
      traceId: "a".repeat(32),
      issueProcess: row(),
      logs: [logRow({ timeUnixNano: "1715000000000000000" })],
    });
    // Truncated to ms: 1715000000000 → 2024-05-06T12:53:20.000Z.
    expect(html).toContain(
      new Date(1715000000000).toISOString(),
    );
  });

  it("escapes hostile attribute values to prevent XSS in the Attributes cell", () => {
    const html = renderDetailView({
      traceId: "a".repeat(32),
      issueProcess: row(),
      logs: [
        logRow({
          attributes: { hostile: `<script>alert("x")</script>` },
        }),
      ],
    });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert");
  });
});
