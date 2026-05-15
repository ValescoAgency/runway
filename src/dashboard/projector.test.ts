import { describe, expect, it } from "vitest";
import type {
  OtlpLogRecord,
  OtlpLogsPayload,
  OtlpSpan,
  OtlpTracesPayload,
} from "./otlp.js";
import { projectLogsPayload, projectPayload } from "./projector.js";

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
    expect(out).toEqual({ drains: [], issueProcesses: [], rawSpans: [] });
  });
});

function logPayload(records: readonly OtlpLogRecord[]): OtlpLogsPayload {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "runway" } },
          ],
        },
        scopeLogs: [{ scope: { name: "@effect/opentelemetry" }, logRecords: records }],
      },
    ],
  };
}

describe("projectLogsPayload (VA-388)", () => {
  it("projects a body+attributes log record keyed on trace_id / span_id", () => {
    const out = projectLogsPayload(
      logPayload([
        {
          timeUnixNano: "1715000000000000000",
          severityText: "INFO",
          severityNumber: 9,
          body: { stringValue: "base branch resolved" },
          traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          spanId: "1111111111111111",
          attributes: [
            { key: "issue", value: { stringValue: "VA-312" } },
            { key: "branch", value: { stringValue: "agent/va-312" } },
          ],
        },
      ]),
    );
    expect(out.logs).toHaveLength(1);
    expect(out.logs[0]).toMatchObject({
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      spanId: "1111111111111111",
      timeUnixNano: "1715000000000000000",
      level: "INFO",
      message: "base branch resolved",
    });
    expect(JSON.parse(out.logs[0]!.attributesJson)).toEqual({
      issue: "VA-312",
      branch: "agent/va-312",
    });
  });

  it("falls back to severityNumber → label when severityText is absent", () => {
    const out = projectLogsPayload(
      logPayload([
        {
          timeUnixNano: "1715000000000000000",
          severityNumber: 17,
          body: { stringValue: "boom" },
        },
      ]),
    );
    expect(out.logs[0]?.level).toBe("ERROR");
  });

  it("uses observedTimeUnixNano when timeUnixNano is absent", () => {
    const out = projectLogsPayload(
      logPayload([
        {
          observedTimeUnixNano: "1715000000111111111",
          severityText: "INFO",
          body: { stringValue: "x" },
        },
      ]),
    );
    expect(out.logs[0]?.timeUnixNano).toBe("1715000000111111111");
  });

  it("flattens multiple resourceLogs / scopeLogs into one ordered projection", () => {
    const out = projectLogsPayload({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1",
                  severityText: "INFO",
                  body: { stringValue: "a" },
                  traceId: "t1",
                  spanId: "s1",
                },
              ],
            },
            {
              logRecords: [
                {
                  timeUnixNano: "2",
                  severityText: "WARN",
                  body: { stringValue: "b" },
                  traceId: "t1",
                  spanId: "s2",
                },
              ],
            },
          ],
        },
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "3",
                  severityText: "ERROR",
                  body: { stringValue: "c" },
                  traceId: "t1",
                  spanId: "s3",
                },
              ],
            },
          ],
        },
      ],
    });
    expect(out.logs.map((r) => r.message)).toEqual(["a", "b", "c"]);
  });

  it("survives an empty body (no stringValue) by emitting an empty message string", () => {
    const out = projectLogsPayload(
      logPayload([{ timeUnixNano: "1", severityText: "INFO" }]),
    );
    expect(out.logs[0]?.message).toBe("");
  });

  it("returns no logs for an empty payload (smoke)", () => {
    expect(projectLogsPayload({ resourceLogs: [] })).toEqual({ logs: [] });
  });
});
