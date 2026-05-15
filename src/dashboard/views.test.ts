import { describe, expect, it } from "vitest";
import type {
  LinearSnapshotRow,
  PhaseSpan,
  StoredAgentIteration,
  StoredIssueProcess,
} from "./storage.js";
import {
  escapeHtml,
  filterStateToQueryString,
  renderDetailView,
  renderListView,
  type DetailViewModel,
  type ListFilterState,
} from "./views.js";

function row(over: Partial<StoredIssueProcess> = {}): StoredIssueProcess {
  return {
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    parentSpanId: null,
    issueIdentifier: "VA-1",
    issueId: null,
    issueTitle: null,
    issueLabels: [],
    branch: null,
    outcomeKind: "opened",
    outcomeDetail: "https://github.com/x/y/pull/1",
    prUrl: "https://github.com/x/y/pull/1",
    hitlReason: null,
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

  it("links each row to its detail page via /issue-processes/<spanId> (VA-387)", () => {
    const html = renderListView([
      row({
        traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        spanId: "2222222222222222",
        issueIdentifier: "VA-1",
      }),
    ]);
    expect(html).toContain(`/issue-processes/2222222222222222`);
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
    issueTitle: null,
    issueLabels: [],
    branch: "agent/va-1",
    outcomeKind: "opened",
    outcomeDetail: "https://github.com/x/y/pull/1",
    prUrl: "https://github.com/x/y/pull/1",
    hitlReason: null,
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

// VA-390: list view weaves in optional Linear-side data. When the
// dashboard runs without LINEAR_API_KEY, the queue section is hidden
// and per-row status badges fall back to the snapshot-at-emit value
// (the existing outcome cell, with no extra Linear-status badge).
describe("renderListView — Linear sync surfaces (VA-390)", () => {
  function snapshot(
    over: Partial<LinearSnapshotRow> & Pick<LinearSnapshotRow, "issueIdentifier">,
  ): LinearSnapshotRow {
    return {
      snapshotAt: "2026-05-15T00:00:00Z",
      status: "In Review",
      title: "Snapshot title",
      labels: [],
      queuePosition: null,
      ...over,
    };
  }

  it("renders a Todo queue (next up) section above the issue-process list when linearEnabled", () => {
    const html = renderListView({
      rows: [row()],
      linearEnabled: true,
      todoQueue: [
        snapshot({
          issueIdentifier: "VA-77",
          status: "Todo",
          title: "Set up the thing",
          labels: ["bug", "p1"],
          queuePosition: 0,
        }),
      ],
      snapshotsByIdentifier: new Map(),
    });
    expect(html).toContain("Todo queue (next up)");
    expect(html).toContain("VA-77");
    expect(html).toContain("Set up the thing");
    expect(html).toContain("bug, p1");
  });

  it("renders an empty-state row inside the queue section when the queue is empty", () => {
    const html = renderListView({
      rows: [row()],
      linearEnabled: true,
      todoQueue: [],
      snapshotsByIdentifier: new Map(),
    });
    expect(html).toContain("Todo queue (next up)");
    expect(html).toContain("Linear Todo queue is empty");
  });

  it("hides the queue section entirely when linearEnabled is false (LINEAR_API_KEY absent)", () => {
    const html = renderListView({
      rows: [row()],
      linearEnabled: false,
      todoQueue: [],
      snapshotsByIdentifier: new Map(),
    });
    expect(html).not.toContain("Todo queue (next up)");
    expect(html).not.toContain("Linear Todo queue is empty");
  });

  it("overlays a Linear status badge on rows whose identifier has a snapshot", () => {
    const r = row({ issueIdentifier: "VA-1" });
    const html = renderListView({
      rows: [r],
      linearEnabled: true,
      todoQueue: [],
      snapshotsByIdentifier: new Map([
        ["VA-1", snapshot({ issueIdentifier: "VA-1", status: "In Review" })],
      ]),
    });
    expect(html).toContain(`class="status-badge"`);
    expect(html).toContain("In Review");
  });

  it("omits the Linear status badge when no snapshot exists for the row's identifier", () => {
    const r = row({ issueIdentifier: "VA-1" });
    const html = renderListView({
      rows: [r],
      linearEnabled: true,
      todoQueue: [],
      snapshotsByIdentifier: new Map(),
    });
    expect(html).not.toContain(`class="status-badge"`);
  });

  it("falls back to the snapshot-at-emit outcome value when linearEnabled is false", () => {
    // Graceful degradation: the row still renders its outcomeKind, and
    // the Linear status badge column is absent because the dashboard
    // doesn't ship per-row Linear state when the poller isn't running.
    const html = renderListView({
      rows: [row({ issueIdentifier: "VA-9", outcomeKind: "hitl" })],
      linearEnabled: false,
      todoQueue: [],
      snapshotsByIdentifier: new Map(),
    });
    expect(html).toContain("hitl");
    expect(html).not.toContain(`class="status-badge"`);
  });

  it("accepts the legacy renderListView(rows) signature for back-compat", () => {
    // Tests / older call sites pass `readonly StoredIssueProcess[]`
    // directly; the new view model overload preserves that path.
    const html = renderListView([row({ issueIdentifier: "VA-back" })]);
    expect(html).toContain("VA-back");
    expect(html).not.toContain("Todo queue (next up)");
  });
});

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

  it("renders the issue title, branch, and a clickable PR link for opened runs (VA-387)", () => {
    const base = detailVm();
    const html = renderDetailView({
      ...base,
      issueProcess: {
        ...base.issueProcess,
        issueTitle: "Slice 2 build",
        branch: "agent/va-387",
        prUrl: "https://github.com/x/y/pull/99",
      },
      iterations: [iter()],
    });
    expect(html).toContain("Slice 2 build");
    expect(html).toContain("agent/va-387");
    expect(html).toContain(`href="https://github.com/x/y/pull/99"`);
  });

  it("renders the HITL reason on a hitl run and omits the PR link (VA-387)", () => {
    const base = detailVm();
    const html = renderDetailView({
      ...base,
      issueProcess: {
        ...base.issueProcess,
        outcomeKind: "hitl",
        outcomeDetail: "Needs human decision",
        prUrl: null,
        hitlReason: "Needs human decision",
      },
      iterations: [iter()],
    });
    expect(html).toContain("HITL reason");
    expect(html).toContain("Needs human decision");
    expect(html).not.toContain(`href="https://github.com`);
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

// VA-392: filter-chip rendering + URL encoding.
describe("renderListView — filter chips (VA-392)", () => {
  const emptyState: ListFilterState = {
    outcomes: [],
    range: "all",
    drain: null,
  };

  function viewModel(over: {
    rows?: readonly StoredIssueProcess[];
    filterState?: ListFilterState;
    isFiltered?: boolean;
    recentDrains?: readonly { traceId: string; startedAtUnixNano: string; issueCount: number }[];
  } = {}): Parameters<typeof renderListView>[0] {
    return {
      rows: over.rows ?? [row()],
      linearEnabled: false,
      todoQueue: [],
      snapshotsByIdentifier: new Map<string, LinearSnapshotRow>(),
      activeDrain: null,
      filterState: over.filterState ?? emptyState,
      recentDrains: over.recentDrains ?? [],
      isFiltered: over.isFiltered ?? false,
    };
  }

  it("renders a chip for every outcome kind with no outcome chip active by default", () => {
    const html = renderListView(viewModel());
    expect(html).toContain('class="filter-chip outcome-opened"');
    expect(html).toContain('class="filter-chip outcome-hitl"');
    expect(html).toContain('class="filter-chip outcome-errored"');
    expect(html).toContain('class="filter-chip outcome-in-flight"');
    // None of the outcome chips carry the active class on the empty
    // state (the range=all chip is active by default, by design).
    expect(html).not.toMatch(/outcome-(opened|hitl|errored|in-flight) active"/);
  });

  it("marks the selected outcome chip as active", () => {
    const html = renderListView(
      viewModel({
        filterState: { outcomes: ["hitl"], range: "all", drain: null },
        isFiltered: true,
      }),
    );
    expect(html).toContain('class="filter-chip outcome-hitl active"');
    expect(html).not.toContain('outcome-opened active');
  });

  it("marks the selected range chip as active", () => {
    const html = renderListView(
      viewModel({
        filterState: { outcomes: [], range: "7d", drain: null },
        isFiltered: true,
      }),
    );
    expect(html).toContain('class="filter-chip range-7d active"');
  });

  it("renders one chip per recent drain plus an 'all drains' reset chip", () => {
    const html = renderListView(
      viewModel({
        recentDrains: [
          {
            traceId: "trace-x",
            startedAtUnixNano: "1715000000000000000",
            issueCount: 2,
          },
        ],
      }),
    );
    expect(html).toContain(">all drains</a>");
    expect(html).toContain("(2)");
    expect(html).toContain('title="trace trace-x"');
  });

  it("renders the 'no rows match this filter' empty state when filtered + empty", () => {
    const html = renderListView(
      viewModel({
        rows: [],
        isFiltered: true,
        filterState: { outcomes: ["errored"], range: "all", drain: null },
      }),
    );
    expect(html).toContain("No issue processes match this filter");
    expect(html).not.toContain("No issue processes yet.");
  });

  it("renders the original 'no data yet' empty state when unfiltered + empty", () => {
    const html = renderListView(viewModel({ rows: [], isFiltered: false }));
    expect(html).toContain("No issue processes yet");
    expect(html).not.toContain("No issue processes match this filter");
  });

  it("renders a 'clear all' chip only when a filter is active", () => {
    const off = renderListView(viewModel());
    expect(off).not.toContain("clear all");
    const on = renderListView(
      viewModel({
        filterState: { outcomes: ["hitl"], range: "all", drain: null },
        isFiltered: true,
      }),
    );
    expect(on).toContain("clear all");
  });

  it("encodes the filter state in the tbody's hx-get URL so polling preserves it", () => {
    const html = renderListView(
      viewModel({
        filterState: { outcomes: ["opened"], range: "7d", drain: null },
        isFiltered: true,
      }),
    );
    expect(html).toMatch(/hx-get="\/issue-processes\?outcome=opened&amp;range=7d"/);
  });

  it("emits an htmx-indicator progress bar above the table", () => {
    const html = renderListView(viewModel());
    expect(html).toContain('class="progress-bar htmx-indicator"');
    expect(html).toContain('hx-indicator="#rows-progress"');
  });
});

describe("filterStateToQueryString (VA-392)", () => {
  it("returns an empty string for the all-defaults state", () => {
    expect(
      filterStateToQueryString({ outcomes: [], range: "all", drain: null }),
    ).toBe("");
  });

  it("serializes outcomes as a single comma-separated value", () => {
    expect(
      filterStateToQueryString({
        outcomes: ["opened", "hitl"],
        range: "all",
        drain: null,
      }),
    ).toBe("?outcome=opened%2Chitl");
  });

  it("omits the range param when range=all", () => {
    expect(
      filterStateToQueryString({
        outcomes: ["opened"],
        range: "all",
        drain: null,
      }),
    ).toBe("?outcome=opened");
  });

  it("URL-encodes drain trace ids", () => {
    expect(
      filterStateToQueryString({
        outcomes: [],
        range: "all",
        drain: "trace with spaces",
      }),
    ).toBe("?drain=trace%20with%20spaces");
  });
});
