import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createStorage,
  type Storage,
} from "../dashboard/storage.js";
import {
  categoryFromIssueIdentifier,
  createMetaDashboardRead,
  type MetaDashboardRead,
} from "./dashboard-read.js";

// VA-405: integration test for the IRA's `loadNorms` gateway against
// a real (in-memory) SQLite event store. Mirrors the seeding helpers
// from `src/dashboard/storage.test.ts` — the fixtures stay
// single-digit so a future reader can verify each expected value by
// mental arithmetic (the same property the VA-399 view tests preserve).
//
// We exercise `loadNorms` directly rather than going through the
// dashboard's `evaluator_aggregates_v1` view; the IRA's gateway
// computes its own aggregates against the raw tables (so it can pick
// its own window without racing the dashboard's view configuration).
// Drift between the two would be a real bug — but the IRA's window
// argument is supposed to be authoritative for its own queries.

let storage: Storage;
let gateway: MetaDashboardRead;
const DB_PATH = ":memory:";

// Both `Storage` and `MetaDashboardRead` open their own
// `DatabaseSync` handles. `:memory:` is per-connection so the two
// handles wouldn't see each other's writes — use a shared temp file
// per test instead. The afterEach unlink keeps the disk clean.
function freshDbPath(): string {
  const name = `runway-meta-dashboard-read-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.sqlite`;
  return join(tmpdir(), name);
}

let dbPath: string;

beforeEach(() => {
  dbPath = freshDbPath();
  storage = createStorage(dbPath);
  gateway = createMetaDashboardRead(dbPath);
});

afterEach(() => {
  storage.close();
  // No public close() on the gateway — the DatabaseSync handle is
  // garbage-collected with the gateway reference. Drop the file too.
  try {
    unlinkSync(dbPath);
  } catch {
    /* already gone */
  }
});

function seedDrain(traceId: string, startNano: string): void {
  storage.saveDrain({
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

function seedProcess(args: {
  traceId: string;
  spanId: string;
  identifier: string;
  outcomeKind: string | null;
  outcomeDetail?: string | null;
  wallMs: number;
  iterations: number;
}): void {
  const startNano = "1000000000000000000";
  const endNano = (
    BigInt(startNano) + BigInt(args.wallMs) * 1_000_000n
  ).toString();
  storage.saveIssueProcess({
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
    issueTitle: null,
    issueLabels: [],
    prUrl: null,
    hitlReason: null,
  });
  for (let i = 1; i <= args.iterations; i += 1) {
    storage.saveAgentIteration({
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

describe("categoryFromIssueIdentifier (VA-405)", () => {
  it("returns the prefix before the first dash", () => {
    expect(categoryFromIssueIdentifier("VA-401")).toBe("VA");
    expect(categoryFromIssueIdentifier("ENG-123")).toBe("ENG");
  });

  it("returns the full identifier when no dash is present", () => {
    expect(categoryFromIssueIdentifier("OPS")).toBe("OPS");
  });

  it("treats a leading dash as no-prefix and keeps the full string", () => {
    // `instr` returns 1 for a leading dash; the SQL CASE clause
    // returns the full string (instr > 0 but substr(_, 1, 0) = '').
    // We mirror "no useful prefix" semantics by returning the full id.
    expect(categoryFromIssueIdentifier("-leading-dash")).toBe(
      "-leading-dash",
    );
  });
});

describe("MetaDashboardRead.loadNorms (VA-405)", () => {
  it("computes hand-verifiable medians, p95s, and rates for one category", async () => {
    // Single drain — every process is in the rolling window.
    // Fixtures mirror storage.test.ts (the VA-399 view tests) so
    // hand-computed expectations are the same.
    const trace = "ffffffffffffffffffffffffffffffff";
    seedDrain(trace, "1000000000000000000");

    // Category VA: 5 processes. Wall times {1000, 2000, 3000, 4000, 5000} ms.
    // Iteration counts {1, 2, 3, 4, 5}. Outcomes: 3 opened, 2 hitl
    // (one of which is the reviewer-rejection variant).
    //   median wall_ms = 3000
    //   p95 wall_ms     = 5000 (nearest-rank: ceil(5*0.95) → 5th value)
    //   median iter_ct  = 3
    //   p95 iter_ct     = 5
    //   reviewer_rejection_rate = 1/5 = 0.2
    //   revert_rate             = 0
    //   hitl_escape_rate        = 2/5 = 0.4
    //   infra_error_rate        = 0
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
      seedProcess({
        traceId: trace,
        spanId: `vavavavavavava${i.toString().padStart(2, "0")}`,
        identifier: `VA-${100 + i}`,
        outcomeKind: c.outcome,
        outcomeDetail: c.detail,
        wallMs: c.wallMs,
        iterations: c.iter,
      });
    });

    const norms = await Effect.runPromise(gateway.loadNorms("VA", 30));
    expect(norms).not.toBeNull();
    if (norms === null) return;
    expect(norms).toMatchObject({
      category: "VA",
      windowDrains: 30,
      sampleSize: 5,
      medianIterationCount: 3,
      p95IterationCount: 5,
      medianWallTimeMs: 3000,
      p95WallTimeMs: 5000,
      reviewerRejectionRate: 0.2,
      revertRate: 0,
      hitlEscapeRate: 0.4,
      infraErrorRate: 0,
    });
  });

  it("returns null when the category has no rows in the window", async () => {
    const trace = "11111111111111111111111111111111";
    seedDrain(trace, "1000000000000000000");
    seedProcess({
      traceId: trace,
      spanId: "engengengeng0001",
      identifier: "ENG-100",
      outcomeKind: "opened",
      wallMs: 1000,
      iterations: 1,
    });

    // No `VA-*` rows in the window → category VA has sample_size 0.
    const norms = await Effect.runPromise(gateway.loadNorms("VA", 30));
    expect(norms).toBeNull();
  });

  it("echoes the caller's requested window in CapturedNorms.windowDrains for prompt traceability", async () => {
    // The view's actual N is owned by the dashboard process
    // (`DASHBOARD_AGGREGATE_WINDOW`, default 30); see
    // `read-model.md`. `loadNorms`' window parameter is recorded in
    // the projected `CapturedNorms` so the IRA's user prompt can say
    // "vs last 7 drains" even when the underlying numbers reflect
    // the dashboard's setting.
    const trace = "33333333333333333333333333333333";
    seedDrain(trace, "1000000000000000000");
    seedProcess({
      traceId: trace,
      spanId: "vavavavavavava01",
      identifier: "VA-1",
      outcomeKind: "opened",
      wallMs: 100,
      iterations: 1,
    });

    const norms = await Effect.runPromise(gateway.loadNorms("VA", 7));
    expect(norms).not.toBeNull();
    if (norms === null) return;
    expect(norms.windowDrains).toBe(7);

    // Out-of-band / nonsense window values floor to 1 so the prompt
    // doesn't advertise `-3` or `NaN`.
    const coerced = await Effect.runPromise(gateway.loadNorms("VA", -3));
    expect(coerced?.windowDrains).toBe(1);
  });

  it("returns null when the event store has no drains yet", async () => {
    const norms = await Effect.runPromise(gateway.loadNorms("VA", 30));
    expect(norms).toBeNull();
  });

  it("isolates categories — VA norms don't see ENG rows", async () => {
    const trace = "44444444444444444444444444444444";
    seedDrain(trace, "1000000000000000000");
    seedProcess({
      traceId: trace,
      spanId: "vavavavavavava01",
      identifier: "VA-1",
      outcomeKind: "opened",
      wallMs: 100,
      iterations: 1,
    });
    seedProcess({
      traceId: trace,
      spanId: "engengengeng0001",
      identifier: "ENG-1",
      outcomeKind: "errored",
      wallMs: 99_999,
      iterations: 50,
    });

    const va = await Effect.runPromise(gateway.loadNorms("VA", 30));
    expect(va).not.toBeNull();
    if (va === null) return;
    expect(va.sampleSize).toBe(1);
    expect(va.medianWallTimeMs).toBe(100);
    expect(va.infraErrorRate).toBe(0);

    const eng = await Effect.runPromise(gateway.loadNorms("ENG", 30));
    expect(eng).not.toBeNull();
    if (eng === null) return;
    expect(eng.sampleSize).toBe(1);
    expect(eng.infraErrorRate).toBe(1);
  });
});
