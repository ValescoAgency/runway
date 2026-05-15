import { describe, expect, it } from "vitest";
import type {
  OtlpLogRecord,
  OtlpLogsPayload,
  OtlpSpan,
  OtlpTracesPayload,
} from "./otlp.js";
import { projectLogs, projectPayload } from "./projector.js";

// VA-386: projector is the pure boundary between OTLP wire format and
// the typed runway rows the dashboard renders. Hand-built fixtures
// match the prompts.test.ts / orchestrator.test.ts style — no mocking
// framework, no live HTTP. Each test owns its minimal span tree.

function span(overrides: Partial<OtlpSpan> & Pick<OtlpSpan, "name">): OtlpSpan {
  return {
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: "0123456789abcdef",
    startTimeUnixNano: "1715000000000000000",
    endTimeUnixNano: "1715000001000000000",
    ...overrides,
  };
}

function payload(spans: readonly OtlpSpan[]): OtlpTracesPayload {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "runway" } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "@effect/opentelemetry" },
            spans,
          },
        ],
      },
    ],
  };
}

describe("projectPayload — drainQueue", () => {
  it("projects a drainQueue span into a typed drain row with counter attributes", () => {
    const out = projectPayload(
      payload([
        span({
          name: "drainQueue",
          traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          spanId: "1111111111111111",
          attributes: [
            { key: "runway.drain.attempts", value: { intValue: "3" } },
            { key: "runway.drain.opened", value: { intValue: "1" } },
            { key: "runway.drain.hitl", value: { intValue: "1" } },
            { key: "runway.drain.errored", value: { intValue: "1" } },
          ],
        }),
      ]),
    );

    expect(out.drains).toHaveLength(1);
    expect(out.drains[0]).toMatchObject({
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      spanId: "1111111111111111",
      attempts: 3,
      opened: 1,
      hitl: 1,
      errored: 1,
    });
  });

  it("leaves drain counters null when the span has no counter attributes", () => {
    const out = projectPayload(payload([span({ name: "drainQueue" })]));
    expect(out.drains).toHaveLength(1);
    expect(out.drains[0]).toMatchObject({
      attempts: null,
      opened: null,
      hitl: null,
      errored: null,
    });
  });

  it("accepts intValue as either a JSON string or a JS number (OTel SDK emits both shapes)", () => {
    const out = projectPayload(
      payload([
        span({
          name: "drainQueue",
          attributes: [
            { key: "runway.drain.attempts", value: { intValue: 5 } },
            { key: "runway.drain.opened", value: { intValue: "2" } },
          ],
        }),
      ]),
    );
    expect(out.drains[0]?.attempts).toBe(5);
    expect(out.drains[0]?.opened).toBe(2);
  });
});

describe("projectPayload — processIssue", () => {
  it("projects a processIssue span keyed on runway.issue.identifier", () => {
    const out = projectPayload(
      payload([
        span({
          name: "processIssue",
          parentSpanId: "1111111111111111",
          attributes: [
            { key: "runway.issue.identifier", value: { stringValue: "VA-312" } },
            { key: "runway.issue.id", value: { stringValue: "issue-abc" } },
            { key: "runway.branch", value: { stringValue: "agent/va-312" } },
            { key: "runway.outcome.kind", value: { stringValue: "opened" } },
            {
              key: "runway.outcome.detail",
              value: { stringValue: "https://github.com/x/y/pull/42" },
            },
          ],
        }),
      ]),
    );

    expect(out.issueProcesses).toHaveLength(1);
    expect(out.issueProcesses[0]).toMatchObject({
      parentSpanId: "1111111111111111",
      issueIdentifier: "VA-312",
      issueId: "issue-abc",
      branch: "agent/va-312",
      outcomeKind: "opened",
      outcomeDetail: "https://github.com/x/y/pull/42",
    });
  });

  it("drops a processIssue span with no runway.issue.identifier from the typed table (still kept in raw_spans)", () => {
    const out = projectPayload(
      payload([span({ name: "processIssue", spanId: "2222222222222222" })]),
    );
    expect(out.issueProcesses).toHaveLength(0);
    expect(out.rawSpans).toHaveLength(1);
    expect(out.rawSpans[0]?.spanId).toBe("2222222222222222");
  });

  it("leaves outcome fields null when the span lacks outcome attributes (in-flight or pre-VA-386 emitters)", () => {
    const out = projectPayload(
      payload([
        span({
          name: "processIssue",
          attributes: [
            { key: "runway.issue.identifier", value: { stringValue: "VA-1" } },
          ],
        }),
      ]),
    );
    expect(out.issueProcesses[0]?.outcomeKind).toBeNull();
    expect(out.issueProcesses[0]?.outcomeDetail).toBeNull();
  });

  // VA-387: span-enrichment attributes (issue title, labels, PR url,
  // HITL reason) attach onto the same processIssue span. Each projects
  // into its own typed column so the detail pane can render without
  // re-parsing `runway.outcome.detail`.
  it("projects runway.issue.title, runway.issue.labels, runway.pr.url, and runway.hitl.reason (VA-387)", () => {
    const out = projectPayload(
      payload([
        span({
          name: "processIssue",
          attributes: [
            { key: "runway.issue.identifier", value: { stringValue: "VA-387" } },
            { key: "runway.issue.title", value: { stringValue: "Slice 2 build" } },
            {
              key: "runway.issue.labels",
              value: {
                arrayValue: {
                  values: [
                    { stringValue: "feature" },
                    { stringValue: "dashboard" },
                  ],
                },
              },
            },
            {
              key: "runway.outcome.kind",
              value: { stringValue: "opened" },
            },
            {
              key: "runway.pr.url",
              value: { stringValue: "https://github.com/x/y/pull/99" },
            },
          ],
        }),
      ]),
    );

    expect(out.issueProcesses).toHaveLength(1);
    expect(out.issueProcesses[0]).toMatchObject({
      issueIdentifier: "VA-387",
      issueTitle: "Slice 2 build",
      issueLabels: ["feature", "dashboard"],
      prUrl: "https://github.com/x/y/pull/99",
      hitlReason: null,
    });
  });

  it("projects runway.hitl.reason when the run flagged for human review (VA-387)", () => {
    const out = projectPayload(
      payload([
        span({
          name: "processIssue",
          attributes: [
            { key: "runway.issue.identifier", value: { stringValue: "VA-1" } },
            { key: "runway.outcome.kind", value: { stringValue: "hitl" } },
            {
              key: "runway.hitl.reason",
              value: { stringValue: "Needs schema decision" },
            },
          ],
        }),
      ]),
    );
    expect(out.issueProcesses[0]?.hitlReason).toBe("Needs schema decision");
    expect(out.issueProcesses[0]?.prUrl).toBeNull();
  });

  it("leaves VA-387 enrichment fields null/empty when the span has no enrichment attributes", () => {
    const out = projectPayload(
      payload([
        span({
          name: "processIssue",
          attributes: [
            { key: "runway.issue.identifier", value: { stringValue: "VA-1" } },
          ],
        }),
      ]),
    );
    expect(out.issueProcesses[0]?.issueTitle).toBeNull();
    expect(out.issueProcesses[0]?.issueLabels).toEqual([]);
    expect(out.issueProcesses[0]?.prUrl).toBeNull();
    expect(out.issueProcesses[0]?.hitlReason).toBeNull();
  });

  it("preserves the OTLP status code/message when the span carries one", () => {
    const out = projectPayload(
      payload([
        span({
          name: "processIssue",
          attributes: [
            { key: "runway.issue.identifier", value: { stringValue: "VA-1" } },
          ],
          status: { code: 2, message: "boom" },
        }),
      ]),
    );
    expect(out.issueProcesses[0]?.statusCode).toBe(2);
    expect(out.issueProcesses[0]?.statusMessage).toBe("boom");
  });
});

describe("projectPayload — raw_spans escape hatch", () => {
  it("captures every span (typed or not) in raw_spans with the original JSON payload", () => {
    const drain = span({
      name: "drainQueue",
      spanId: "1111111111111111",
    });
    const proc = span({
      name: "processIssue",
      spanId: "2222222222222222",
      attributes: [
        { key: "runway.issue.identifier", value: { stringValue: "VA-1" } },
      ],
    });
    const unknown = span({
      name: "fetchReady",
      spanId: "3333333333333333",
    });

    const out = projectPayload(payload([drain, proc, unknown]));

    expect(out.rawSpans).toHaveLength(3);
    const names = out.rawSpans.map((r) => r.name).sort();
    expect(names).toEqual(["drainQueue", "fetchReady", "processIssue"]);

    // Payload column is the verbatim JSON of the span — including
    // attributes we don't project. Round-trips cleanly.
    const drainRaw = out.rawSpans.find((r) => r.name === "drainQueue")!;
    expect(JSON.parse(drainRaw.payload)).toMatchObject({
      name: "drainQueue",
      spanId: "1111111111111111",
    });
  });
});

describe("projectPayload — multiple resource/scope spans", () => {
  it("flattens spans across resourceSpans / scopeSpans into the same projection", () => {
    const out = projectPayload({
      resourceSpans: [
        {
          scopeSpans: [
            { spans: [span({ name: "drainQueue", spanId: "1111111111111111" })] },
            {
              spans: [
                span({
                  name: "processIssue",
                  spanId: "2222222222222222",
                  attributes: [
                    {
                      key: "runway.issue.identifier",
                      value: { stringValue: "VA-1" },
                    },
                  ],
                }),
              ],
            },
          ],
        },
        {
          scopeSpans: [
            {
              spans: [
                span({
                  name: "processIssue",
                  spanId: "3333333333333333",
                  attributes: [
                    {
                      key: "runway.issue.identifier",
                      value: { stringValue: "VA-2" },
                    },
                  ],
                }),
              ],
            },
          ],
        },
      ],
    });

    expect(out.drains).toHaveLength(1);
    expect(out.issueProcesses.map((p) => p.issueIdentifier).sort()).toEqual([
      "VA-1",
      "VA-2",
    ]);
    expect(out.rawSpans).toHaveLength(3);
  });

  it("returns empty projections for an empty payload (smoke)", () => {
    const out = projectPayload({ resourceSpans: [] });
    expect(out).toEqual({
      drains: [],
      issueProcesses: [],
      agentIterations: [],
      rawSpans: [],
    });
  });
});

// VA-389: agent iterations are children of a processIssue span. The
// projector keys them on the parent_span_id so the detail pane can
// fetch them by issue process.
describe("projectPayload — impl-iter-N (VA-389)", () => {
  it("projects a single impl-iter-N span into an agent_iterations row", () => {
    const out = projectPayload(
      payload([
        span({
          name: "impl-iter-1",
          spanId: "aaaa000000000001",
          parentSpanId: "1111111111111111",
          startTimeUnixNano: "1715000000000000000",
          endTimeUnixNano: "1715000010000000000",
          attributes: [
            { key: "runway.iteration", value: { intValue: "1" } },
            { key: "runway.iteration.max", value: { intValue: "5" } },
            {
              key: "runway.iteration.exit_status",
              value: { stringValue: "done" },
            },
            {
              key: "runway.iteration.sandcastle_run_id",
              value: { stringValue: "impl-VA-1-iter-1" },
            },
          ],
        }),
      ]),
    );

    expect(out.agentIterations).toHaveLength(1);
    expect(out.agentIterations[0]).toMatchObject({
      spanId: "aaaa000000000001",
      issueProcessSpanId: "1111111111111111",
      iterationIndex: 1,
      startTimeUnixNano: "1715000000000000000",
      endTimeUnixNano: "1715000010000000000",
      sandcastleRunId: "impl-VA-1-iter-1",
      exitStatus: "done",
    });
  });

  it("extracts a multi-iteration hitl loop (e.g. iter 1 continue → iter 2 blocked)", () => {
    const out = projectPayload(
      payload([
        span({
          name: "processIssue",
          spanId: "1111111111111111",
          attributes: [
            { key: "runway.issue.identifier", value: { stringValue: "VA-9" } },
            { key: "runway.outcome.kind", value: { stringValue: "hitl" } },
          ],
        }),
        span({
          name: "impl-iter-1",
          spanId: "aaaa000000000001",
          parentSpanId: "1111111111111111",
          startTimeUnixNano: "1715000000000000000",
          endTimeUnixNano: "1715000010000000000",
          attributes: [
            {
              key: "runway.iteration.exit_status",
              value: { stringValue: "continue" },
            },
            {
              key: "runway.iteration.sandcastle_run_id",
              value: { stringValue: "impl-VA-9-iter-1" },
            },
          ],
        }),
        span({
          name: "impl-iter-2",
          spanId: "aaaa000000000002",
          parentSpanId: "1111111111111111",
          startTimeUnixNano: "1715000010000000000",
          endTimeUnixNano: "1715000025000000000",
          attributes: [
            {
              key: "runway.iteration.exit_status",
              value: { stringValue: "blocked" },
            },
            {
              key: "runway.iteration.sandcastle_run_id",
              value: { stringValue: "impl-VA-9-iter-2" },
            },
          ],
        }),
      ]),
    );

    expect(out.issueProcesses).toHaveLength(1);
    expect(out.agentIterations).toHaveLength(2);
    expect(out.agentIterations.map((r) => r.iterationIndex)).toEqual([1, 2]);
    expect(out.agentIterations.map((r) => r.exitStatus)).toEqual([
      "continue",
      "blocked",
    ]);
    // Every iteration links back to the same processIssue span_id so
    // the detail pane can fetch them by issue_process_id.
    expect(
      new Set(out.agentIterations.map((r) => r.issueProcessSpanId)),
    ).toEqual(new Set(["1111111111111111"]));
  });

  it("leaves exit_status and sandcastle_run_id null when the iteration span has no attribute set (in-flight)", () => {
    const out = projectPayload(
      payload([
        span({
          name: "impl-iter-1",
          parentSpanId: "1111111111111111",
        }),
      ]),
    );
    expect(out.agentIterations).toHaveLength(1);
    expect(out.agentIterations[0]?.exitStatus).toBeNull();
    expect(out.agentIterations[0]?.sandcastleRunId).toBeNull();
  });

  it("does not match span names that merely contain 'impl-iter-' (anchored regex)", () => {
    const out = projectPayload(
      payload([
        span({ name: "pre-impl-iter-1" }),
        span({ name: "impl-iter-X" }),
        span({ name: "impl-iter" }),
      ]),
    );
    expect(out.agentIterations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// VA-388 — projectLogs
// ---------------------------------------------------------------------------

function logRecord(over: Partial<OtlpLogRecord> = {}): OtlpLogRecord {
  return {
    timeUnixNano: "1715000000500000000",
    severityText: "INFO",
    body: { stringValue: "agent picked up issue" },
    attributes: [
      { key: "issue", value: { stringValue: "VA-388" } },
      { key: "branch", value: { stringValue: "agent/va-388" } },
    ],
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: "0123456789abcdef",
    ...over,
  };
}

function logsPayload(records: readonly OtlpLogRecord[]): OtlpLogsPayload {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "runway" } },
          ],
        },
        scopeLogs: [
          {
            scope: { name: "@effect/opentelemetry" },
            logRecords: records,
          },
        ],
      },
    ],
  };
}

describe("projectLogs — VA-388", () => {
  it("projects a log record into the typed row shape with attributes flattened to strings", () => {
    const rows = projectLogs(logsPayload([logRecord()]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
      timestampUnixNano: "1715000000500000000",
      level: "INFO",
      message: "agent picked up issue",
      attributes: { issue: "VA-388", branch: "agent/va-388" },
    });
  });

  it("falls back to observedTimeUnixNano when timeUnixNano is missing", () => {
    const rows = projectLogs(
      logsPayload([
        {
          ...logRecord(),
          timeUnixNano: undefined,
          observedTimeUnixNano: "1715000000600000000",
        },
      ]),
    );
    expect(rows[0]?.timestampUnixNano).toBe("1715000000600000000");
  });

  it("drops records without a trace_id — stray library logs have nowhere to land on the dashboard", () => {
    const rows = projectLogs(
      logsPayload([
        { ...logRecord(), traceId: undefined },
        { ...logRecord(), traceId: "" },
        logRecord(),
      ]),
    );
    expect(rows).toHaveLength(1);
  });

  it("drops records without any timestamp (we won't fabricate one)", () => {
    const rows = projectLogs(
      logsPayload([
        {
          ...logRecord(),
          timeUnixNano: undefined,
          observedTimeUnixNano: undefined,
        },
      ]),
    );
    expect(rows).toEqual([]);
  });

  it("maps severityNumber to a coarse label when severityText is absent", () => {
    const probe = (n: number): string =>
      projectLogs(
        logsPayload([
          { ...logRecord(), severityText: undefined, severityNumber: n },
        ]),
      )[0]?.level ?? "";

    expect(probe(5)).toBe("DEBUG");
    expect(probe(9)).toBe("INFO");
    expect(probe(13)).toBe("WARN");
    expect(probe(17)).toBe("ERROR");
    expect(probe(21)).toBe("FATAL");
    expect(probe(0)).toBe("UNSET");
  });

  it("upper-cases the severityText when present (defends against lower-case 'info' from custom loggers)", () => {
    const rows = projectLogs(
      logsPayload([{ ...logRecord(), severityText: "info" }]),
    );
    expect(rows[0]?.level).toBe("INFO");
  });

  it("flattens an array-valued attribute into a comma-joined string", () => {
    const rows = projectLogs(
      logsPayload([
        {
          ...logRecord(),
          attributes: [
            {
              key: "issue.labels",
              value: {
                arrayValue: {
                  values: [
                    { stringValue: "bug" },
                    { stringValue: "backend" },
                  ],
                },
              },
            },
          ],
        },
      ]),
    );
    expect(rows[0]?.attributes).toEqual({ "issue.labels": "bug, backend" });
  });

  it("collects records across multiple resource / scope groups", () => {
    const rows = projectLogs({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [logRecord({ body: { stringValue: "first" } })],
            },
            {
              logRecords: [logRecord({ body: { stringValue: "second" } })],
            },
          ],
        },
        {
          scopeLogs: [
            {
              logRecords: [logRecord({ body: { stringValue: "third" } })],
            },
          ],
        },
      ],
    });
    expect(rows.map((r) => r.message)).toEqual(["first", "second", "third"]);
  });
});
