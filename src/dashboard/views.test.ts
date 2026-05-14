import { describe, expect, it } from "vitest";
import type {
  PhaseSpan,
  StoredAgentIteration,
  StoredIssueProcess,
} from "./storage.js";
import {
  escapeHtml,
  renderDetailView,
  renderListView,
  type DetailViewModel,
} from "./views.js";

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

  it("links each row to its detail page via /issue/<traceId>/<spanId>", () => {
    const html = renderListView([
      row({
        traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        spanId: "2222222222222222",
        issueIdentifier: "VA-1",
      }),
    ]);
    expect(html).toContain(
      `/issue/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/2222222222222222`,
    );
  });
});

// VA-389: detail-pane rendering. The phase timeline and iteration
// expansion are the two AC bullets we cover directly here; the
// integration tests in server.test.ts cover the storage→server→html
// path.

function iter(over: Partial<StoredAgentIteration> = {}): StoredAgentIteration {
  return {
    traceId: "a".repeat(32),
    spanId: "aaaa000000000001",
    issueProcessSpanId: "2222222222222222",
    iterationIndex: 1,
    startTimeUnixNano: "1715000000000000000",
    endTimeUnixNano: "1715000010000000000",
    sandcastleRunId: "impl-VA-1-iter-1",
    exitStatus: "done",
    insertedAt: "2026-05-14 10:00:00",
    ...over,
  };
}

function phase(over: Partial<PhaseSpan> & Pick<PhaseSpan, "name">): PhaseSpan {
  return {
    traceId: "a".repeat(32),
    spanId: "0000000000000000",
    parentSpanId: "2222222222222222",
    startTimeUnixNano: "1715000010000000000",
    endTimeUnixNano: "1715000015000000000",
    ...over,
  };
}

function detailVm(over: Partial<DetailViewModel> = {}): DetailViewModel {
  const issueProcess: StoredIssueProcess = {
    traceId: "a".repeat(32),
    spanId: "2222222222222222",
    parentSpanId: null,
    issueIdentifier: "VA-1",
    issueId: null,
    branch: "agent/va-1",
    outcomeKind: "opened",
    outcomeDetail: "https://github.com/x/y/pull/1",
    startTimeUnixNano: "0",
    endTimeUnixNano: "0",
    statusCode: null,
    statusMessage: null,
    insertedAt: "2026-05-14 10:00:00",
  };
  return {
    issueProcess,
    iterations: [],
    phaseSpans: [],
    ...over,
  };
}

describe("renderDetailView (VA-389)", () => {
  it("renders the issue identifier and outcome in the header", () => {
    const html = renderDetailView(
      detailVm({
        iterations: [iter()],
      }),
    );
    expect(html).toContain("VA-1");
    expect(html).toContain("opened");
  });

  it("renders an implement → review → finalize phase row for each phase that has timing data", () => {
    const html = renderDetailView(
      detailVm({
        iterations: [iter()],
        phaseSpans: [
          phase({
            name: "review",
            startTimeUnixNano: "1715000010000000000",
            endTimeUnixNano: "1715000015000000000",
          }),
          phase({
            name: "pushBranch",
            startTimeUnixNano: "1715000016000000000",
            endTimeUnixNano: "1715000017000000000",
          }),
          phase({
            name: "openPullRequest",
            startTimeUnixNano: "1715000017000000000",
            endTimeUnixNano: "1715000020000000000",
          }),
        ],
      }),
    );
    expect(html).toContain("implement");
    expect(html).toContain("review");
    expect(html).toContain("finalize");
  });

  it("expands implement to show one row per iteration with index, duration, and exit status", () => {
    const html = renderDetailView(
      detailVm({
        iterations: [
          iter({
            spanId: "aaaa000000000001",
            iterationIndex: 1,
            exitStatus: "continue",
            startTimeUnixNano: "1715000000000000000",
            endTimeUnixNano: "1715000010000000000",
          }),
          iter({
            spanId: "aaaa000000000002",
            iterationIndex: 2,
            exitStatus: "blocked",
            startTimeUnixNano: "1715000010000000000",
            endTimeUnixNano: "1715000025000000000",
          }),
        ],
      }),
    );
    expect(html).toContain("iter 1");
    expect(html).toContain("iter 2");
    expect(html).toContain("continue");
    expect(html).toContain("blocked");
    // Both iteration durations should appear formatted in seconds.
    expect(html).toContain("10.00s");
    expect(html).toContain("15.00s");
  });

  it("renders a hitl loop that never reached finalize (implement + review only)", () => {
    const html = renderDetailView(
      detailVm({
        issueProcess: {
          ...detailVm().issueProcess,
          outcomeKind: "hitl",
          outcomeDetail: "blocked by missing migration",
        },
        iterations: [
          iter({ iterationIndex: 1, exitStatus: "continue" }),
          iter({
            spanId: "aaaa000000000002",
            iterationIndex: 2,
            exitStatus: "blocked",
            startTimeUnixNano: "1715000010000000000",
            endTimeUnixNano: "1715000020000000000",
          }),
        ],
        // No review/finalize spans — short-circuited HITL run.
        phaseSpans: [],
      }),
    );
    expect(html).toContain("hitl");
    expect(html).toContain("implement");
    expect(html).toContain("iter 2");
    // No review or finalize phase row should be rendered for the hitl
    // short-circuit — only the implement phase has data.
    expect(html).not.toMatch(/<td>review<\/td>/);
    expect(html).not.toMatch(/<td>finalize<\/td>/);
  });

  it("renders an empty-state message when no iterations and no phase spans exist", () => {
    const html = renderDetailView(detailVm());
    expect(html).toContain("No phase spans recorded yet.");
  });

  it("escapes XSS-shaped outcome details on the detail page", () => {
    const html = renderDetailView(
      detailVm({
        issueProcess: {
          ...detailVm().issueProcess,
          outcomeDetail: `<script>alert("xss")</script>`,
        },
        iterations: [iter()],
      }),
    );
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert");
  });
});
