import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentIterationRow,
  DrainRow,
  IssueProcessRow,
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
    branch: "agent/va-312",
    outcomeKind: "opened",
    outcomeDetail: "https://github.com/x/y/pull/42",
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
