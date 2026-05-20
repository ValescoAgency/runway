import { describe, expect, it } from "vitest";
import type {
  LinearSnapshotRow,
  PhaseSpan,
  StoredAgentIteration,
  StoredIssueProcess,
  StoredMetaReview,
} from "./storage.js";
import {
  escapeHtml,
  filterStateToQueryString,
  META_REVIEW_PAGE_SIZE,
  metaReviewFilterToQuery,
  renderDetailView,
  renderListView,
  renderMetaReviewDetailView,
  renderMetaReviewListView,
  safeExternalHref,
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
      projectId: null,
      projectName: null,
      statusType: "",
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

  // VA-450
  it("renders the project name and UUID in the Project column for projected issues", () => {
    const html = renderListView({
      rows: [row()],
      linearEnabled: true,
      todoQueue: [
        snapshot({
          issueIdentifier: "VA-77",
          title: "Set up the thing",
          labels: [],
          queuePosition: 0,
          projectId: "e36f2b82-ed64-421c-91cb-955ef95a28ff",
          projectName: "Runway",
        }),
      ],
      snapshotsByIdentifier: new Map(),
    });
    expect(html).toContain("<th>Project</th>");
    expect(html).toContain("Runway");
    expect(html).toContain("e36f2b82-ed64-421c-91cb-955ef95a28ff");
  });

  // VA-453
  it("renders a Status column with the workflow state name", () => {
    const html = renderListView({
      rows: [row()],
      linearEnabled: true,
      todoQueue: [
        snapshot({
          issueIdentifier: "VA-77",
          status: "In Progress",
          statusType: "started",
          title: "doing the thing",
          labels: [],
          queuePosition: 0,
        }),
      ],
      snapshotsByIdentifier: new Map(),
    });
    expect(html).toContain("<th>Status</th>");
    expect(html).toContain("In Progress");
  });

  // VA-450
  it("renders an em-dash in the Project column for unprojected issues", () => {
    const html = renderListView({
      rows: [row()],
      linearEnabled: true,
      todoQueue: [
        snapshot({
          issueIdentifier: "VA-78",
          title: "no project",
          labels: [],
          queuePosition: 0,
          projectId: null,
          projectName: null,
        }),
      ],
      snapshotsByIdentifier: new Map(),
    });
    expect(html).toContain("<th>Project</th>");
    expect(html).toContain("—");
  });

  // VA-452
  it("renders an `↗ Linear` affordance on Todo queue rows when linearWorkspace is set", () => {
    const html = renderListView({
      rows: [row()],
      linearEnabled: true,
      linearWorkspace: "valescoagency",
      todoQueue: [
        snapshot({
          issueIdentifier: "VA-77",
          title: "linkable",
          labels: [],
          queuePosition: 0,
        }),
      ],
      snapshotsByIdentifier: new Map(),
    });
    expect(html).toContain(
      "https://linear.app/valescoagency/issue/VA-77",
    );
    expect(html).toContain("↗");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  // VA-452
  it("omits the `↗ Linear` affordance when linearWorkspace is null", () => {
    const html = renderListView({
      rows: [row()],
      linearEnabled: true,
      linearWorkspace: null,
      todoQueue: [
        snapshot({
          issueIdentifier: "VA-77",
          title: "not-linkable",
          labels: [],
          queuePosition: 0,
        }),
      ],
      snapshotsByIdentifier: new Map(),
    });
    expect(html).not.toContain("https://linear.app/");
    expect(html).not.toContain("↗");
  });

  // VA-452
  it("renders the `↗ Linear` affordance on issue-process list rows alongside the local detail link", () => {
    const r = row({ issueIdentifier: "VA-101" });
    const html = renderListView({
      rows: [r],
      linearEnabled: true,
      linearWorkspace: "valescoagency",
      todoQueue: [],
      snapshotsByIdentifier: new Map(),
    });
    // Local detail link preserved
    expect(html).toContain(`/issue-processes/${encodeURIComponent(r.spanId)}`);
    // Linear link added
    expect(html).toContain(
      "https://linear.app/valescoagency/issue/VA-101",
    );
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

  it("VA-460: renders a shepherd phase row when the shepherd span is present", () => {
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
            name: "openPullRequest",
            startTimeUnixNano: "1715000016000000000",
            endTimeUnixNano: "1715000017000000000",
          }),
          phase({
            name: "shepherd",
            startTimeUnixNano: "1715000018000000000",
            endTimeUnixNano: "1715000022000000000",
          }),
        ],
      }),
    );
    expect(html).toContain("shepherd");
    expect(html).toContain("phase-shepherd");
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

  // VA-452
  it("renders the `↗ Linear` affordance in the detail header when linearWorkspace is set", () => {
    const base = detailVm();
    const html = renderDetailView({
      ...base,
      issueProcess: { ...base.issueProcess, issueIdentifier: "VA-200" },
      linearWorkspace: "valescoagency",
    });
    expect(html).toContain(
      "https://linear.app/valescoagency/issue/VA-200",
    );
  });

  // VA-452
  it("omits the `↗ Linear` affordance from the detail header when linearWorkspace is null", () => {
    const html = renderDetailView(detailVm());
    expect(html).not.toContain("https://linear.app/");
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

// ---------------------------------------------------------------------------
// VA-407: meta-reviews list + detail views
// ---------------------------------------------------------------------------

function metaRow(over: Partial<StoredMetaReview> = {}): StoredMetaReview {
  return {
    id: "row-1",
    kind: "meta-run-review",
    scope: "VA-401",
    drainId: "trace-1",
    issueId: "VA-401",
    contentJson: JSON.stringify({
      review: {
        issue_identifier: "VA-401",
        final_outcome: "opened",
        agent_quality: { absolute: "STRONG", justification: "Surgical commits." },
        recommendations: [
          { target: "prompt", change: "Tighten X.", confidence: "MEDIUM" },
        ],
        hindsight_signals: null,
      },
      linear_issue_identifier: "META-100",
      linear_url: "https://linear.app/x/issue/META-100",
    }),
    templateVersion: "1.2.0",
    createdAt: "2026-05-15 12:00:00",
    ...over,
  };
}

describe("renderMetaReviewListView (VA-407)", () => {
  it("renders a row per meta-review with kind, scope, created_at, and summary link", () => {
    const html = renderMetaReviewListView({
      rows: [metaRow()],
      totalCount: 1,
      filterState: { kind: null, page: 1 },
    });
    expect(html).toContain("meta-reviews");
    expect(html).toContain("VA-401");
    expect(html).toContain("run");
    // Detail link uses the meta-review id.
    expect(html).toContain('href="/meta-reviews/row-1"');
    // Summary projection — agent grade + recommendation count.
    expect(html).toContain("agent=STRONG");
    expect(html).toContain("1 recommendations");
  });

  it("renders kind chips reflecting the current filter state", () => {
    const html = renderMetaReviewListView({
      rows: [],
      totalCount: 0,
      filterState: { kind: "meta-drain-review", page: 1 },
    });
    expect(html).toContain('href="/meta-reviews?kind=meta-run-review"');
    // The active drain chip clears (`href="/meta-reviews"`) when clicked.
    expect(html).toMatch(/class="filter-chip active"[^>]*href="\/meta-reviews"/);
  });

  it("renders the 'all' kind chip with the bare /meta-reviews href (not a doubled path)", () => {
    // Regression test for the "/meta-reviews/meta-reviews" bug —
    // metaReviewFilterToQuery returns "" for the all-defaults state, and
    // the chip must not double the prefix via a fallback. When kind is
    // already null, the active chip renders /meta-reviews; when kind is
    // a specific value, the all chip resets to /meta-reviews.
    const allActive = renderMetaReviewListView({
      rows: [],
      totalCount: 0,
      filterState: { kind: null, page: 1 },
    });
    expect(allActive).toContain('href="/meta-reviews">all</a>');
    expect(allActive).not.toContain("/meta-reviews/meta-reviews");

    const kindActive = renderMetaReviewListView({
      rows: [],
      totalCount: 0,
      filterState: { kind: "meta-failed", page: 1 },
    });
    expect(kindActive).toContain('href="/meta-reviews">all</a>');
    expect(kindActive).not.toContain("/meta-reviews/meta-reviews");
  });

  it("renders pager footer with prev/next links and total count", () => {
    // 25 rows total, page 1 of 2 (page_size = 20).
    const rows = Array.from({ length: META_REVIEW_PAGE_SIZE }, (_, i) =>
      metaRow({ id: `row-${i + 1}`, scope: `VA-${100 + i}` }),
    );
    const html = renderMetaReviewListView({
      rows,
      totalCount: 25,
      filterState: { kind: null, page: 1 },
    });
    expect(html).toContain("1–20 of 25");
    expect(html).toContain('href="/meta-reviews?page=2"');
    // Prev is disabled on page 1 — rendered as muted text, not a link.
    expect(html).toContain('<span class="muted">← prev</span>');
  });

  it("pager preserves kind filter across page links", () => {
    const html = renderMetaReviewListView({
      rows: [],
      totalCount: 50,
      filterState: { kind: "meta-run-review", page: 2 },
    });
    expect(html).toContain(
      'href="/meta-reviews?kind=meta-run-review&amp;page=3"',
    );
    expect(html).toContain(
      'href="/meta-reviews?kind=meta-run-review"',
    );
  });

  it("applies the skipped / failed CSS treatment classes for visual differentiation", () => {
    const html = renderMetaReviewListView({
      rows: [
        metaRow({
          id: "skip-1",
          kind: "meta-skipped",
          contentJson: JSON.stringify({ reason: "Heuristic pre-filter trip" }),
        }),
        metaRow({
          id: "fail-1",
          kind: "meta-failed",
          contentJson: JSON.stringify({ reason: "Anthropic 5xx after 3 retries" }),
        }),
      ],
      totalCount: 2,
      filterState: { kind: null, page: 1 },
    });
    expect(html).toContain('class="meta-row-meta-skipped"');
    expect(html).toContain('class="meta-row-meta-failed"');
    expect(html).toContain("Skipped — Heuristic pre-filter trip");
    expect(html).toContain("FAILED — Anthropic 5xx after 3 retries");
  });

  it("renders an empty-state row when no meta-reviews match", () => {
    const html = renderMetaReviewListView({
      rows: [],
      totalCount: 0,
      filterState: { kind: null, page: 1 },
    });
    expect(html).toContain("No meta-reviews match");
  });
});

describe("metaReviewFilterToQuery (VA-407)", () => {
  it("returns an empty string when on the default (no filter, page 1)", () => {
    expect(metaReviewFilterToQuery({ kind: null, page: 1 })).toBe("");
  });

  it("serializes kind only", () => {
    expect(
      metaReviewFilterToQuery({ kind: "meta-weekly-review", page: 1 }),
    ).toBe("?kind=meta-weekly-review");
  });

  it("serializes page only", () => {
    expect(metaReviewFilterToQuery({ kind: null, page: 3 })).toBe("?page=3");
  });

  it("serializes both kind and page", () => {
    expect(
      metaReviewFilterToQuery({ kind: "meta-failed", page: 2 }),
    ).toBe("?kind=meta-failed&page=2");
  });
});

describe("renderMetaReviewDetailView (VA-407)", () => {
  it("renders a Run Review with quality grades + recommendations + source-run link", () => {
    const html = renderMetaReviewDetailView({
      metaReview: metaRow(),
      sourceIssueProcessSpanId: "span-source-1",
    });
    expect(html).toContain("Quality grades");
    expect(html).toContain("STRONG");
    expect(html).toContain("Tighten X.");
    expect(html).toContain('href="/issue-processes/span-source-1"');
    expect(html).toContain('href="https://linear.app/x/issue/META-100"');
  });

  it("renders a Run Review with v1.0.0 nested `relative: null` without crashing", () => {
    // VA-405: the legacy v1.0.0 shape carries `relative: null` inside
    // each quality section. The detail view ignores the nested slot
    // and reads from top-level `*_quality_relative` fields, falling
    // through to "no relative" when absent.
    const html = renderMetaReviewDetailView({
      metaReview: metaRow({
        templateVersion: "1.0.0",
        contentJson: JSON.stringify({
          review: {
            issue_identifier: "VA-1",
            agent_quality: {
              absolute: "WEAK",
              relative: null,
              justification: "Two retries before HITL.",
            },
            issue_quality: {
              absolute: "ADEQUATE",
              relative: null,
              justification: "Spec was OK.",
            },
            recommendations: [],
            hindsight_signals: null,
          },
        }),
      }),
    });
    expect(html).toContain("Two retries before HITL.");
    expect(html).toContain("WEAK");
    expect(html).toContain("ADEQUATE");
  });

  it("renders a Drain Review with cross-link to drain's issue_processes", () => {
    const html = renderMetaReviewDetailView({
      metaReview: metaRow({
        id: "drain-1",
        kind: "meta-drain-review",
        scope: "trace-abc",
        drainId: "trace-abc",
        issueId: null,
        contentJson: JSON.stringify({
          review: {
            severity: "routine",
            severity_justification: "no blocking signals",
            issue_count: 3,
            outcomes_summary: { opened: 2, hitl: 1 },
            sequencing_assessment: "schema migration first, UI after.",
            cross_issue_patterns: ["all touched src/dashboard"],
            notable_events: [
              {
                issue_identifier: "VA-401",
                event: "HITL after 2 rejections",
                run_review_url: "https://linear.app/x/issue/META-200",
              },
            ],
            recommendations: [],
          },
        }),
      }),
    });
    expect(html).toContain("severity:");
    expect(html).toContain("routine");
    expect(html).toContain("schema migration first");
    expect(html).toContain("all touched src/dashboard");
    expect(html).toContain('href="/?drain=trace-abc"');
    expect(html).toContain(
      'href="https://linear.app/x/issue/META-200"',
    );
  });

  it("renders a Weekly Review with promotions cross-linking to runway-meta Linear URLs", () => {
    const html = renderMetaReviewDetailView({
      metaReview: metaRow({
        id: "weekly-1",
        kind: "meta-weekly-review",
        scope: "2026-W19",
        drainId: null,
        issueId: null,
        templateVersion: "1.1.0",
        contentJson: JSON.stringify({
          review: {
            narrative: "Steady week.",
            rates: { throughput: 12, success_pct: 75 },
            promotions: [
              {
                title: "Tighten reviewer rejection guidance",
                theme_key: "prompt:tighten:abcd1234",
                target: "prompt",
              },
            ],
            shipped_promotions: [
              {
                linear_identifier: "VA-3001",
                linear_url: "https://linear.app/x/issue/VA-3001",
                linear_title: "Tighten reviewer rejection guidance",
                verdict: "HELD",
                comment: "Observed 6% across n=15 runs.",
              },
            ],
          },
          linear_identifier: "META-300",
          linear_url: "https://linear.app/x/issue/META-300",
          promotion_filings: [
            {
              theme_key: "prompt:tighten:abcd1234",
              identifier: "VA-4001",
              url: "https://linear.app/x/issue/VA-4001",
            },
          ],
        }),
      }),
    });
    expect(html).toContain("Narrative");
    expect(html).toContain("Steady week.");
    expect(html).toContain("Promotions");
    // VA-407 AC: promotions cross-link to runway-meta Linear issue
    // URLs (resolved from `promotion_filings` by theme_key).
    expect(html).toContain('href="https://linear.app/x/issue/VA-4001"');
    expect(html).toContain("VA-4001");
    // What we shipped section + verdict pill.
    expect(html).toContain("What we shipped");
    expect(html).toContain('class="meta-grade meta-verdict-HELD"');
    expect(html).toContain('href="https://linear.app/x/issue/VA-3001"');
  });

  it("renders a meta-skipped row with the skip banner", () => {
    const html = renderMetaReviewDetailView({
      metaReview: metaRow({
        id: "skip-1",
        kind: "meta-skipped",
        contentJson: JSON.stringify({ reason: "Heuristic pre-filter trip" }),
      }),
    });
    expect(html).toContain("meta-skipped-banner");
    expect(html).toContain("Heuristic pre-filter trip");
  });

  it("renders a meta-failed row with the failure banner + linear stub link", () => {
    const html = renderMetaReviewDetailView({
      metaReview: metaRow({
        id: "fail-1",
        kind: "meta-failed",
        contentJson: JSON.stringify({
          reason: "Anthropic 5xx after 3 retries",
          linear_identifier: "META-FAIL-1",
          linear_url: "https://linear.app/x/issue/META-FAIL-1",
        }),
      }),
    });
    expect(html).toContain("meta-failed-banner");
    expect(html).toContain("Anthropic 5xx after 3 retries");
    expect(html).toContain('href="https://linear.app/x/issue/META-FAIL-1"');
  });

  it("renders an unparseable content_json with a fallback banner instead of crashing", () => {
    const html = renderMetaReviewDetailView({
      metaReview: metaRow({
        id: "junk-1",
        contentJson: "{not valid json",
      }),
    });
    expect(html).toContain("content_json could not be parsed");
    expect(html).toContain("json-fallback");
  });

  it("rejects javascript:/data: URLs in content_json, falling back to plain text", () => {
    // Prompt-injection defense — a malicious content_json shouldn't
    // be able to smuggle an executable link into the dashboard. The
    // URL-bearing fields go through `safeExternalHref` and degrade to
    // plain (escaped) text when the scheme isn't http(s).
    const html = renderMetaReviewDetailView({
      metaReview: metaRow({
        id: "evil-1",
        kind: "meta-failed",
        contentJson: JSON.stringify({
          reason: "anthropic 5xx",
          linear_identifier: "META-EVIL",
          linear_url: "javascript:alert(1)",
        }),
      }),
    });
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("href=\"javascript");
    // The identifier still renders, just as plain text.
    expect(html).toContain("META-EVIL");
  });

  it("rejects a data: scheme in notable_events run_review_url", () => {
    const html = renderMetaReviewDetailView({
      metaReview: metaRow({
        id: "evil-drain",
        kind: "meta-drain-review",
        scope: "trace-z",
        drainId: "trace-z",
        issueId: null,
        contentJson: JSON.stringify({
          review: {
            severity: "routine",
            severity_justification: "ok",
            issue_count: 1,
            outcomes_summary: { opened: 1 },
            sequencing_assessment: "x",
            cross_issue_patterns: [],
            notable_events: [
              {
                issue_identifier: "VA-1",
                event: "x",
                run_review_url: "data:text/html,<script>alert(1)</script>",
              },
            ],
            recommendations: [],
          },
        }),
      }),
    });
    expect(html).not.toContain("data:text/html");
    expect(html).not.toContain("<script>alert");
    // Identifier still appears as plain text.
    expect(html).toContain("VA-1");
  });

  it("rejects javascript: in Weekly Review shipped_promotions linear_url and promotion_filings url", () => {
    const html = renderMetaReviewDetailView({
      metaReview: metaRow({
        id: "evil-weekly",
        kind: "meta-weekly-review",
        scope: "2026-W19",
        drainId: null,
        issueId: null,
        contentJson: JSON.stringify({
          review: {
            narrative: "x",
            rates: {},
            promotions: [
              { title: "T", theme_key: "k:a:b", target: "prompt" },
            ],
            shipped_promotions: [
              {
                linear_identifier: "VA-X",
                linear_url: "javascript:alert('shipped')",
                linear_title: "T",
                verdict: "HELD",
                comment: "c",
              },
            ],
          },
          promotion_filings: [
            { theme_key: "k:a:b", identifier: "VA-Y", url: "vbscript:msgbox(1)" },
          ],
        }),
      }),
    });
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("vbscript:");
    expect(html).toContain("VA-X");
    expect(html).toContain("VA-Y");
  });
});

describe("safeExternalHref (VA-407)", () => {
  it("accepts http and https URLs", () => {
    expect(safeExternalHref("https://linear.app/x/issue/VA-1")).toBe(
      "https://linear.app/x/issue/VA-1",
    );
    expect(safeExternalHref("http://example.com")).toBe("http://example.com");
    // Case-insensitive on the scheme.
    expect(safeExternalHref("HTTPS://example.com")).toBe("HTTPS://example.com");
  });

  it("trims leading whitespace before checking the scheme", () => {
    expect(safeExternalHref("  https://example.com  ")).toBe(
      "https://example.com",
    );
  });

  it("rejects unsafe schemes (javascript:, data:, vbscript:, file:)", () => {
    expect(safeExternalHref("javascript:alert(1)")).toBeNull();
    expect(safeExternalHref("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeExternalHref("vbscript:msgbox(1)")).toBeNull();
    expect(safeExternalHref("file:///etc/passwd")).toBeNull();
    // Schemes that masquerade — leading whitespace before "javascript:"
    // is trimmed first, then rejected by the regex.
    expect(safeExternalHref("\tjavascript:alert(1)")).toBeNull();
  });

  it("rejects non-string and empty inputs", () => {
    expect(safeExternalHref(null)).toBeNull();
    expect(safeExternalHref(undefined)).toBeNull();
    expect(safeExternalHref("")).toBeNull();
    expect(safeExternalHref(123)).toBeNull();
    expect(safeExternalHref({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// VA-465 — shepherd sub-strip rendering
// ---------------------------------------------------------------------------

describe("renderListView — VA-465 shepherd sub-strip", () => {
  const issueRows = [
    {
      traceId: "trace-x",
      spanId: "span-x",
      parentSpanId: null,
      issueIdentifier: "VA-1",
      issueId: "issue-1",
      issueTitle: "x",
      issueLabels: [] as readonly string[],
      branch: "agent/va-1",
      outcomeKind: "opened",
      outcomeDetail: "https://github.com/x/y/pull/1",
      startTimeUnixNano: "1715000000000000000",
      endTimeUnixNano: "1715000010000000000",
      statusCode: null,
      statusMessage: null,
      insertedAt: "2026-05-20T15:00:00",
      prUrl: "https://github.com/x/y/pull/1",
      hitlReason: null,
    },
  ];

  const activeDrain = {
    traceId: "trace-x",
    startedAtUnixNano: "1715000000000000000",
    issueCount: 1,
    openedCount: 1,
    hitlCount: 0,
    erroredCount: 0,
  };

  it("renders a Shepherding row for each active PR with state-acting class + iteration counter", () => {
    const html = renderListView({
      rows: issueRows,
      linearEnabled: false,
      todoQueue: [],
      snapshotsByIdentifier: new Map<string, LinearSnapshotRow>(),
      activeDrain,
      activeShepherding: [
        {
          traceId: "trace-x",
          prNumber: 142,
          subscription: "subscription[0]",
          iteration: 2,
          maxIterations: 3,
          state: "acting" as const,
          description: "Rebase agent/x onto origin/main",
          startedUnixNano: "1715000010000000000",
          lastSeenUnixNano: "1715000020000000000",
          endedUnixNano: null,
        },
      ],
    });
    expect(html).toContain('class="shepherd-strip"');
    expect(html).toContain("shepherd-state-acting");
    expect(html).toContain("PR #142");
    expect(html).toContain("iter 2/3");
    expect(html).toContain("Rebase agent/x onto origin/main");
  });

  it("renders the 'ready, awaiting human merge' label for state=ready", () => {
    const html = renderListView({
      rows: issueRows,
      linearEnabled: false,
      todoQueue: [],
      snapshotsByIdentifier: new Map<string, LinearSnapshotRow>(),
      activeDrain,
      activeShepherding: [
        {
          traceId: "trace-x",
          prNumber: 7,
          subscription: null,
          iteration: null,
          maxIterations: null,
          state: "ready" as const,
          description: null,
          startedUnixNano: "1715000010000000000",
          lastSeenUnixNano: "1715000020000000000",
          endedUnixNano: null,
        },
      ],
    });
    expect(html).toContain("shepherd-state-ready");
    expect(html).toContain("ready, awaiting human merge");
  });

  it("renders nothing when activeShepherding is empty (no flicker)", () => {
    const html = renderListView({
      rows: issueRows,
      linearEnabled: false,
      todoQueue: [],
      snapshotsByIdentifier: new Map<string, LinearSnapshotRow>(),
      activeDrain,
      activeShepherding: [],
    });
    expect(html).not.toContain(`class="shepherd-strip"`);
    expect(html).not.toContain(`class="shepherd-row`);
  });

  it("renders nothing when the drain is idle, even if shepherding rows arrive (the strip is gated on activeDrain)", () => {
    const html = renderListView({
      rows: issueRows,
      linearEnabled: false,
      todoQueue: [],
      snapshotsByIdentifier: new Map<string, LinearSnapshotRow>(),
      activeDrain: null,
      activeShepherding: [
        {
          traceId: "trace-x",
          prNumber: 1,
          subscription: null,
          iteration: null,
          maxIterations: null,
          state: "acting" as const,
          description: null,
          startedUnixNano: "1715000010000000000",
          lastSeenUnixNano: "1715000020000000000",
          endedUnixNano: null,
        },
      ],
    });
    expect(html).not.toContain(`class="shepherd-strip"`);
  });

  it("renders one sub-strip row per active PR (multiple PRs)", () => {
    const html = renderListView({
      rows: issueRows,
      linearEnabled: false,
      todoQueue: [],
      snapshotsByIdentifier: new Map<string, LinearSnapshotRow>(),
      activeDrain,
      activeShepherding: [
        {
          traceId: "trace-x",
          prNumber: 142,
          subscription: null,
          iteration: 1,
          maxIterations: 3,
          state: "acting" as const,
          description: null,
          startedUnixNano: "1715000010000000000",
          lastSeenUnixNano: "1715000020000000000",
          endedUnixNano: null,
        },
        {
          traceId: "trace-x",
          prNumber: 200,
          subscription: null,
          iteration: null,
          maxIterations: null,
          state: "hitl" as const,
          description: null,
          startedUnixNano: "1715000020000000000",
          lastSeenUnixNano: "1715000030000000000",
          endedUnixNano: null,
        },
      ],
    });
    expect(html).toContain("PR #142");
    expect(html).toContain("PR #200");
    expect(html).toContain("shepherd-state-acting");
    expect(html).toContain("shepherd-state-hitl");
    expect(html).toContain("HITL — needs human attention");
  });
});
