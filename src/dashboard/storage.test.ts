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
