import { describe, expect, it } from "vitest";
import type {
  OtlpLogRecord,
  OtlpLogsPayload,
  OtlpSpan,
  OtlpTracesPayload,
} from "./otlp.js";
import {
  DRAIN_STARTED_LOG,
  extractActiveDrainMarkers,
  extractPlannerMarkers,
  extractShepherdMarkers,
  PLANNER_ACTION_COMPLETED_LOG,
  PLANNER_ACTION_FAILED_LOG,
  PLANNER_ACTION_STARTED_LOG,
  PLANNER_RECOMMENDATION_ACCEPTED_LOG,
  PLANNER_RECOMMENDATION_PROPOSED_LOG,
  PLANNER_RECOMMENDATION_REJECTED_LOG,
  type PlannerRecommendationProposedLogMarker,
  projectLogs,
  projectPayload,
  SHEPHERD_ENDED_LOG,
  SHEPHERD_ITERATION_END_LOG,
  SHEPHERD_ITERATION_START_LOG,
} from "./projector.js";

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

// ---------------------------------------------------------------------------
// VA-455 — extractActiveDrainMarkers
// ---------------------------------------------------------------------------

describe("extractActiveDrainMarkers — VA-455", () => {
  it("recognises a drain.started body and projects the marker fields", () => {
    const markers = extractActiveDrainMarkers(
      logsPayload([
        logRecord({
          body: { stringValue: DRAIN_STARTED_LOG },
          traceId: "trace-abc",
          spanId: "drain-span-1",
          timeUnixNano: "1715000000100000000",
        }),
      ]),
    );
    expect(markers).toEqual([
      {
        traceId: "trace-abc",
        spanId: "drain-span-1",
        startTimeUnixNano: "1715000000100000000",
        lastSeenUnixNano: "1715000000100000000",
      },
    ]);
  });

  it("ignores log records whose body isn't drain.started", () => {
    const markers = extractActiveDrainMarkers(
      logsPayload([
        logRecord({ body: { stringValue: "drain.heartbeat" } }),
        logRecord({ body: { stringValue: "base branch resolved" } }),
        logRecord({ body: { stringValue: "agent picked up issue" } }),
      ]),
    );
    expect(markers).toHaveLength(0);
  });

  it("falls back to observedTimeUnixNano when timeUnixNano is absent", () => {
    const markers = extractActiveDrainMarkers(
      logsPayload([
        logRecord({
          body: { stringValue: DRAIN_STARTED_LOG },
          timeUnixNano: undefined,
          observedTimeUnixNano: "1715000000200000000",
        }),
      ]),
    );
    expect(markers[0]?.startTimeUnixNano).toBe("1715000000200000000");
    expect(markers[0]?.lastSeenUnixNano).toBe("1715000000200000000");
  });

  it("drops markers missing trace_id, span_id, or timestamp", () => {
    const markers = extractActiveDrainMarkers(
      logsPayload([
        logRecord({
          body: { stringValue: DRAIN_STARTED_LOG },
          traceId: undefined,
        }),
        logRecord({
          body: { stringValue: DRAIN_STARTED_LOG },
          spanId: undefined,
        }),
        logRecord({
          body: { stringValue: DRAIN_STARTED_LOG },
          timeUnixNano: undefined,
          observedTimeUnixNano: undefined,
        }),
      ]),
    );
    expect(markers).toHaveLength(0);
  });

  it("collects markers across multiple resource / scope groups", () => {
    const markers = extractActiveDrainMarkers({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                logRecord({
                  body: { stringValue: DRAIN_STARTED_LOG },
                  traceId: "trace-1",
                  spanId: "drain-span-1",
                }),
              ],
            },
          ],
        },
        {
          scopeLogs: [
            {
              logRecords: [
                logRecord({
                  body: { stringValue: DRAIN_STARTED_LOG },
                  traceId: "trace-2",
                  spanId: "drain-span-2",
                }),
              ],
            },
          ],
        },
      ],
    });
    expect(markers.map((m) => m.traceId)).toEqual(["trace-1", "trace-2"]);
  });
});

// ---------------------------------------------------------------------------
// VA-465 — extractShepherdMarkers
// ---------------------------------------------------------------------------

describe("extractShepherdMarkers — VA-465", () => {
  it("recognises shepherd.iteration.start and projects the marker fields from attributes", () => {
    const markers = extractShepherdMarkers(
      logsPayload([
        logRecord({
          body: { stringValue: SHEPHERD_ITERATION_START_LOG },
          attributes: [
            { key: "pr", value: { stringValue: "142" } },
            { key: "subscription", value: { stringValue: "subscription[0]" } },
            { key: "iteration", value: { stringValue: "2" } },
            { key: "maxIterations", value: { stringValue: "3" } },
            { key: "description", value: { stringValue: "Rebase agent/x onto origin/main" } },
          ],
          traceId: "trace-shep",
          timeUnixNano: "1715000010000000000",
        }),
      ]),
    );
    expect(markers).toEqual([
      {
        kind: "iteration.start",
        traceId: "trace-shep",
        prNumber: 142,
        subscription: "subscription[0]",
        iteration: 2,
        maxIterations: 3,
        description: "Rebase agent/x onto origin/main",
        timestampUnixNano: "1715000010000000000",
      },
    ]);
  });

  it("recognises shepherd.iteration.end with outcome attribute", () => {
    const markers = extractShepherdMarkers(
      logsPayload([
        logRecord({
          body: { stringValue: SHEPHERD_ITERATION_END_LOG },
          attributes: [
            { key: "pr", value: { stringValue: "5" } },
            { key: "outcome", value: { stringValue: "fixed" } },
            { key: "detail", value: { stringValue: "Rebase complete" } },
          ],
          traceId: "trace-end",
          timeUnixNano: "1715000020000000000",
        }),
      ]),
    );
    expect(markers).toEqual([
      {
        kind: "iteration.end",
        traceId: "trace-end",
        prNumber: 5,
        outcome: "fixed",
        detail: "Rebase complete",
        timestampUnixNano: "1715000020000000000",
      },
    ]);
  });

  it("recognises shepherd.ended with outcome=merged|ready|hitl", () => {
    for (const out of ["merged", "ready", "hitl"] as const) {
      const markers = extractShepherdMarkers(
        logsPayload([
          logRecord({
            body: { stringValue: SHEPHERD_ENDED_LOG },
            attributes: [
              { key: "pr", value: { stringValue: "1" } },
              { key: "outcome", value: { stringValue: out } },
            ],
            traceId: "trace-z",
            timeUnixNano: "1715000050000000000",
          }),
        ]),
      );
      expect(markers).toHaveLength(1);
      expect(markers[0]).toMatchObject({ kind: "ended", outcome: out });
    }
  });

  it("drops markers with non-shepherd body, missing trace_id, missing pr attribute, or missing timestamp", () => {
    const markers = extractShepherdMarkers(
      logsPayload([
        logRecord({ body: { stringValue: "shepherd.start" } }), // unknown body
        logRecord({
          body: { stringValue: SHEPHERD_ITERATION_START_LOG },
          traceId: undefined,
        }),
        logRecord({
          body: { stringValue: SHEPHERD_ITERATION_START_LOG },
          attributes: [], // no pr
        }),
        logRecord({
          body: { stringValue: SHEPHERD_ITERATION_START_LOG },
          attributes: [{ key: "pr", value: { stringValue: "1" } }],
          timeUnixNano: undefined,
          observedTimeUnixNano: undefined,
        }),
      ]),
    );
    expect(markers).toHaveLength(0);
  });

  it("falls back to outcome=hitl when shepherd.ended carries an unrecognised value (conservative default)", () => {
    const markers = extractShepherdMarkers(
      logsPayload([
        logRecord({
          body: { stringValue: SHEPHERD_ENDED_LOG },
          attributes: [
            { key: "pr", value: { stringValue: "9" } },
            { key: "outcome", value: { stringValue: "wat" } },
          ],
          traceId: "trace-fallback",
        }),
      ]),
    );
    expect(markers[0]).toMatchObject({ kind: "ended", outcome: "hitl" });
  });
});

describe("extractPlannerMarkers — VA-474", () => {
  it("parses recommendation.proposed with evidence JSON + auto-approve flag", () => {
    const markers = extractPlannerMarkers(
      logsPayload([
        logRecord({
          body: { stringValue: PLANNER_RECOMMENDATION_PROPOSED_LOG },
          attributes: [
            { key: "recommendationId", value: { stringValue: "rec-1" } },
            {
              key: "capability",
              value: { stringValue: "shepherd-mergeability" },
            },
            { key: "target", value: { stringValue: "PR-142" } },
            {
              key: "summary",
              value: { stringValue: "rebase PR #142 — base moved" },
            },
            {
              key: "evidence",
              value: {
                stringValue: JSON.stringify({
                  files: ["src/foo.ts"],
                  headSha: "abc",
                }),
              },
            },
            { key: "autoApproveEligible", value: { stringValue: "true" } },
          ],
        }),
      ]),
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      kind: "recommendation.proposed",
      recommendationId: "rec-1",
      capability: "shepherd-mergeability",
      target: "PR-142",
      summary: "rebase PR #142 — base moved",
      autoApproveEligible: true,
    });
    expect((markers[0] as PlannerRecommendationProposedLogMarker).evidence).toEqual({
      files: ["src/foo.ts"],
      headSha: "abc",
    });
  });

  it("evidence missing or malformed collapses to {} but the marker still emits", () => {
    const markers = extractPlannerMarkers(
      logsPayload([
        logRecord({
          body: { stringValue: PLANNER_RECOMMENDATION_PROPOSED_LOG },
          attributes: [
            { key: "recommendationId", value: { stringValue: "rec-2" } },
            { key: "capability", value: { stringValue: "shepherd-ci" } },
            { key: "target", value: { stringValue: "PR-2" } },
            { key: "summary", value: { stringValue: "ci broke" } },
            { key: "evidence", value: { stringValue: "{not json" } },
          ],
        }),
      ]),
    );
    expect(markers).toHaveLength(1);
    expect((markers[0] as PlannerRecommendationProposedLogMarker).evidence).toEqual({});
  });

  it("drops recommendation.proposed when required attrs missing or capability unknown", () => {
    const markers = extractPlannerMarkers(
      logsPayload([
        // Missing recommendationId.
        logRecord({
          body: { stringValue: PLANNER_RECOMMENDATION_PROPOSED_LOG },
          attributes: [
            { key: "capability", value: { stringValue: "shepherd-ci" } },
            { key: "target", value: { stringValue: "PR-1" } },
            { key: "summary", value: { stringValue: "ok" } },
          ],
        }),
        // Unknown capability.
        logRecord({
          body: { stringValue: PLANNER_RECOMMENDATION_PROPOSED_LOG },
          attributes: [
            { key: "recommendationId", value: { stringValue: "rec-bad" } },
            { key: "capability", value: { stringValue: "unrecognised" } },
            { key: "target", value: { stringValue: "PR-1" } },
            { key: "summary", value: { stringValue: "ok" } },
          ],
        }),
      ]),
    );
    expect(markers).toHaveLength(0);
  });

  it("parses recommendation.accepted with source=operator and optional reason", () => {
    const markers = extractPlannerMarkers(
      logsPayload([
        logRecord({
          body: { stringValue: PLANNER_RECOMMENDATION_ACCEPTED_LOG },
          attributes: [
            { key: "recommendationId", value: { stringValue: "rec-5" } },
            { key: "source", value: { stringValue: "operator" } },
          ],
        }),
        logRecord({
          body: { stringValue: PLANNER_RECOMMENDATION_REJECTED_LOG },
          attributes: [
            { key: "recommendationId", value: { stringValue: "rec-6" } },
            { key: "source", value: { stringValue: "operator" } },
            { key: "reason", value: { stringValue: "not now" } },
          ],
        }),
      ]),
    );
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatchObject({
      kind: "recommendation.accepted",
      recommendationId: "rec-5",
      source: "operator",
      reason: null,
    });
    expect(markers[1]).toMatchObject({
      kind: "recommendation.rejected",
      recommendationId: "rec-6",
      source: "operator",
      reason: "not now",
    });
  });

  it("drops recommendation decisions with missing recommendationId or invalid source", () => {
    const markers = extractPlannerMarkers(
      logsPayload([
        logRecord({
          body: { stringValue: PLANNER_RECOMMENDATION_ACCEPTED_LOG },
          attributes: [{ key: "source", value: { stringValue: "operator" } }],
        }),
        logRecord({
          body: { stringValue: PLANNER_RECOMMENDATION_ACCEPTED_LOG },
          attributes: [
            { key: "recommendationId", value: { stringValue: "rec-7" } },
            { key: "source", value: { stringValue: "stranger" } },
          ],
        }),
      ]),
    );
    expect(markers).toHaveLength(0);
  });

  it("parses action.started / action.completed / action.failed", () => {
    const markers = extractPlannerMarkers(
      logsPayload([
        logRecord({
          body: { stringValue: PLANNER_ACTION_STARTED_LOG },
          attributes: [
            { key: "actionId", value: { stringValue: "act-1" } },
            { key: "recommendationId", value: { stringValue: "rec-1" } },
            {
              key: "capability",
              value: { stringValue: "shepherd-mergeability" },
            },
            { key: "target", value: { stringValue: "PR-142" } },
          ],
        }),
        logRecord({
          body: { stringValue: PLANNER_ACTION_COMPLETED_LOG },
          attributes: [
            { key: "actionId", value: { stringValue: "act-1" } },
            { key: "outcome", value: { stringValue: "rebased" } },
          ],
          timeUnixNano: "1715000099000000000",
        }),
        logRecord({
          body: { stringValue: PLANNER_ACTION_FAILED_LOG },
          attributes: [
            { key: "actionId", value: { stringValue: "act-2" } },
            { key: "error", value: { stringValue: "boom" } },
          ],
          timeUnixNano: "1715000100000000000",
        }),
      ]),
    );
    expect(markers).toHaveLength(3);
    expect(markers[0]).toMatchObject({
      kind: "action.started",
      actionId: "act-1",
      recommendationId: "rec-1",
      capability: "shepherd-mergeability",
      target: "PR-142",
    });
    expect(markers[1]).toMatchObject({
      kind: "action.completed",
      actionId: "act-1",
      outcome: "rebased",
    });
    expect(markers[2]).toMatchObject({
      kind: "action.failed",
      actionId: "act-2",
      error: "boom",
    });
  });

  it("action.started without recommendationId attribute → recommendationId=null", () => {
    const markers = extractPlannerMarkers(
      logsPayload([
        logRecord({
          body: { stringValue: PLANNER_ACTION_STARTED_LOG },
          attributes: [
            { key: "actionId", value: { stringValue: "act-orphan" } },
            { key: "capability", value: { stringValue: "queue-selection" } },
            { key: "target", value: { stringValue: "VA-200" } },
          ],
        }),
      ]),
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      kind: "action.started",
      recommendationId: null,
    });
  });

  it("drops planner markers missing a timestamp", () => {
    const markers = extractPlannerMarkers(
      logsPayload([
        logRecord({
          body: { stringValue: PLANNER_RECOMMENDATION_PROPOSED_LOG },
          attributes: [
            { key: "recommendationId", value: { stringValue: "rec-x" } },
            { key: "capability", value: { stringValue: "shepherd-ci" } },
            { key: "target", value: { stringValue: "PR-1" } },
            { key: "summary", value: { stringValue: "ok" } },
          ],
          timeUnixNano: undefined,
          observedTimeUnixNano: undefined,
        }),
      ]),
    );
    expect(markers).toHaveLength(0);
  });

  it("ignores non-planner log bodies even when capability attrs are present", () => {
    const markers = extractPlannerMarkers(
      logsPayload([
        logRecord({
          body: { stringValue: "drain.started" },
          attributes: [
            { key: "capability", value: { stringValue: "shepherd-ci" } },
          ],
        }),
      ]),
    );
    expect(markers).toHaveLength(0);
  });

  // VA-481
  it("extracts capability.mode_changed with capability + mode + updatedBy", () => {
    const markers = extractPlannerMarkers(
      logsPayload([
        logRecord({
          body: { stringValue: "planner.capability.mode_changed" },
          attributes: [
            {
              key: "capability",
              value: { stringValue: "queue-selection" },
            },
            { key: "mode", value: { stringValue: "auto" } },
            { key: "updatedBy", value: { stringValue: "operator" } },
          ],
        }),
      ]),
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      kind: "capability.mode_changed",
      capability: "queue-selection",
      mode: "auto",
      updatedBy: "operator",
    });
  });

  it("drops capability.mode_changed with unknown mode value", () => {
    const markers = extractPlannerMarkers(
      logsPayload([
        logRecord({
          body: { stringValue: "planner.capability.mode_changed" },
          attributes: [
            {
              key: "capability",
              value: { stringValue: "queue-selection" },
            },
            { key: "mode", value: { stringValue: "yolo" } },
          ],
        }),
      ]),
    );
    expect(markers).toHaveLength(0);
  });
});
