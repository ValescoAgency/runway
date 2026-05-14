import { describe, expect, it } from "vitest";
import type { StoredIssueProcess } from "./storage.js";
import { escapeHtml, renderListView } from "./views.js";

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
