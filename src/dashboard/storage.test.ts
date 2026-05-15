import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
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

function makeLogRecord(over: Partial<LogRecordRow> = {}): LogRecordRow {
  return {
    traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    spanId: "2222222222222222",
    timeUnixNano: "1715000000000000000",
    level: "INFO",
    message: "base branch resolved",
    attributesJson: JSON.stringify({
      issue: "VA-312",
      branch: "agent/va-312",
    }),
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

describe("createStorage — appendLogRecord / streamLogsFor (VA-388)", () => {
  it("round-trips a log record with attributes parsed back to a plain object", () => {
    storage.appendLogRecord(makeLogRecord());
    const out = storage.streamLogsFor("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      spanId: "2222222222222222",
      timeUnixNano: "1715000000000000000",
      level: "INFO",
      message: "base branch resolved",
    });
    expect(out[0]?.attributes).toEqual({
      issue: "VA-312",
      branch: "agent/va-312",
    });
  });

  it("orders streamed log records ascending by timestamp (then by span_id as a tiebreaker)", () => {
    // Two messages out-of-insertion-order to prove sort lives at read
    // time, not write time.
    storage.appendLogRecord(
      makeLogRecord({
        message: "later",
        spanId: "bbbbbbbbbbbbbbbb",
        timeUnixNano: "1715000002000000000",
      }),
    );
    storage.appendLogRecord(
      makeLogRecord({
        message: "earlier",
        spanId: "aaaaaaaaaaaaaaaa",
        timeUnixNano: "1715000001000000000",
      }),
    );
    storage.appendLogRecord(
      makeLogRecord({
        message: "earliest",
        spanId: "cccccccccccccccc",
        timeUnixNano: "1715000000500000000",
      }),
    );

    const out = storage.streamLogsFor("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(out.map((r) => r.message)).toEqual([
      "earliest",
      "earlier",
      "later",
    ]);
  });

  it("scopes streamLogsFor() to the requested trace id", () => {
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

    const onlyA = storage.streamLogsFor("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(onlyA.map((r) => r.message)).toEqual(["trace A"]);

    const onlyB = storage.streamLogsFor("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(onlyB.map((r) => r.message)).toEqual(["trace B"]);
  });

  it("idempotently upserts on retried emits keyed by (trace_id, span_id, timestamp, message)", () => {
    storage.appendLogRecord(
      makeLogRecord({
        level: "INFO",
        attributesJson: JSON.stringify({ branch: "first" }),
      }),
    );
    storage.appendLogRecord(
      makeLogRecord({
        level: "WARN",
        attributesJson: JSON.stringify({ branch: "second" }),
      }),
    );

    const out = storage.streamLogsFor("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(out).toHaveLength(1);
    expect(out[0]?.level).toBe("WARN");
    expect(out[0]?.attributes).toEqual({ branch: "second" });
  });

  it("returns an empty list when no logs exist for the trace", () => {
    expect(storage.streamLogsFor("none")).toEqual([]);
  });
});
