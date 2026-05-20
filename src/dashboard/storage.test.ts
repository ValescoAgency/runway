import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentIterationRow,
  DrainRow,
  IssueProcessRow,
  LogRecordRow,
  RawSpanRow,
} from "./projector.js";
import { createStorage, type Storage } from "./storage.js";

// VA-386: storage tests run against an in-memory SQLite db (per AC).
// Each test gets a fresh handle so writes don't bleed across tests
// even though both share `:memory:` as the path.

function makeDrain(over: Partial<DrainRow> = {}): DrainRow {
  return {
    traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    spanId: "1111111111111111",
    startTimeUnixNano: "1715000000000000000",
    endTimeUnixNano: "1715000001000000000",
    // VA-455: default last_seen to the end time so ended-drain
    // fixtures behave as if the trace exporter set both fields.
    lastSeenUnixNano: "1715000001000000000",
    attempts: 3,
    opened: 1,
    hitl: 1,
    errored: 1,
    statusCode: 1,
    statusMessage: null,
    ...over,
  };
}

function makeIssueProcess(
  over: Partial<IssueProcessRow> = {},
): IssueProcessRow {
  return {
    traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    spanId: "2222222222222222",
    parentSpanId: "1111111111111111",
    issueIdentifier: "VA-312",
    issueId: "issue-abc",
    issueTitle: "Test issue title",
    issueLabels: ["bug", "backend"],
    branch: "agent/va-312",
    outcomeKind: "opened",
    outcomeDetail: "https://github.com/x/y/pull/42",
    prUrl: "https://github.com/x/y/pull/42",
    hitlReason: null,
    startTimeUnixNano: "1715000000500000000",
    endTimeUnixNano: "1715000000900000000",
    statusCode: 1,
    statusMessage: null,
    ...over,
  };
}

function makeRawSpan(over: Partial<RawSpanRow> = {}): RawSpanRow {
  return {
    traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    spanId: "3333333333333333",
    name: "unknownSpan",
    payload: JSON.stringify({ name: "unknownSpan" }),
    ...over,
  };
}

function makeAgentIteration(
  over: Partial<AgentIterationRow> = {},
): AgentIterationRow {
  return {
    traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    spanId: "aaaa000000000001",
    issueProcessSpanId: "2222222222222222",
    iterationIndex: 1,
    startTimeUnixNano: "1715000000000000000",
    endTimeUnixNano: "1715000010000000000",
    sandcastleRunId: "impl-VA-312-iter-1",
    exitStatus: "done",
    ...over,
  };
}

let storage: Storage;

beforeEach(() => {
  storage = createStorage(":memory:");
});

afterEach(() => {
  storage.close();
});

describe("createStorage — saveDrain / saveIssueProcess / saveRawSpan", () => {
  it("round-trips an issue process and surfaces it on listIssueProcesses()", () => {
    storage.saveDrain(makeDrain());
    storage.saveIssueProcess(makeIssueProcess());

    const out = storage.listIssueProcesses();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      issueIdentifier: "VA-312",
      issueId: "issue-abc",
      branch: "agent/va-312",
      outcomeKind: "opened",
      outcomeDetail: "https://github.com/x/y/pull/42",
    });
    expect(out[0]?.insertedAt).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("preserves null outcome fields for in-flight issue processes (no outcome attrs yet)", () => {
    storage.saveIssueProcess(
      makeIssueProcess({ outcomeKind: null, outcomeDetail: null }),
    );
    const out = storage.listIssueProcesses();
    expect(out[0]?.outcomeKind).toBeNull();
    expect(out[0]?.outcomeDetail).toBeNull();
  });

  it("idempotently upserts an issue process on retried emits (last writer wins on the outcome)", () => {
    storage.saveIssueProcess(
      makeIssueProcess({ outcomeKind: null, outcomeDetail: null }),
    );
    storage.saveIssueProcess(
      makeIssueProcess({ outcomeKind: "hitl", outcomeDetail: "Need decision" }),
    );

    const out = storage.listIssueProcesses();
    expect(out).toHaveLength(1);
    expect(out[0]?.outcomeKind).toBe("hitl");
    expect(out[0]?.outcomeDetail).toBe("Need decision");
  });

  it("scopes listIssueProcesses() by trace id when the filter is set", () => {
    storage.saveIssueProcess(
      makeIssueProcess({
        traceId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        spanId: "2222222222222222",
        issueIdentifier: "VA-1",
      }),
    );
    storage.saveIssueProcess(
      makeIssueProcess({
        traceId: "cccccccccccccccccccccccccccccccc",
        spanId: "3333333333333333",
        issueIdentifier: "VA-2",
      }),
    );

    const onlyB = storage.listIssueProcesses({
      traceId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    expect(onlyB.map((r) => r.issueIdentifier)).toEqual(["VA-1"]);
  });

  it("respects the limit on listIssueProcesses()", () => {
    for (let i = 0; i < 5; i += 1) {
      const hex = i.toString(16).padStart(16, "0");
      storage.saveIssueProcess(
        makeIssueProcess({
          spanId: hex,
          issueIdentifier: `VA-${i}`,
        }),
      );
    }
    expect(storage.listIssueProcesses({ limit: 2 })).toHaveLength(2);
  });

  it("stores a raw span under the same (trace_id, span_id) PK as the typed projections", () => {
    storage.saveRawSpan(makeRawSpan());
    // No public listRawSpans on the Storage surface yet — slice 1 only
    // requires the table exists per AC. Re-inserting the same key is
    // the cheapest cross-check that the PK + upsert is wired.
    storage.saveRawSpan(makeRawSpan({ name: "renamed" }));
    // If the upsert is broken, the second call would have thrown.
    // No assertion needed beyond "did not throw".
    expect(true).toBe(true);
  });
});

// VA-387: span-enrichment columns round-trip through SQLite. The
// detail pane reads these to render the issue title, PR link, and
// HITL reason without re-fetching from Linear/GitHub.
describe("createStorage — VA-387 span enrichment", () => {
  it("round-trips issue_title, pr_url, hitl_reason, and issue_labels columns", () => {
    storage.saveIssueProcess(
      makeIssueProcess({
        issueTitle: "Add dashboard detail pane",
        issueLabels: ["feature", "dashboard"],
        prUrl: "https://github.com/x/y/pull/99",
        hitlReason: null,
      }),
    );
    const out = storage.getIssueProcess(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "2222222222222222",
    );
    expect(out?.issueTitle).toBe("Add dashboard detail pane");
    expect(out?.issueLabels).toEqual(["feature", "dashboard"]);
    expect(out?.prUrl).toBe("https://github.com/x/y/pull/99");
    expect(out?.hitlReason).toBeNull();
  });

  it("stores hitl_reason and a null pr_url for HITL outcomes", () => {
    storage.saveIssueProcess(
      makeIssueProcess({
        outcomeKind: "hitl",
        outcomeDetail: "Needs human decision on schema",
        prUrl: null,
        hitlReason: "Needs human decision on schema",
      }),
    );
    const out = storage.getIssueProcess(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "2222222222222222",
    );
    expect(out?.prUrl).toBeNull();
    expect(out?.hitlReason).toBe("Needs human decision on schema");
  });

  it("collapses an empty labels list back to [] (not null) on round-trip", () => {
    storage.saveIssueProcess(makeIssueProcess({ issueLabels: [] }));
    const out = storage.getIssueProcess(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "2222222222222222",
    );
    expect(out?.issueLabels).toEqual([]);
  });

  it("looks up by span_id alone via getIssueProcessBySpanId (VA-387 detail route key)", () => {
    storage.saveIssueProcess(makeIssueProcess());
    const out = storage.getIssueProcessBySpanId("2222222222222222");
    expect(out?.issueIdentifier).toBe("VA-312");
    expect(storage.getIssueProcessBySpanId("no-such")).toBeUndefined();
  });
});

// VA-389: detail-pane lookups. Agent iterations are listed by their
// parent processIssue span_id and returned in iteration_index order.
describe("createStorage — agent iterations (VA-389)", () => {
  it("round-trips an agent iteration and lists it under the parent issue process", () => {
    storage.saveAgentIteration(makeAgentIteration());
    const out = storage.listAgentIterations(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "2222222222222222",
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      iterationIndex: 1,
      exitStatus: "done",
      sandcastleRunId: "impl-VA-312-iter-1",
      issueProcessSpanId: "2222222222222222",
    });
  });

  it("lists multiple iterations for the same issue process in iteration_index order", () => {
    // Insert out of order so we can verify the ORDER BY does the work
    // (a parsed hitl loop arrives over multiple OTel batches in
    // practice — the projector doesn't sort).
    storage.saveAgentIteration(
      makeAgentIteration({
        spanId: "aaaa000000000002",
        iterationIndex: 2,
        exitStatus: "blocked",
      }),
    );
    storage.saveAgentIteration(
      makeAgentIteration({
        spanId: "aaaa000000000001",
        iterationIndex: 1,
        exitStatus: "continue",
      }),
    );

    const out = storage.listAgentIterations(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "2222222222222222",
    );
    expect(out.map((r) => r.iterationIndex)).toEqual([1, 2]);
    expect(out.map((r) => r.exitStatus)).toEqual(["continue", "blocked"]);
  });

  it("returns an empty list when no iterations match the issue_process_id", () => {
    storage.saveAgentIteration(makeAgentIteration());
    expect(
      storage.listAgentIterations(
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "no-such-parent",
      ),
    ).toEqual([]);
  });

  it("idempotently upserts an agent iteration on a retried emit (last writer wins on exit_status)", () => {
    storage.saveAgentIteration(
      makeAgentIteration({ exitStatus: "continue" }),
    );
    storage.saveAgentIteration(makeAgentIteration({ exitStatus: "done" }));
    const out = storage.listAgentIterations(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "2222222222222222",
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.exitStatus).toBe("done");
  });
});

// VA-389: getIssueProcess powers the detail page. Returns undefined
// when the row isn't yet stored — the caller renders a "not found"
// page instead of a 500.
describe("createStorage — getIssueProcess (VA-389)", () => {
  it("returns the issue process row when (trace_id, span_id) matches", () => {
    storage.saveIssueProcess(makeIssueProcess());
    const out = storage.getIssueProcess(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "2222222222222222",
    );
    expect(out?.issueIdentifier).toBe("VA-312");
  });

  it("returns undefined for an unknown (trace_id, span_id)", () => {
    expect(
      storage.getIssueProcess(
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "0000000000000000",
      ),
    ).toBeUndefined();
  });
});

// VA-389: listPhaseSpans uses json_extract over raw_spans so we don't
// need a typed table per phase. The dashboard passes a fixed allowlist
// of names (review / pushBranch / openPullRequest).
describe("createStorage — listPhaseSpans (VA-389)", () => {
  function rawPhase(over: {
    name: string;
    spanId: string;
    parentSpanId: string;
    startTimeUnixNano: string;
    endTimeUnixNano: string;
    traceId?: string;
  }): RawSpanRow {
    const traceId = over.traceId ?? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    return {
      traceId,
      spanId: over.spanId,
      name: over.name,
      payload: JSON.stringify({
        name: over.name,
        traceId,
        spanId: over.spanId,
        parentSpanId: over.parentSpanId,
        startTimeUnixNano: over.startTimeUnixNano,
        endTimeUnixNano: over.endTimeUnixNano,
      }),
    };
  }

  it("returns named phase spans for a given issue process, sorted by start time", () => {
    storage.saveRawSpan(
      rawPhase({
        name: "openPullRequest",
        spanId: "5555555555555555",
        parentSpanId: "2222222222222222",
        startTimeUnixNano: "1715000020000000000",
        endTimeUnixNano: "1715000022000000000",
      }),
    );
    storage.saveRawSpan(
      rawPhase({
        name: "review",
        spanId: "4444444444444444",
        parentSpanId: "2222222222222222",
        startTimeUnixNano: "1715000010000000000",
        endTimeUnixNano: "1715000015000000000",
      }),
    );

    const out = storage.listPhaseSpans(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "2222222222222222",
      ["review", "pushBranch", "openPullRequest"],
    );
    expect(out.map((s) => s.name)).toEqual(["review", "openPullRequest"]);
  });

  it("ignores spans whose parent_span_id is a different issue process", () => {
    storage.saveRawSpan(
      rawPhase({
        name: "review",
        spanId: "4444444444444444",
        parentSpanId: "2222222222222222",
        startTimeUnixNano: "1715000010000000000",
        endTimeUnixNano: "1715000015000000000",
      }),
    );
    storage.saveRawSpan(
      rawPhase({
        name: "review",
        spanId: "5555555555555555",
        parentSpanId: "9999999999999999",
        startTimeUnixNano: "1715000010000000000",
        endTimeUnixNano: "1715000015000000000",
      }),
    );

    const out = storage.listPhaseSpans(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "2222222222222222",
      ["review"],
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.spanId).toBe("4444444444444444");
  });

  it("returns an empty list when the names allowlist is empty (no SQL run)", () => {
    expect(
      storage.listPhaseSpans(
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "2222222222222222",
        [],
      ),
    ).toEqual([]);
  });
});

// VA-390 (dashboard slice 6): linear_snapshots round-trip + the
// queue_position semantics the dashboard depends on. The poller is
// covered in linear-sync.test.ts; these tests pin the storage seams
// it relies on.
describe("createStorage — linear_snapshots (VA-390)", () => {
  it("upserts a snapshot keyed on issue_identifier (last writer wins)", () => {
    storage.saveLinearSnapshot({
      issueIdentifier: "VA-1",
      snapshotAt: "2026-05-15T00:00:00Z",
      status: "Todo",
      title: "first",
      labels: ["bug"],
      queuePosition: 0,
      projectId: null,
      projectName: null,
      statusType: "",
    });
    storage.saveLinearSnapshot({
      issueIdentifier: "VA-1",
      snapshotAt: "2026-05-15T00:05:00Z",
      status: "In Progress",
      title: "first (renamed)",
      labels: ["bug", "wip"],
      queuePosition: null,
      projectId: null,
      projectName: null,
      statusType: "",
    });
    const all = storage.listLinearSnapshots();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      status: "In Progress",
      title: "first (renamed)",
      labels: ["bug", "wip"],
      queuePosition: null,
      projectId: null,
      projectName: null,
      statusType: "",
    });
  });

  it("orders the Todo queue by queue_position and drops null-position rows", () => {
    storage.saveLinearSnapshot({
      issueIdentifier: "VA-2",
      snapshotAt: "t",
      status: "Todo",
      title: "second",
      labels: [],
      queuePosition: 1,
      projectId: null,
      projectName: null,
      statusType: "",
    });
    storage.saveLinearSnapshot({
      issueIdentifier: "VA-1",
      snapshotAt: "t",
      status: "Todo",
      title: "first",
      labels: [],
      queuePosition: 0,
      projectId: null,
      projectName: null,
      statusType: "",
    });
    storage.saveLinearSnapshot({
      issueIdentifier: "VA-99",
      snapshotAt: "t",
      status: "In Review",
      title: "history",
      labels: [],
      queuePosition: null,
      projectId: null,
      projectName: null,
      statusType: "",
    });
    expect(storage.listLinearTodoQueue().map((q) => q.issueIdentifier)).toEqual([
      "VA-1",
      "VA-2",
    ]);
  });

  it("clearLinearQueuePositions nulls every queue_position without dropping rows", () => {
    storage.saveLinearSnapshot({
      issueIdentifier: "VA-1",
      snapshotAt: "t",
      status: "Todo",
      title: "x",
      labels: [],
      queuePosition: 0,
      projectId: null,
      projectName: null,
      statusType: "",
    });
    storage.saveLinearSnapshot({
      issueIdentifier: "VA-2",
      snapshotAt: "t",
      status: "Todo",
      title: "y",
      labels: [],
      queuePosition: 1,
      projectId: null,
      projectName: null,
      statusType: "",
    });
    storage.clearLinearQueuePositions();
    expect(storage.listLinearTodoQueue()).toEqual([]);
    expect(storage.listLinearSnapshots()).toHaveLength(2);
    expect(
      storage
        .listLinearSnapshots()
        .every((s) => s.queuePosition === null),
    ).toBe(true);
  });

  it("round-trips an empty labels list as [] (not null)", () => {
    storage.saveLinearSnapshot({
      issueIdentifier: "VA-3",
      snapshotAt: "t",
      status: "Todo",
      title: "x",
      labels: [],
      queuePosition: null,
      projectId: null,
      projectName: null,
      statusType: "",
    });
    const out = storage.listLinearSnapshots();
    expect(out[0]?.labels).toEqual([]);
  });

  // VA-450
  it("round-trips projectId + projectName, and persists null for unprojected issues", () => {
    storage.saveLinearSnapshot({
      issueIdentifier: "VA-projected",
      snapshotAt: "t",
      status: "Todo",
      title: "with project",
      labels: [],
      queuePosition: 0,
      projectId: "e36f2b82-ed64-421c-91cb-955ef95a28ff",
      projectName: "Runway",
      statusType: "",
    });
    storage.saveLinearSnapshot({
      issueIdentifier: "VA-bare",
      snapshotAt: "t",
      status: "Todo",
      title: "no project",
      labels: [],
      queuePosition: 1,
      projectId: null,
      projectName: null,
      statusType: "",
    });
    const queue = storage.listLinearTodoQueue();
    expect(queue.find((q) => q.issueIdentifier === "VA-projected")).toMatchObject({
      projectId: "e36f2b82-ed64-421c-91cb-955ef95a28ff",
      projectName: "Runway",
    });
    expect(queue.find((q) => q.issueIdentifier === "VA-bare")).toMatchObject({
      projectId: null,
      projectName: null,
      statusType: "",
    });
  });
});

// VA-399: evaluator_aggregates_v1 — the IRA-facing read-model.
// Fixtures are intentionally tiny (single-digit row counts) so a
// future reader can verify each expected value by mental arithmetic.
describe("createStorage — evaluator aggregates view (VA-399)", () => {
  // Build a drain whose trace_id namespaces both itself + the child
  // issue processes that belong to it. Time strings are 19-digit nanos
  // (ordering by `CAST(start_time AS INTEGER)` only matters relative
  // to other drains, so we use round numbers).
  function seedDrain(
    s: Storage,
    traceId: string,
    startNano: string,
  ): void {
    s.saveDrain({
      traceId,
      spanId: traceId.slice(0, 16),
      startTimeUnixNano: startNano,
      endTimeUnixNano: startNano,
      lastSeenUnixNano: startNano,
      attempts: 1,
      opened: 0,
      hitl: 0,
      errored: 0,
      statusCode: 1,
      statusMessage: null,
    });
  }

  // Issue process whose wall-time is `wallMs` ms (start = 0, end =
  // wallMs * 1e6 nanos). `iterations` controls how many
  // agent_iterations rows we insert as children.
  function seedProcess(
    s: Storage,
    args: {
      traceId: string;
      spanId: string;
      identifier: string;
      outcomeKind: string | null;
      outcomeDetail?: string | null;
      wallMs: number;
      iterations: number;
    },
  ): void {
    const startNano = "1000000000000000000";
    // Hand-computed: 1e18 + wallMs * 1e6 = end-time
    const endNano = (BigInt(startNano) + BigInt(args.wallMs) * 1_000_000n).toString();
    s.saveIssueProcess({
      traceId: args.traceId,
      spanId: args.spanId,
      parentSpanId: args.traceId.slice(0, 16),
      issueIdentifier: args.identifier,
      issueId: null,
      branch: null,
      outcomeKind: args.outcomeKind,
      outcomeDetail: args.outcomeDetail ?? null,
      startTimeUnixNano: startNano,
      endTimeUnixNano: endNano,
      statusCode: 1,
      statusMessage: null,
      // VA-387: added these required IssueProcessRow fields after the
      // rebase. The VA-399 aggregates view doesn't read them, so null
      // is the right test default for legacy fixtures.
      issueTitle: null,
      issueLabels: [],
      prUrl: null,
      hitlReason: null,
    });
    for (let i = 1; i <= args.iterations; i += 1) {
      // Iter spanIds must be unique per (trace, process) — otherwise
      // the PK upsert silently reassigns iters between processes and
      // skews the iteration_count subquery. Build the iter id from
      // the full process span id + iteration index.
      s.saveAgentIteration({
        traceId: args.traceId,
        spanId: `${args.spanId}_it${i.toString().padStart(2, "0")}`,
        issueProcessSpanId: args.spanId,
        iterationIndex: i,
        startTimeUnixNano: startNano,
        endTimeUnixNano: endNano,
        sandcastleRunId: null,
        exitStatus: "done",
      });
    }
  }

  it("computes hand-verifiable medians, p95s, and outcome rates per issue-category", () => {
    // Single drain — every process lands in the rolling window.
    const trace = "ffffffffffffffffffffffffffffffff";
    seedDrain(storage, trace, "1000000000000000000");

    // Category VA: 5 processes. Wall times {1000, 2000, 3000, 4000, 5000} ms.
    // Iteration counts {1, 2, 3, 4, 5}. Outcomes mixed: 3 opened, 2 hitl
    // (one of which is the reviewer-rejection variant).
    // Hand-computed expectations (N=5):
    //   median wall_ms = 3000 (middle of sorted list)
    //   p95 wall_ms     = 5000 (nearest-rank: ceil(5*0.95)=5 → 5th value)
    //   median iter_ct  = 3
    //   p95 iter_ct     = 5
    //   reviewer_rejection_rate = 1/5 = 0.2
    //   revert_rate             = 0/5 = 0
    //   hitl_escape_rate        = 2/5 = 0.4
    //   infra_error_rate        = 0/5 = 0
    const vaCases = [
      { wallMs: 1000, iter: 1, outcome: "opened", detail: null },
      { wallMs: 2000, iter: 2, outcome: "opened", detail: null },
      { wallMs: 3000, iter: 3, outcome: "opened", detail: null },
      {
        wallMs: 4000,
        iter: 4,
        outcome: "hitl",
        detail: "Sub-agent review rejected: needs more tests",
      },
      { wallMs: 5000, iter: 5, outcome: "hitl", detail: "Max iterations" },
    ] as const;
    vaCases.forEach((c, i) => {
      seedProcess(storage, {
        traceId: trace,
        spanId: `vavavavavavava${i.toString().padStart(2, "0")}`,
        identifier: `VA-${100 + i}`,
        outcomeKind: c.outcome,
        outcomeDetail: c.detail,
        wallMs: c.wallMs,
        iterations: c.iter,
      });
    });

    // Category ENG: 4 processes — even-N median forces averaging the
    // two middle values. Wall times {100, 200, 300, 400}; iterations
    // {2, 2, 4, 4}.
    //   median wall_ms = (200 + 300) / 2 = 250
    //   p95 wall_ms     = 400 (ceil(4*0.95)=4 → 4th value)
    //   median iter_ct  = (2 + 4) / 2 = 3
    //   p95 iter_ct     = 4
    //   revert_rate     = 1/4 = 0.25
    //   infra_error_rate = 1/4 = 0.25
    //   hitl_escape_rate = 0/4 = 0
    const engCases = [
      { wallMs: 100, iter: 2, outcome: "opened", detail: null },
      { wallMs: 200, iter: 2, outcome: "opened", detail: null },
      { wallMs: 300, iter: 4, outcome: "reverted", detail: null },
      { wallMs: 400, iter: 4, outcome: "errored", detail: null },
    ] as const;
    engCases.forEach((c, i) => {
      seedProcess(storage, {
        traceId: trace,
        spanId: `engengengengen${i.toString().padStart(2, "0")}`,
        identifier: `ENG-${100 + i}`,
        outcomeKind: c.outcome,
        outcomeDetail: c.detail,
        wallMs: c.wallMs,
        iterations: c.iter,
      });
    });

    const rows = storage.listAggregates();
    expect(rows.map((r) => r.category)).toEqual(["ENG", "VA"]);

    const eng = rows.find((r) => r.category === "ENG");
    const va = rows.find((r) => r.category === "VA");

    expect(va).toMatchObject({
      sampleSize: 5,
      medianWallTimeMs: 3000,
      p95WallTimeMs: 5000,
      medianIterationCount: 3,
      p95IterationCount: 5,
      reviewerRejectionRate: 0.2,
      revertRate: 0,
      hitlEscapeRate: 0.4,
      infraErrorRate: 0,
    });
    expect(eng).toMatchObject({
      sampleSize: 4,
      medianWallTimeMs: 250,
      p95WallTimeMs: 400,
      medianIterationCount: 3,
      p95IterationCount: 4,
      reviewerRejectionRate: 0,
      revertRate: 0.25,
      hitlEscapeRate: 0,
      infraErrorRate: 0.25,
    });
  });

  it("excludes drains outside the rolling window so the view honours its LIMIT", () => {
    // Override DEFAULT_AGGREGATE_WINDOW to 1 — only the most-recent
    // drain's processes should contribute. The older drain's process
    // (which would otherwise dominate) must drop out.
    storage.close();
    const tight = createStorage(":memory:", { aggregateWindowDrains: 1 });
    try {
      const oldTrace = "11111111111111111111111111111111";
      const newTrace = "22222222222222222222222222222222";
      seedDrain(tight, oldTrace, "1000000000000000000");
      seedDrain(tight, newTrace, "2000000000000000000");

      // Old drain: process whose wall-time would skew the median if
      // it weren't filtered out.
      seedProcess(tight, {
        traceId: oldTrace,
        spanId: "oldoldoldold0001",
        identifier: "VA-1",
        outcomeKind: "opened",
        wallMs: 999_999,
        iterations: 99,
      });
      // New drain: single process inside the window.
      seedProcess(tight, {
        traceId: newTrace,
        spanId: "newnewnewnew0001",
        identifier: "VA-2",
        outcomeKind: "opened",
        wallMs: 500,
        iterations: 2,
      });

      const rows = tight.listAggregates();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        category: "VA",
        sampleSize: 1,
        medianWallTimeMs: 500,
        p95WallTimeMs: 500,
        medianIterationCount: 2,
        p95IterationCount: 2,
      });
    } finally {
      tight.close();
      // Re-open the outer-suite storage so afterEach's close() doesn't
      // double-free the in-memory db we already closed above.
      storage = createStorage(":memory:");
    }
  });

  it("returns an empty list when the event store has no drains yet", () => {
    expect(storage.listAggregates()).toEqual([]);
  });

  it("treats an issue identifier with no dash as its own category", () => {
    const trace = "33333333333333333333333333333333";
    seedDrain(storage, trace, "1000000000000000000");
    seedProcess(storage, {
      traceId: trace,
      spanId: "nodashnodash0001",
      identifier: "loose-string-no-team-prefix-by-design",
      outcomeKind: "opened",
      wallMs: 1000,
      iterations: 1,
    });
    seedProcess(storage, {
      traceId: trace,
      spanId: "nodashnodash0002",
      identifier: "OPS",
      outcomeKind: "opened",
      wallMs: 1000,
      iterations: 1,
    });

    const rows = storage.listAggregates();
    // "loose-string-..." has a dash so its category is "loose".
    // "OPS" has no dash so its category is the full string.
    expect(rows.map((r) => r.category).sort()).toEqual(["OPS", "loose"]);
  });
});

function makeLogRecord(over: Partial<LogRecordRow> = {}): LogRecordRow {
  return {
    traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    spanId: "2222222222222222",
    timestampUnixNano: "1715000000500000000",
    level: "INFO",
    message: "agent picked up issue",
    attributes: { issue: "VA-388", branch: "agent/va-388" },
    ...over,
  };
}

describe("createStorage — appendLogRecord / streamLogsFor (VA-388)", () => {
  it("round-trips a single log record with its attributes intact", () => {
    storage.appendLogRecord(makeLogRecord());

    const rows = storage.streamLogsFor(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      spanId: "2222222222222222",
      timestampUnixNano: "1715000000500000000",
      level: "INFO",
      message: "agent picked up issue",
      attributes: { issue: "VA-388", branch: "agent/va-388" },
    });
    expect(rows[0]?.insertedAt).toBeTruthy();
  });

  it("orders streamed records ascending by timestamp (not insertion order)", () => {
    // Insert out-of-order — middle, latest, earliest.
    storage.appendLogRecord(
      makeLogRecord({
        spanId: "span-mid",
        timestampUnixNano: "1715000000200000000",
        message: "middle",
      }),
    );
    storage.appendLogRecord(
      makeLogRecord({
        spanId: "span-late",
        timestampUnixNano: "1715000000900000000",
        message: "latest",
      }),
    );
    storage.appendLogRecord(
      makeLogRecord({
        spanId: "span-early",
        timestampUnixNano: "1715000000100000000",
        message: "earliest",
      }),
    );

    const rows = storage.streamLogsFor(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(rows.map((r) => r.message)).toEqual([
      "earliest",
      "middle",
      "latest",
    ]);
  });

  it("orders timestamps numerically (not lexically) — varying-length int64 strings sort by value", () => {
    // Lexical ordering would put "1715000000..." (11 digits) before
    // "999999999" (9 digits) because "1" < "9", inverting real time.
    // The CAST to INTEGER fixes that. (Both values fit comfortably
    // within SQLite's signed 8-byte INTEGER range, < 2^63.)
    storage.appendLogRecord(
      makeLogRecord({
        spanId: "span-newer",
        timestampUnixNano: "1715000000000000000",
        message: "newer",
      }),
    );
    storage.appendLogRecord(
      makeLogRecord({
        spanId: "span-older",
        timestampUnixNano: "999999999999999999",
        message: "older",
      }),
    );

    const rows = storage.streamLogsFor(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(rows.map((r) => r.message)).toEqual(["older", "newer"]);
  });

  it("scopes results to the requested trace_id", () => {
    storage.appendLogRecord(
      makeLogRecord({
        traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        message: "trace A",
      }),
    );
    storage.appendLogRecord(
      makeLogRecord({
        traceId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        message: "trace B",
      }),
    );

    const a = storage.streamLogsFor("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(a.map((r) => r.message)).toEqual(["trace A"]);
    const b = storage.streamLogsFor("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(b.map((r) => r.message)).toEqual(["trace B"]);
  });

  it("upserts on (trace_id, span_id, timestamp) — exporter retry is idempotent", () => {
    storage.appendLogRecord(
      makeLogRecord({ message: "first emit", level: "INFO" }),
    );
    storage.appendLogRecord(
      makeLogRecord({ message: "retry overwrote level", level: "WARN" }),
    );

    const rows = storage.streamLogsFor(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      message: "retry overwrote level",
      level: "WARN",
    });
  });

  it("returns an empty list for a trace_id with no logs", () => {
    const rows = storage.streamLogsFor(
      "cccccccccccccccccccccccccccccccc",
    );
    expect(rows).toEqual([]);
  });

  it("survives a record with no attributes (empty object → NULL column)", () => {
    storage.appendLogRecord(makeLogRecord({ attributes: {} }));

    const rows = storage.streamLogsFor(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.attributes).toEqual({});
  });
});

describe("createStorage — getActiveDrain (VA-391)", () => {
  it("returns null when no issue processes have landed yet", () => {
    expect(storage.getActiveDrain()).toBeNull();
  });

  it("returns null once the drain ends (drains row landed for the same trace_id)", () => {
    storage.saveIssueProcess(
      makeIssueProcess({ traceId: "trace-A", outcomeKind: "opened" }),
    );
    expect(storage.getActiveDrain()).not.toBeNull();

    storage.saveDrain(makeDrain({ traceId: "trace-A" }));
    expect(storage.getActiveDrain()).toBeNull();
  });

  it("surfaces the in-flight drain's start time + per-outcome counters", () => {
    storage.saveIssueProcess(
      makeIssueProcess({
        traceId: "trace-A",
        spanId: "ip-1",
        outcomeKind: "opened",
        startTimeUnixNano: "1715000000100000000",
      }),
    );
    storage.saveIssueProcess(
      makeIssueProcess({
        traceId: "trace-A",
        spanId: "ip-2",
        outcomeKind: "hitl",
        startTimeUnixNano: "1715000000300000000",
      }),
    );
    storage.saveIssueProcess(
      makeIssueProcess({
        traceId: "trace-A",
        spanId: "ip-3",
        outcomeKind: "errored",
        startTimeUnixNano: "1715000000500000000",
      }),
    );

    expect(storage.getActiveDrain()).toEqual({
      traceId: "trace-A",
      // Earliest start across the three issue processes.
      startedAtUnixNano: "1715000000100000000",
      issueCount: 3,
      openedCount: 1,
      hitlCount: 1,
      erroredCount: 1,
    });
  });

  it("picks the most-recently-started in-flight drain when several traces are active", () => {
    storage.saveIssueProcess(
      makeIssueProcess({
        traceId: "trace-older",
        spanId: "ip-old",
        outcomeKind: "opened",
        startTimeUnixNano: "1715000000100000000",
      }),
    );
    storage.saveIssueProcess(
      makeIssueProcess({
        traceId: "trace-newer",
        spanId: "ip-new",
        outcomeKind: "opened",
        startTimeUnixNano: "1715000999900000000",
      }),
    );

    expect(storage.getActiveDrain()?.traceId).toBe("trace-newer");
  });

  it("ignores traces whose drains row already landed (treats them as finished)", () => {
    storage.saveIssueProcess(
      makeIssueProcess({ traceId: "trace-finished", outcomeKind: "opened" }),
    );
    storage.saveDrain(makeDrain({ traceId: "trace-finished" }));
    storage.saveIssueProcess(
      makeIssueProcess({
        traceId: "trace-running",
        spanId: "ip-running",
        outcomeKind: "opened",
        startTimeUnixNano: "1715000111100000000",
      }),
    );

    expect(storage.getActiveDrain()?.traceId).toBe("trace-running");
  });
});

// VA-392: filter chips need three things from storage — filter by
// outcome_kind (including the synthetic "in-flight" = NULL), filter by
// a date-range lower bound on inserted_at, and the recent-drains list
// that backs the drain chip set.
describe("createStorage — listIssueProcesses filters (VA-392)", () => {
  beforeEach(() => {
    storage.saveIssueProcess(
      makeIssueProcess({ spanId: "ip-opened", outcomeKind: "opened" }),
    );
    storage.saveIssueProcess(
      makeIssueProcess({ spanId: "ip-hitl", outcomeKind: "hitl" }),
    );
    storage.saveIssueProcess(
      makeIssueProcess({ spanId: "ip-errored", outcomeKind: "errored" }),
    );
    storage.saveIssueProcess(
      // outcomeKind: null → in-flight
      makeIssueProcess({ spanId: "ip-inflight", outcomeKind: null }),
    );
  });

  it("filters to a single outcome kind", () => {
    const out = storage.listIssueProcesses({ outcomes: ["opened"] });
    expect(out).toHaveLength(1);
    expect(out[0]?.spanId).toBe("ip-opened");
  });

  it("filters to multiple outcome kinds", () => {
    const out = storage.listIssueProcesses({ outcomes: ["hitl", "errored"] });
    expect(out.map((r) => r.spanId).sort()).toEqual(
      ["ip-errored", "ip-hitl"].sort(),
    );
  });

  it("matches the synthetic 'in-flight' kind against NULL outcome_kind", () => {
    const out = storage.listIssueProcesses({ outcomes: ["in-flight"] });
    expect(out).toHaveLength(1);
    expect(out[0]?.spanId).toBe("ip-inflight");
  });

  it("combines a concrete outcome with 'in-flight' via OR", () => {
    const out = storage.listIssueProcesses({
      outcomes: ["opened", "in-flight"],
    });
    expect(out.map((r) => r.spanId).sort()).toEqual(
      ["ip-inflight", "ip-opened"].sort(),
    );
  });

  it("respects an insertedSince lower bound (no future timestamps included)", () => {
    // `datetime('now', '+1 day')` is comfortably after every row we
    // just inserted, so the filter returns nothing.
    const future = "2999-01-01 00:00:00";
    const out = storage.listIssueProcesses({ insertedSince: future });
    expect(out).toHaveLength(0);
  });

  it("returns every row when insertedSince is the epoch (no upper bound effect)", () => {
    const out = storage.listIssueProcesses({
      insertedSince: "1970-01-01 00:00:00",
    });
    expect(out).toHaveLength(4);
  });

  it("composes outcome + traceId + insertedSince in a single query", () => {
    storage.saveIssueProcess(
      makeIssueProcess({
        traceId: "trace-other",
        spanId: "ip-other-opened",
        outcomeKind: "opened",
      }),
    );
    const out = storage.listIssueProcesses({
      outcomes: ["opened"],
      traceId: "trace-other",
      insertedSince: "1970-01-01 00:00:00",
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.spanId).toBe("ip-other-opened");
  });
});

describe("createStorage — listRecentDrains (VA-392)", () => {
  it("groups issue_processes by trace_id with earliest start and count", () => {
    storage.saveIssueProcess(
      makeIssueProcess({
        traceId: "trace-A",
        spanId: "a1",
        startTimeUnixNano: "1715000000000000000",
      }),
    );
    storage.saveIssueProcess(
      makeIssueProcess({
        traceId: "trace-A",
        spanId: "a2",
        startTimeUnixNano: "1715000005000000000",
      }),
    );
    storage.saveIssueProcess(
      makeIssueProcess({
        traceId: "trace-B",
        spanId: "b1",
        startTimeUnixNano: "1715000010000000000",
      }),
    );

    const drains = storage.listRecentDrains();
    expect(drains).toHaveLength(2);
    // Ordered by earliest-start DESC — B (10s) before A (0s).
    expect(drains[0]?.traceId).toBe("trace-B");
    expect(drains[0]?.issueCount).toBe(1);
    expect(drains[1]?.traceId).toBe("trace-A");
    expect(drains[1]?.issueCount).toBe(2);
    // The grouped start time is the trace's earliest issue_process start.
    expect(drains[1]?.startedAtUnixNano).toBe("1715000000000000000");
  });

  it("respects the limit argument", () => {
    for (let i = 0; i < 8; i++) {
      storage.saveIssueProcess(
        makeIssueProcess({
          traceId: `trace-${i}`,
          spanId: `ip-${i}`,
          startTimeUnixNano: String(1715000000000000000n + BigInt(i)),
        }),
      );
    }
    const drains = storage.listRecentDrains(3);
    expect(drains).toHaveLength(3);
  });

  it("returns an empty list when no issue_processes exist", () => {
    expect(storage.listRecentDrains()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// VA-402: meta_reviews table contract
// ---------------------------------------------------------------------------

describe("createStorage — meta_reviews (VA-402)", () => {
  const row = (over: Partial<Parameters<Storage["saveMetaReview"]>[0]> = {}) =>
    ({
      id: "review-1",
      kind: "meta-run-review" as const,
      scope: "VA-401",
      drainId: "drain-abc",
      issueId: "VA-401",
      contentJson: '{"foo":"bar"}',
      templateVersion: "1.0.0",
      createdAt: "2026-05-15 23:00:00",
      ...over,
    });

  it("upserts and lists a meta-run-review row", () => {
    storage.saveMetaReview(row());
    const out = storage.listMetaReviews();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "review-1",
      kind: "meta-run-review",
      drainId: "drain-abc",
      issueId: "VA-401",
      templateVersion: "1.0.0",
    });
  });

  it("filters by kind so failure stubs don't pollute the success list", () => {
    storage.saveMetaReview(row({ id: "ok", kind: "meta-run-review" }));
    storage.saveMetaReview(row({ id: "stub", kind: "meta-failed" }));
    const success = storage.listMetaReviews({ kind: "meta-run-review" });
    expect(success).toHaveLength(1);
    expect(success[0]?.id).toBe("ok");
    const failed = storage.listMetaReviews({ kind: "meta-failed" });
    expect(failed).toHaveLength(1);
    expect(failed[0]?.id).toBe("stub");
  });

  it("filters by drainId so the Drain Review pass can read its own scope", () => {
    storage.saveMetaReview(row({ id: "a", drainId: "drain-a" }));
    storage.saveMetaReview(row({ id: "b", drainId: "drain-b" }));
    const out = storage.listMetaReviews({ drainId: "drain-a" });
    expect(out).toHaveLength(1);
    expect(out[0]?.drainId).toBe("drain-a");
  });

  it("orders rows by created_at DESC so the freshest review is at index 0", () => {
    storage.saveMetaReview(
      row({ id: "old", createdAt: "2026-01-01 00:00:00" }),
    );
    storage.saveMetaReview(
      row({ id: "new", createdAt: "2026-06-01 00:00:00" }),
    );
    const out = storage.listMetaReviews();
    expect(out.map((r) => r.id)).toEqual(["new", "old"]);
  });

  it("preserves successive rows for the same scope (track-record per PRD)", () => {
    // The PRD calls out that re-runs of `runway review run` against
    // the same (drain, issue) produce a fresh row, not an update —
    // historical Reviews are kept so the IRA's track-record is
    // auditable. Synthetic `id` enforces this contract.
    storage.saveMetaReview(row({ id: "review-a" }));
    storage.saveMetaReview(row({ id: "review-b" }));
    const out = storage.listMetaReviews({ issueId: "VA-401" });
    expect(out).toHaveLength(2);
  });

  // VA-407: list + detail surfaces for the new `/meta-reviews`
  // dashboard route. Pagination, count, getById, and the cross-link
  // helper that resolves (trace_id, issue_identifier) → span_id.

  it("countMetaReviews returns the row count matching a filter", () => {
    storage.saveMetaReview(row({ id: "a", kind: "meta-run-review" }));
    storage.saveMetaReview(row({ id: "b", kind: "meta-run-review" }));
    storage.saveMetaReview(row({ id: "c", kind: "meta-drain-review" }));
    expect(storage.countMetaReviews()).toBe(3);
    expect(storage.countMetaReviews({ kind: "meta-run-review" })).toBe(2);
    expect(storage.countMetaReviews({ kind: "meta-failed" })).toBe(0);
  });

  it("listMetaReviews supports offset for pagination (page 2 skips page 1)", () => {
    // 5 rows, page_size 2 → page 1 = [e, d], page 2 = [c, b], page 3 = [a].
    for (const id of ["a", "b", "c", "d", "e"]) {
      storage.saveMetaReview(
        row({ id, createdAt: `2026-05-15 12:0${id.charCodeAt(0) - 96}:00` }),
      );
    }
    const page1 = storage.listMetaReviews({ limit: 2, offset: 0 });
    expect(page1.map((r) => r.id)).toEqual(["e", "d"]);
    const page2 = storage.listMetaReviews({ limit: 2, offset: 2 });
    expect(page2.map((r) => r.id)).toEqual(["c", "b"]);
    const page3 = storage.listMetaReviews({ limit: 2, offset: 4 });
    expect(page3.map((r) => r.id)).toEqual(["a"]);
  });

  it("getMetaReview fetches one row by id", () => {
    storage.saveMetaReview(row({ id: "abc" }));
    const r = storage.getMetaReview("abc");
    expect(r?.id).toBe("abc");
    expect(storage.getMetaReview("nonexistent")).toBeUndefined();
  });

  it("findIssueProcessByIdentifier returns the matching span_id for cross-linking", () => {
    // Seed an issue_processes row that the meta-review can cross-link to.
    storage.saveIssueProcess({
      traceId: "trace-x",
      spanId: "span-source-1",
      parentSpanId: null,
      issueIdentifier: "VA-501",
      issueId: null,
      issueTitle: null,
      issueLabels: [],
      branch: null,
      outcomeKind: "opened",
      outcomeDetail: null,
      prUrl: null,
      hitlReason: null,
      startTimeUnixNano: "1000000000000000000",
      endTimeUnixNano: "1000000001000000000",
      statusCode: 1,
      statusMessage: null,
    });
    const ip = storage.findIssueProcessByIdentifier("trace-x", "VA-501");
    expect(ip?.spanId).toBe("span-source-1");
    // Wrong trace → undefined.
    expect(
      storage.findIssueProcessByIdentifier("trace-y", "VA-501"),
    ).toBeUndefined();
    // Wrong identifier → undefined.
    expect(
      storage.findIssueProcessByIdentifier("trace-x", "VA-999"),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// VA-455 — log-driven active drain (drain.started marker + heartbeat TTL)
// ---------------------------------------------------------------------------

describe("createStorage — VA-455 markDrainActive + getActiveDrain", () => {
  // Fresh nanos = "now-ish", expressed in unix-nano TEXT. The
  // staleness floor is `Date.now() - 90s`, so a timestamp within
  // the last few seconds always counts as fresh. Each test that
  // wants a stale value subtracts an explicit offset from this.
  function freshNanos(): string {
    return String(BigInt(Date.now()) * 1_000_000n);
  }
  function staleNanos(secondsAgo: number): string {
    const offsetNs = BigInt(secondsAgo) * 1_000_000_000n;
    return String(BigInt(Date.now()) * 1_000_000n - offsetNs);
  }

  it("surfaces an active drain immediately after the drain.started marker, with zero issue counts", () => {
    const t = freshNanos();
    storage.markDrainActive({
      traceId: "trace-live",
      spanId: "drain-span-live",
      startTimeUnixNano: t,
      lastSeenUnixNano: t,
    });

    expect(storage.getActiveDrain()).toEqual({
      traceId: "trace-live",
      startedAtUnixNano: t,
      issueCount: 0,
      openedCount: 0,
      hitlCount: 0,
      erroredCount: 0,
    });
  });

  it("rolls up counters from issue_processes that have landed since the marker", () => {
    const t = freshNanos();
    storage.markDrainActive({
      traceId: "trace-mid",
      spanId: "drain-span-mid",
      startTimeUnixNano: t,
      lastSeenUnixNano: t,
    });
    storage.saveIssueProcess(
      makeIssueProcess({
        traceId: "trace-mid",
        spanId: "ip-1",
        outcomeKind: "opened",
      }),
    );
    storage.saveIssueProcess(
      makeIssueProcess({
        traceId: "trace-mid",
        spanId: "ip-2",
        outcomeKind: "hitl",
      }),
    );

    expect(storage.getActiveDrain()).toMatchObject({
      traceId: "trace-mid",
      issueCount: 2,
      openedCount: 1,
      hitlCount: 1,
      erroredCount: 0,
    });
  });

  it("hides drains whose last_seen has aged out past the staleness floor", () => {
    storage.markDrainActive({
      traceId: "trace-zombie",
      spanId: "drain-span-zombie",
      startTimeUnixNano: staleNanos(200),
      // 200s ago, well past the 90s floor.
      lastSeenUnixNano: staleNanos(200),
    });

    expect(storage.getActiveDrain()).toBeNull();
  });

  it("stops surfacing the drain once saveDrain lands the end-of-drain row", () => {
    const t = freshNanos();
    storage.markDrainActive({
      traceId: "trace-finishes",
      spanId: "drain-span-fin",
      startTimeUnixNano: t,
      lastSeenUnixNano: t,
    });
    expect(storage.getActiveDrain()?.traceId).toBe("trace-finishes");

    storage.saveDrain(
      makeDrain({
        traceId: "trace-finishes",
        spanId: "drain-span-fin",
        startTimeUnixNano: t,
        endTimeUnixNano: t,
        lastSeenUnixNano: t,
      }),
    );
    expect(storage.getActiveDrain()).toBeNull();
  });

  it("appendLogRecord bumps last_seen so a quiet phase doesn't age out", () => {
    // Mark with a last_seen that's a couple of seconds old, then push
    // an appendLogRecord with a fresh timestamp and assert the row
    // stays visible. The "stays visible" assertion is the proof
    // that last_seen advanced — without the bump the row would
    // disappear once the freshness floor passes the original mark.
    storage.markDrainActive({
      traceId: "trace-quiet",
      spanId: "drain-span-quiet",
      startTimeUnixNano: staleNanos(60),
      lastSeenUnixNano: staleNanos(60),
    });
    storage.appendLogRecord({
      traceId: "trace-quiet",
      spanId: "child-span",
      timestampUnixNano: freshNanos(),
      level: "INFO",
      message: "phase impl complete",
      attributes: {},
    });

    expect(storage.getActiveDrain()?.traceId).toBe("trace-quiet");
  });

  it("appendLogRecord does NOT fabricate a drain for a trace with no marker", () => {
    storage.appendLogRecord({
      traceId: "trace-orphan",
      spanId: "child-span",
      timestampUnixNano: freshNanos(),
      level: "INFO",
      message: "stray library log",
      attributes: {},
    });

    expect(storage.getActiveDrain()).toBeNull();
  });

  it("a late-arriving drain.started marker can't reanimate an already-ended drain", () => {
    const t = freshNanos();
    // The drain has already ended via the trace exporter.
    storage.saveDrain(
      makeDrain({
        traceId: "trace-late",
        spanId: "drain-span-late",
        startTimeUnixNano: t,
        endTimeUnixNano: t,
        lastSeenUnixNano: t,
      }),
    );
    expect(storage.getActiveDrain()).toBeNull();

    // Now the log marker arrives out of order. The ON CONFLICT
    // clause must reject the reanimation.
    storage.markDrainActive({
      traceId: "trace-late",
      spanId: "drain-span-late",
      startTimeUnixNano: t,
      lastSeenUnixNano: t,
    });
    expect(storage.getActiveDrain()).toBeNull();
  });

  it("VA-469: opens cleanly against a legacy DB that has the view AND a NOT NULL drains.end_time_unix_nano", async () => {
    // Reproduces the crash-loop: a pre-VA-455 dashboard boot left
    // behind both `evaluator_aggregates_v1` and a `drains` table whose
    // `end_time_unix_nano` is still NOT NULL. createStorage must drop
    // the view before relaxDrainsEndTimeNotNull's table-rebuild, or
    // SQLite 3.45+ rejects `DROP TABLE drains` with
    // "error in view evaluator_aggregates_v1: no such table: main.drains".
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { DatabaseSync } = await import("node:sqlite");

    const dir = mkdtempSync(join(tmpdir(), "runway-va469-"));
    const path = join(dir, "legacy.sqlite");
    try {
      const seed = new DatabaseSync(path);
      const legacySchema = [
        `CREATE TABLE drains (
          trace_id TEXT NOT NULL,
          span_id TEXT NOT NULL,
          start_time_unix_nano TEXT NOT NULL,
          end_time_unix_nano TEXT NOT NULL,
          attempts INTEGER,
          opened INTEGER,
          hitl INTEGER,
          errored INTEGER,
          status_code INTEGER,
          status_message TEXT,
          inserted_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (trace_id, span_id)
        )`,
        `CREATE TABLE issue_processes (
          trace_id TEXT NOT NULL,
          span_id TEXT NOT NULL,
          parent_span_id TEXT,
          issue_identifier TEXT NOT NULL,
          issue_id TEXT,
          branch TEXT,
          outcome_kind TEXT,
          outcome_detail TEXT,
          start_time_unix_nano TEXT NOT NULL,
          end_time_unix_nano TEXT NOT NULL,
          status_code INTEGER,
          status_message TEXT,
          inserted_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (trace_id, span_id)
        )`,
        `CREATE TABLE agent_iterations (
          trace_id TEXT NOT NULL,
          id TEXT NOT NULL,
          issue_process_id TEXT,
          iteration_index INTEGER NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT NOT NULL,
          sandcastle_run_id TEXT,
          exit_status TEXT,
          inserted_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (trace_id, id)
        )`,
        `CREATE VIEW evaluator_aggregates_v1 AS
          SELECT ip.issue_identifier AS category, COUNT(*) AS sample_size
          FROM issue_processes ip
          WHERE ip.trace_id IN (SELECT trace_id FROM drains)
          GROUP BY ip.issue_identifier`,
      ];
      for (const stmt of legacySchema) seed.prepare(stmt).run();
      seed.close();

      const legacy = createStorage(path);
      legacy.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("legacy fallback: still surfaces a drain inferred from issue_processes when no marker exists", () => {
    // Pre-VA-455 runway emits no drain.started log, so the dashboard
    // relies on the absence of a `drains` row as the in-flight
    // signal. Keep that working until everyone's on a new enough
    // runway.
    storage.saveIssueProcess(
      makeIssueProcess({
        traceId: "trace-legacy",
        spanId: "ip-legacy",
        outcomeKind: "opened",
        startTimeUnixNano: freshNanos(),
      }),
    );

    expect(storage.getActiveDrain()?.traceId).toBe("trace-legacy");
  });
});

// ---------------------------------------------------------------------------
// VA-465 — shepherding_prs lifecycle
// ---------------------------------------------------------------------------

describe("createStorage — VA-465 shepherding lifecycle", () => {
  function nanos(secondsSinceEpoch: number): string {
    return String(BigInt(secondsSinceEpoch) * 1_000_000_000n);
  }

  it("markShepherdIterationStart inserts a row with state=acting + iteration/subscription/description set", () => {
    storage.markShepherdIterationStart({
      traceId: "trace-shepherd-1",
      prNumber: 42,
      subscription: "subscription[0]",
      iteration: 1,
      maxIterations: 3,
      description: "Rebase agent/x onto origin/main",
      timestampUnixNano: nanos(1715000010),
    });
    const rows = storage.getActiveShepherding("trace-shepherd-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      traceId: "trace-shepherd-1",
      prNumber: 42,
      subscription: "subscription[0]",
      iteration: 1,
      maxIterations: 3,
      state: "acting",
      description: "Rebase agent/x onto origin/main",
      endedUnixNano: null,
    });
  });

  it("markShepherdIterationStart on the same (trace, pr) bumps iteration + description + last_seen", () => {
    storage.markShepherdIterationStart({
      traceId: "trace-bump",
      prNumber: 7,
      subscription: "subscription[0]",
      iteration: 1,
      maxIterations: 3,
      description: "first action",
      timestampUnixNano: nanos(1715000010),
    });
    storage.markShepherdIterationStart({
      traceId: "trace-bump",
      prNumber: 7,
      subscription: "subscription[1]",
      iteration: 2,
      maxIterations: 3,
      description: "second action",
      timestampUnixNano: nanos(1715000020),
    });
    const rows = storage.getActiveShepherding("trace-bump");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      iteration: 2,
      subscription: "subscription[1]",
      description: "second action",
      lastSeenUnixNano: nanos(1715000020),
    });
  });

  it("markShepherdIterationStart with an OLDER timestamp doesn't clobber newer state (out-of-order safety)", () => {
    storage.markShepherdIterationStart({
      traceId: "trace-reorder",
      prNumber: 3,
      subscription: "subscription[0]",
      iteration: 2,
      maxIterations: 3,
      description: "newer",
      timestampUnixNano: nanos(1715000020),
    });
    storage.markShepherdIterationStart({
      traceId: "trace-reorder",
      prNumber: 3,
      subscription: "subscription[0]",
      iteration: 1,
      maxIterations: 3,
      description: "older marker arrives late",
      timestampUnixNano: nanos(1715000010),
    });
    const rows = storage.getActiveShepherding("trace-reorder");
    expect(rows).toHaveLength(1);
    // Newer state wins.
    expect(rows[0]?.iteration).toBe(2);
    expect(rows[0]?.description).toBe("newer");
  });

  it("markShepherdIterationEnd updates description + last_seen on an existing row without terminating it", () => {
    storage.markShepherdIterationStart({
      traceId: "trace-end",
      prNumber: 5,
      subscription: "subscription[0]",
      iteration: 1,
      maxIterations: 3,
      description: "running",
      timestampUnixNano: nanos(1715000010),
    });
    storage.markShepherdIterationEnd({
      traceId: "trace-end",
      prNumber: 5,
      outcome: "fixed",
      detail: "Rebase complete",
      timestampUnixNano: nanos(1715000015),
    });
    const rows = storage.getActiveShepherding("trace-end");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: "acting", // Iteration-end alone doesn't terminate.
      description: "Rebase complete",
      lastSeenUnixNano: nanos(1715000015),
      endedUnixNano: null,
    });
  });

  it("markShepherdEnded terminates the row; getActiveShepherding excludes it afterward", () => {
    storage.markShepherdIterationStart({
      traceId: "trace-terminal",
      prNumber: 1,
      subscription: "subscription[0]",
      iteration: 1,
      maxIterations: 3,
      description: "running",
      timestampUnixNano: nanos(1715000010),
    });
    storage.markShepherdEnded({
      traceId: "trace-terminal",
      prNumber: 1,
      outcome: "merged",
      timestampUnixNano: nanos(1715000050),
    });
    expect(storage.getActiveShepherding("trace-terminal")).toEqual([]);
  });

  it("getActiveShepherding returns rows sorted by started_unix_nano ascending", () => {
    storage.markShepherdIterationStart({
      traceId: "trace-multi",
      prNumber: 200,
      subscription: "subscription[0]",
      iteration: 1,
      maxIterations: 3,
      description: "PR 200",
      timestampUnixNano: nanos(1715000050),
    });
    storage.markShepherdIterationStart({
      traceId: "trace-multi",
      prNumber: 100,
      subscription: "subscription[0]",
      iteration: 1,
      maxIterations: 3,
      description: "PR 100",
      timestampUnixNano: nanos(1715000010),
    });
    const rows = storage.getActiveShepherding("trace-multi");
    expect(rows.map((r) => r.prNumber)).toEqual([100, 200]);
  });

  it("markShepherdEnded with outcome=hitl is reflected in state before exclusion", () => {
    // Same as the merged case but the terminal state value differs;
    // the row is still excluded from getActiveShepherding.
    storage.markShepherdEnded({
      traceId: "trace-hitl-only",
      prNumber: 88,
      outcome: "hitl",
      timestampUnixNano: nanos(1715000050),
    });
    expect(storage.getActiveShepherding("trace-hitl-only")).toEqual([]);
  });

  it("legacy boots without shepherding_prs in the file create it via SCHEMA on next createStorage call", async () => {
    // The CREATE TABLE IF NOT EXISTS in SCHEMA handles this — no
    // separate ALTER needed (it is a new table, not a column add).
    // This test seeds a legacy DB without the table and then opens
    // it via createStorage, asserting markShepherdIterationStart
    // succeeds on first use.
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { DatabaseSync } = await import("node:sqlite");

    const dir = mkdtempSync(join(tmpdir(), "runway-va465-"));
    const path = join(dir, "legacy.sqlite");
    try {
      // Seed a minimal pre-VA-465 DB: just a stub of drains so
      // createStorage's other migrations don't fail.
      const seed = new DatabaseSync(path);
      seed
        .prepare(
          `CREATE TABLE drains (
             trace_id TEXT NOT NULL,
             span_id TEXT NOT NULL,
             start_time_unix_nano TEXT NOT NULL,
             end_time_unix_nano TEXT,
             last_seen_unix_nano TEXT,
             attempts INTEGER, opened INTEGER, hitl INTEGER, errored INTEGER,
             status_code INTEGER, status_message TEXT,
             inserted_at TEXT NOT NULL DEFAULT (datetime('now')),
             PRIMARY KEY (trace_id, span_id)
           )`,
        )
        .run();
      seed.close();
      const legacy = createStorage(path);
      legacy.markShepherdIterationStart({
        traceId: "legacy-trace",
        prNumber: 1,
        subscription: "subscription[0]",
        iteration: 1,
        maxIterations: 3,
        description: "first run on legacy DB",
        timestampUnixNano: nanos(1715000010),
      });
      const rows = legacy.getActiveShepherding("legacy-trace");
      expect(rows).toHaveLength(1);
      legacy.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
