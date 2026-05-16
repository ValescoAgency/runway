import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStorage, type Storage } from "./storage.js";
import { startServer, type RunningServer } from "./server.js";

// VA-386: server-level integration on `localhost:0` (kernel-assigned
// port). One drain → one processIssue payload through the same wire
// shape the OTel SDK would emit, asserts the dashboard renders the
// row at `/`. Keeps the OTLP HTTP spec contract honest end-to-end.

let storage: Storage;
let running: RunningServer;
let base: string;

beforeEach(async () => {
  storage = createStorage(":memory:");
  running = await startServer({ storage, port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${running.port}`;
});

afterEach(async () => {
  await running.close();
  storage.close();
});

const sampleTracesPayload = {
  resourceSpans: [
    {
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: "runway" } }],
      },
      scopeSpans: [
        {
          scope: { name: "test" },
          spans: [
            {
              traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              spanId: "1111111111111111",
              name: "drainQueue",
              startTimeUnixNano: "1715000000000000000",
              endTimeUnixNano: "1715000001000000000",
              attributes: [
                { key: "runway.drain.attempts", value: { intValue: "1" } },
                { key: "runway.drain.opened", value: { intValue: "1" } },
              ],
            },
            {
              traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              spanId: "2222222222222222",
              parentSpanId: "1111111111111111",
              name: "processIssue",
              startTimeUnixNano: "1715000000500000000",
              endTimeUnixNano: "1715000000900000000",
              attributes: [
                {
                  key: "runway.issue.identifier",
                  value: { stringValue: "VA-312" },
                },
                {
                  key: "runway.outcome.kind",
                  value: { stringValue: "opened" },
                },
                {
                  key: "runway.outcome.detail",
                  value: {
                    stringValue: "https://github.com/x/y/pull/42",
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe("dashboard HTTP server (VA-386)", () => {
  it("accepts POST /v1/traces with OTLP HTTP/JSON and returns 200 + partialSuccess envelope", async () => {
    const res = await fetch(`${base}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sampleTracesPayload),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { partialSuccess: unknown };
    // OTLP spec: success bodies carry a `partialSuccess` envelope —
    // an empty object means "everything accepted."
    expect(body.partialSuccess).toEqual({});
  });

  it("renders the projected issue process on GET / after the trace is posted", async () => {
    await fetch(`${base}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sampleTracesPayload),
    });
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("VA-312");
    expect(html).toContain("opened");
    expect(html).toContain("https://github.com/x/y/pull/42");
  });

  it("returns 415 when /v1/traces is posted without an application/json content type", async () => {
    const res = await fetch(`${base}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify(sampleTracesPayload),
    });
    expect(res.status).toBe(415);
  });

  it("returns 400 for malformed JSON on /v1/traces", async () => {
    const res = await fetch(`${base}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
  });

  it("exposes a healthz endpoint for docker compose health checks", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

// VA-385: localhost-only bind is an explicit security commitment in
// the dashboard ADR ("Binds to 127.0.0.1 only. No auth in v1."). When
// `host` is omitted, startServer must bind loopback rather than
// inheriting the prior 0.0.0.0 default.
describe("dashboard HTTP server — default bind address (VA-385)", () => {
  it("binds to 127.0.0.1 when host is unspecified", async () => {
    const localStorage = createStorage(":memory:");
    const localRunning = await startServer({ storage: localStorage, port: 0 });
    try {
      const addr = localRunning.server.address();
      expect(addr && typeof addr === "object").toBe(true);
      expect((addr as { address: string }).address).toBe("127.0.0.1");
    } finally {
      await localRunning.close();
      localStorage.close();
    }
  });
});

// VA-389: the detail route picks up impl-iter spans + review/finalize
// phase spans from the same POST that fed the list view and renders
// a single timeline page.
const detailPayload = {
  resourceSpans: [
    {
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: "runway" } }],
      },
      scopeSpans: [
        {
          scope: { name: "test" },
          spans: [
            {
              traceId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              spanId: "9999999999999999",
              name: "processIssue",
              startTimeUnixNano: "1715000000000000000",
              endTimeUnixNano: "1715000025000000000",
              attributes: [
                {
                  key: "runway.issue.identifier",
                  value: { stringValue: "VA-389-test" },
                },
                {
                  key: "runway.outcome.kind",
                  value: { stringValue: "hitl" },
                },
              ],
            },
            {
              traceId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              spanId: "aaaa000000000001",
              parentSpanId: "9999999999999999",
              name: "impl-iter-1",
              startTimeUnixNano: "1715000000000000000",
              endTimeUnixNano: "1715000010000000000",
              attributes: [
                {
                  key: "runway.iteration.exit_status",
                  value: { stringValue: "continue" },
                },
                {
                  key: "runway.iteration.sandcastle_run_id",
                  value: { stringValue: "impl-VA-389-test-iter-1" },
                },
              ],
            },
            {
              traceId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              spanId: "aaaa000000000002",
              parentSpanId: "9999999999999999",
              name: "impl-iter-2",
              startTimeUnixNano: "1715000010000000000",
              endTimeUnixNano: "1715000020000000000",
              attributes: [
                {
                  key: "runway.iteration.exit_status",
                  value: { stringValue: "blocked" },
                },
                {
                  key: "runway.iteration.sandcastle_run_id",
                  value: { stringValue: "impl-VA-389-test-iter-2" },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe("dashboard HTTP server — detail view (VA-389)", () => {
  it("renders the implement phase with one row per iteration after ingesting a multi-iteration trace", async () => {
    await fetch(`${base}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(detailPayload),
    });
    const res = await fetch(
      `${base}/issue-processes/9999999999999999`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("VA-389-test");
    expect(html).toContain("implement");
    expect(html).toContain("iter 1");
    expect(html).toContain("iter 2");
    expect(html).toContain("continue");
    expect(html).toContain("blocked");
  });

  it("returns 404 when the detail route is hit with an unknown span id", async () => {
    const res = await fetch(`${base}/issue-processes/no-such-span`);
    expect(res.status).toBe(404);
  });

  it("preserves the legacy /issue/<traceId>/<spanId> detail route for back-compat", async () => {
    await fetch(`${base}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(detailPayload),
    });
    const res = await fetch(
      `${base}/issue/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/9999999999999999`,
    );
    expect(res.status).toBe(200);
  });
});

// VA-387: span enrichment is end-to-end visible — the new attributes
// land in storage and the detail page renders the title + PR link.
const enrichmentPayload = {
  resourceSpans: [
    {
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: "runway" } }],
      },
      scopeSpans: [
        {
          scope: { name: "test" },
          spans: [
            {
              traceId: "cccccccccccccccccccccccccccccccc",
              spanId: "abcd0000000000ab",
              name: "processIssue",
              startTimeUnixNano: "1715000000000000000",
              endTimeUnixNano: "1715000025000000000",
              attributes: [
                {
                  key: "runway.issue.identifier",
                  value: { stringValue: "VA-387" },
                },
                {
                  key: "runway.issue.title",
                  value: { stringValue: "Slice 2 build" },
                },
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
                  key: "runway.branch",
                  value: { stringValue: "agent/va-387" },
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
            },
          ],
        },
      ],
    },
  ],
};

describe("dashboard HTTP server — VA-387 span enrichment", () => {
  it("renders title, branch, and a clickable PR link on /issue-processes/:id", async () => {
    await fetch(`${base}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(enrichmentPayload),
    });
    const res = await fetch(`${base}/issue-processes/abcd0000000000ab`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("VA-387");
    expect(html).toContain("Slice 2 build");
    expect(html).toContain("agent/va-387");
    expect(html).toContain(`href="https://github.com/x/y/pull/99"`);
  });
});

// VA-390: when LINEAR_API_KEY is configured the server flips the
// `linearEnabled` flag on; the list view then queries linear_snapshots
// and renders the queue preview + per-row status badges. The poller
// itself is covered in linear-sync.test.ts — these tests only assert
// the server-level wiring.
describe("dashboard HTTP server — Linear sync surfaces (VA-390)", () => {
  it("hides the Todo queue section by default (LINEAR_API_KEY-absent path)", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("Todo queue (next up)");
  });

  it("renders queue rows and per-row status badges when linearEnabled is true", async () => {
    // Boot a second server instance with linearEnabled=true sharing
    // the same storage so we can seed linear_snapshots rows before
    // the GET fires.
    storage.saveLinearSnapshot({
      issueIdentifier: "VA-Q1",
      snapshotAt: "t",
      status: "Todo",
      title: "Queued one",
      labels: ["a"],
      queuePosition: 0,
    });
    storage.saveLinearSnapshot({
      issueIdentifier: "VA-312",
      snapshotAt: "t2",
      status: "In Review",
      title: "Already processed",
      labels: [],
      queuePosition: null,
    });
    // Push a processIssue span so the row's identifier exists in
    // issue_processes — the badge join key is issueIdentifier.
    await fetch(`${base}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sampleTracesPayload),
    });

    const { startServer } = await import("./server.js");
    const enabled = await startServer({
      storage,
      port: 0,
      host: "127.0.0.1",
      linearEnabled: true,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${enabled.port}/`);
      const html = await res.text();
      expect(html).toContain("Todo queue (next up)");
      expect(html).toContain("VA-Q1");
      expect(html).toContain("Queued one");
      // The status badge for VA-312 reflects the fresher Linear status
      // ("In Review") rather than the run's terminal outcome.
      expect(html).toContain("status-badge");
      expect(html).toContain("In Review");
    } finally {
      await enabled.close();
    }
  });
});

// VA-399: the evaluator-facing aggregates view is queryable both by an
// external evaluator (sqlite SELECT) and the dashboard UI / HTTP
// clients (GET /api/aggregates). This test asserts the HTTP shape — the
// SQL contract is covered in storage.test.ts.
describe("dashboard HTTP server — /api/aggregates (VA-399)", () => {
  it("returns the aggregates view as JSON keyed by view name", async () => {
    // Drive the view through a single processIssue + drain so the
    // server-level wiring (storage.listAggregates → JSON shape) is
    // exercised end-to-end.
    await fetch(`${base}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sampleTracesPayload),
    });
    const res = await fetch(`${base}/api/aggregates`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as {
      view: string;
      rows: Array<{
        category: string;
        sampleSize: number;
        hitlEscapeRate: number;
      }>;
    };
    expect(body.view).toBe("evaluator_aggregates_v1");
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]?.category).toBe("VA");
    expect(body.rows[0]?.sampleSize).toBe(1);
  });

  it("returns an empty rows array when no drains have landed yet", async () => {
    const res = await fetch(`${base}/api/aggregates`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { view: string; rows: unknown[] };
    expect(body.view).toBe("evaluator_aggregates_v1");
    expect(body.rows).toEqual([]);
  });
});

const sampleLogsPayload = {
  resourceLogs: [
    {
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: "runway" } }],
      },
      scopeLogs: [
        {
          scope: { name: "test" },
          logRecords: [
            {
              timeUnixNano: "1715000000600000000",
              severityText: "INFO",
              body: { stringValue: "Runway picked up VA-388" },
              traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              spanId: "2222222222222222",
              attributes: [
                { key: "issue", value: { stringValue: "VA-388" } },
                { key: "branch", value: { stringValue: "agent/va-388" } },
              ],
            },
            {
              timeUnixNano: "1715000000700000000",
              severityText: "WARN",
              body: { stringValue: "review rejected, retrying" },
              traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              spanId: "2222222222222222",
              attributes: [
                { key: "attempt", value: { stringValue: "2" } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe("dashboard HTTP server — POST /v1/logs (VA-388)", () => {
  it("accepts an OTLP logs payload and returns the partialSuccess envelope", async () => {
    const res = await fetch(`${base}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sampleLogsPayload),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { partialSuccess: unknown };
    expect(body.partialSuccess).toEqual({});
  });

  it("persists log records visible via storage.streamLogsFor on the same trace_id", async () => {
    await fetch(`${base}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sampleLogsPayload),
    });
    const rows = storage.streamLogsFor(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.level)).toEqual(["INFO", "WARN"]);
    expect(rows[0]?.attributes).toEqual({
      issue: "VA-388",
      branch: "agent/va-388",
    });
  });

  it("renders posted log records in the detail-pane Logs section", async () => {
    // Post both the traces (to create the issue_process row keyed on
    // span 2222...) and the logs (correlated to the same trace).
    await fetch(`${base}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sampleTracesPayload),
    });
    await fetch(`${base}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sampleLogsPayload),
    });

    const res = await fetch(`${base}/issue-processes/2222222222222222`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(">Logs<");
    expect(html).toContain("Runway picked up VA-388");
    expect(html).toContain("review rejected, retrying");
    expect(html).toContain("INFO");
    expect(html).toContain("WARN");
    // Annotated attributes flow through to the rendered row.
    expect(html).toContain("issue=VA-388");
    expect(html).toContain("branch=agent/va-388");
  });

  it("rejects non-JSON content types with 415", async () => {
    const res = await fetch(`${base}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/x-protobuf" },
      body: "binary garbage",
    });
    expect(res.status).toBe(415);
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await fetch(`${base}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("dashboard HTTP server — list-view fragment & SSE (VA-391)", () => {
  it("GET /issue-processes returns just the tbody fragment (no <html>)", async () => {
    await fetch(`${base}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sampleTracesPayload),
    });

    const res = await fetch(`${base}/issue-processes`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    // Fragment, not a full document — the polling tbody swap relies
    // on no surrounding <html> / <body> tags.
    expect(html).not.toContain("<html");
    expect(html).not.toContain("<body");
    expect(html).toContain("<tr");
    expect(html).toContain("VA-312");
  });

  it("SSE stream returns 404 when the issue process span_id doesn't resolve", async () => {
    const res = await fetch(`${base}/issue-processes/does-not-exist/stream`);
    expect(res.status).toBe(404);
  });

  it("SSE stream live-tails a new log record as a logsRefresh frame", async () => {
    // First land the issue_processes row so the SSE handler can
    // resolve the span_id to a trace_id.
    await fetch(`${base}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sampleTracesPayload),
    });

    const controller = new AbortController();
    const streamRes = await fetch(
      `${base}/issue-processes/2222222222222222/stream`,
      { signal: controller.signal },
    );
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get("content-type")).toContain("text/event-stream");

    const reader = streamRes.body!.getReader();
    const decoder = new TextDecoder();
    // Drain the initial open frame so we don't conflate it with the
    // post-publish frame.
    await reader.read();

    // Publish a log on the same trace_id — should arrive as an SSE
    // logsRefresh frame containing the rendered Logs section.
    await fetch(`${base}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sampleLogsPayload),
    });

    // Read until we see a logsRefresh event or time out. The bus
    // delivers synchronously after the POST resolves, so this read
    // is bounded.
    let buf = "";
    for (let i = 0; i < 5; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.includes("event: logsRefresh")) break;
    }

    expect(buf).toContain("event: logsRefresh");
    // The frame body is the rendered Logs section HTML — both posted
    // log lines should appear.
    expect(buf).toContain("Runway picked up VA-388");
    expect(buf).toContain("review rejected, retrying");

    controller.abort();
  });

  it("the SSE handler unsubscribes when the client closes the connection", async () => {
    const { createEventBus } = await import("./events.js");
    const events = createEventBus();
    // Replace the running server with one wired to the custom bus
    // so we can observe subscriberCount before/after.
    await running.close();
    storage = createStorage(":memory:");
    running = await startServer({
      storage,
      port: 0,
      host: "127.0.0.1",
      events,
    });
    base = `http://127.0.0.1:${running.port}`;

    await fetch(`${base}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sampleTracesPayload),
    });

    expect(events.subscriberCount()).toBe(0);

    const controller = new AbortController();
    const streamRes = await fetch(
      `${base}/issue-processes/2222222222222222/stream`,
      { signal: controller.signal },
    );
    // Drain the initial frame so the subscribe definitely fired.
    await streamRes.body!.getReader().read();
    expect(events.subscriberCount()).toBe(1);

    controller.abort();
    // Wait a tick for the server's "close" handler to run.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events.subscriberCount()).toBe(0);
  });

  it("renders the drain summary strip on / when an in-flight drain exists", async () => {
    // Post an issue_processes WITHOUT its parent drain → the
    // storage layer treats this as in-flight.
    const partial = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "ffffffffffffffffffffffffffffffff",
                  spanId: "ff11111111111111",
                  parentSpanId: "ff00000000000000",
                  name: "processIssue",
                  startTimeUnixNano: "1715000010000000000",
                  endTimeUnixNano: "1715000011000000000",
                  attributes: [
                    {
                      key: "runway.issue.identifier",
                      value: { stringValue: "VA-IN-FLIGHT" },
                    },
                    {
                      key: "runway.outcome.kind",
                      value: { stringValue: "opened" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    await fetch(`${base}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(partial),
    });

    const res = await fetch(`${base}/`);
    const html = await res.text();
    expect(html).toContain("Drain started");
    // counters render with surrounding <strong> tags for visual
    // hierarchy — assert on the markup so a future restyling doesn't
    // silently lose the counts.
    expect(html).toMatch(/<strong>1<\/strong>\/<strong>1<\/strong> issues/);
    expect(html).toContain("<strong>0</strong> HITL");
    expect(html).toContain("<strong>0</strong> errors");
    expect(html).not.toContain("Idle — no active drain");
  });

  it("renders the Idle indicator on / when no drain is active", async () => {
    const res = await fetch(`${base}/`);
    const html = await res.text();
    expect(html).toContain("Idle — no active drain");
    expect(html).not.toContain("Drain started");
  });
});

// VA-392: filter chips + URL state + empty-state distinction.
describe("dashboard HTTP server — list view filters (VA-392)", () => {
  // Stage a few representative outcomes so chip filters have something
  // to bite on.
  beforeEach(async () => {
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "runway" } },
            ],
          },
          scopeSpans: [
            {
              scope: { name: "test" },
              spans: [
                {
                  traceId: "cccccccccccccccccccccccccccccccc",
                  spanId: "c000000000000001",
                  name: "processIssue",
                  startTimeUnixNano: "1715000000000000000",
                  endTimeUnixNano: "1715000000500000000",
                  attributes: [
                    {
                      key: "runway.issue.identifier",
                      value: { stringValue: "VA-OPENED" },
                    },
                    {
                      key: "runway.outcome.kind",
                      value: { stringValue: "opened" },
                    },
                  ],
                },
                {
                  traceId: "cccccccccccccccccccccccccccccccc",
                  spanId: "c000000000000002",
                  name: "processIssue",
                  startTimeUnixNano: "1715000001000000000",
                  endTimeUnixNano: "1715000001500000000",
                  attributes: [
                    {
                      key: "runway.issue.identifier",
                      value: { stringValue: "VA-HITL" },
                    },
                    {
                      key: "runway.outcome.kind",
                      value: { stringValue: "hitl" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    await fetch(`${base}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  });

  it("renders one chip per outcome kind on the list view", async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('class="filter-chip outcome-opened"');
    expect(html).toContain('class="filter-chip outcome-hitl"');
    expect(html).toContain('class="filter-chip outcome-errored"');
    expect(html).toContain('class="filter-chip outcome-in-flight"');
  });

  it("filters the row set when ?outcome= is set in the URL", async () => {
    const html = await (await fetch(`${base}/?outcome=opened`)).text();
    expect(html).toContain("VA-OPENED");
    expect(html).not.toContain("VA-HITL");
    // The opened chip carries the `active` class on this URL.
    expect(html).toContain('outcome-opened active"');
  });

  it("supports multiple outcomes via comma-separated ?outcome=", async () => {
    const html = await (
      await fetch(`${base}/?outcome=opened,hitl`)
    ).text();
    expect(html).toContain("VA-OPENED");
    expect(html).toContain("VA-HITL");
  });

  it("encodes the filter state in the fragment endpoint URL so polling preserves it", async () => {
    const html = await (await fetch(`${base}/?outcome=hitl`)).text();
    // The tbody's hx-get URL embeds the same filter so the htmx poll
    // doesn't reset the user's chip selection.
    expect(html).toMatch(/hx-get="\/issue-processes\?outcome=hitl"/);
  });

  it("returns the filtered tbody fragment via /issue-processes?outcome=…", async () => {
    const res = await fetch(`${base}/issue-processes?outcome=opened`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("VA-OPENED");
    expect(html).not.toContain("VA-HITL");
  });

  it("shows the 'no rows match this filter' empty state when a filter yields nothing", async () => {
    const html = await (
      await fetch(`${base}/?outcome=errored`)
    ).text();
    expect(html).toContain("No issue processes match this filter");
    expect(html).not.toContain("No issue processes yet.");
  });

  it("falls back to the 'no data yet' empty state when no filter is active", async () => {
    // Build a fresh server with empty storage so the unfiltered empty
    // state has a chance to render.
    const emptyStorage = createStorage(":memory:");
    const emptyRunning = await startServer({ storage: emptyStorage, port: 0 });
    try {
      const html = await (
        await fetch(`http://127.0.0.1:${emptyRunning.port}/`)
      ).text();
      expect(html).toContain("No issue processes yet.");
      expect(html).not.toContain("No issue processes match this filter");
    } finally {
      await emptyRunning.close();
      emptyStorage.close();
    }
  });

  it("filters by recent drain via ?drain=<traceId>", async () => {
    // Ingest a second drain with a different trace_id so the chip
    // selection actually narrows the row set.
    const otherTrace = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "runway" } },
            ],
          },
          scopeSpans: [
            {
              scope: { name: "test" },
              spans: [
                {
                  traceId: "dddddddddddddddddddddddddddddddd",
                  spanId: "d000000000000001",
                  name: "processIssue",
                  startTimeUnixNano: "1715000010000000000",
                  endTimeUnixNano: "1715000010500000000",
                  attributes: [
                    {
                      key: "runway.issue.identifier",
                      value: { stringValue: "VA-OTHER" },
                    },
                    {
                      key: "runway.outcome.kind",
                      value: { stringValue: "opened" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    await fetch(`${base}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(otherTrace),
    });
    const html = await (
      await fetch(`${base}/?drain=cccccccccccccccccccccccccccccccc`)
    ).text();
    expect(html).toContain("VA-OPENED");
    expect(html).toContain("VA-HITL");
    expect(html).not.toContain("VA-OTHER");
  });

  it("ignores unknown ?range= values rather than 400-ing", async () => {
    const res = await fetch(`${base}/?range=garbage`);
    expect(res.status).toBe(200);
    // The "all" range chip remains active when the input is unknown.
    const html = await res.text();
    expect(html).toContain('range-all active"');
  });

  it("renders an htmx-indicator progress bar above the table", async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('class="progress-bar htmx-indicator"');
    expect(html).toContain('hx-indicator="#rows-progress"');
  });
});

// VA-392: explicit OTLP / dashboard bind env vars. `DASHBOARD_BIND`
// overrides the dashboard listener's host; `OTLP_BIND` overrides the
// OTLP receiver's. Both default to 127.0.0.1.
describe("dashboard HTTP server — explicit bind env vars (VA-392)", () => {
  it("keeps the 127.0.0.1 default when no host option is passed", async () => {
    const localStorage = createStorage(":memory:");
    const localRunning = await startServer({ storage: localStorage, port: 0 });
    try {
      const addr = localRunning.server.address();
      expect((addr as { address: string }).address).toBe("127.0.0.1");
    } finally {
      await localRunning.close();
      localStorage.close();
    }
  });

  it("honors an explicit host option (the env-var wiring lives in main())", async () => {
    const localStorage = createStorage(":memory:");
    const localRunning = await startServer({
      storage: localStorage,
      port: 0,
      host: "127.0.0.1",
    });
    try {
      const addr = localRunning.server.address();
      expect((addr as { address: string }).address).toBe("127.0.0.1");
    } finally {
      await localRunning.close();
      localStorage.close();
    }
  });
});

// ---------------------------------------------------------------------------
// VA-407: GET /meta-reviews list view + GET /meta-reviews/:id detail
// ---------------------------------------------------------------------------

const baseMetaRow = (over: Record<string, unknown> = {}) =>
  ({
    id: "default-id",
    kind: "meta-run-review" as const,
    scope: "VA-401",
    drainId: "trace-1",
    issueId: "VA-401",
    contentJson: JSON.stringify({
      review: {
        issue_identifier: "VA-401",
        agent_quality: { absolute: "STRONG", justification: "Surgical." },
        recommendations: [],
        hindsight_signals: null,
      },
    }),
    templateVersion: "1.2.0",
    createdAt: "2026-05-15 12:00:00",
    ...over,
  });

describe("dashboard HTTP server — /meta-reviews (VA-407)", () => {
  it("GET /meta-reviews renders the list view with the row's scope + summary link", async () => {
    storage.saveMetaReview(baseMetaRow({ id: "row-1", scope: "VA-401" }));
    const res = await fetch(`${base}/meta-reviews`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain("VA-401");
    expect(html).toContain('href="/meta-reviews/row-1"');
  });

  it("GET /meta-reviews?kind=meta-failed filters to one kind", async () => {
    storage.saveMetaReview(
      baseMetaRow({ id: "good", kind: "meta-run-review" }),
    );
    storage.saveMetaReview(
      baseMetaRow({
        id: "bad",
        kind: "meta-failed",
        contentJson: JSON.stringify({ reason: "anthropic 5xx" }),
      }),
    );
    const res = await fetch(`${base}/meta-reviews?kind=meta-failed`);
    const html = await res.text();
    expect(html).toContain('href="/meta-reviews/bad"');
    expect(html).not.toContain('href="/meta-reviews/good"');
  });

  it("GET /meta-reviews?page=2 paginates correctly (offset = page-1 × page_size)", async () => {
    // 25 rows; page_size 20 → page 2 shows the remaining 5.
    for (let i = 1; i <= 25; i += 1) {
      storage.saveMetaReview(
        baseMetaRow({
          id: `row-${i.toString().padStart(2, "0")}`,
          scope: `VA-${100 + i}`,
          // Distinct timestamps so DESC ordering is deterministic;
          // row-25 is freshest.
          createdAt: `2026-05-15 12:00:${i.toString().padStart(2, "0")}`,
        }),
      );
    }
    const page1Html = await (await fetch(`${base}/meta-reviews`)).text();
    expect(page1Html).toContain("1–20 of 25");
    expect(page1Html).toContain('href="/meta-reviews/row-25"');
    expect(page1Html).not.toContain('href="/meta-reviews/row-05"');
    const page2Html = await (
      await fetch(`${base}/meta-reviews?page=2`)
    ).text();
    expect(page2Html).toContain("21–25 of 25");
    expect(page2Html).toContain('href="/meta-reviews/row-05"');
    expect(page2Html).not.toContain('href="/meta-reviews/row-25"');
  });

  it("GET /meta-reviews/:id renders the Run Review detail with source-run cross-link", async () => {
    storage.saveIssueProcess({
      traceId: "trace-1",
      spanId: "source-span-1",
      parentSpanId: null,
      issueIdentifier: "VA-401",
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
    storage.saveMetaReview(baseMetaRow({ id: "rr-1" }));
    const res = await fetch(`${base}/meta-reviews/rr-1`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Quality grades");
    expect(html).toContain("STRONG");
    // AC: cross-link to canonical /issue-processes/:spanId.
    expect(html).toContain('href="/issue-processes/source-span-1"');
  });

  it("GET /meta-reviews/:id returns 404 for an unknown id", async () => {
    const res = await fetch(`${base}/meta-reviews/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it("GET /meta-reviews/:id for a Drain Review links to the drain's issue_processes filter", async () => {
    storage.saveMetaReview(
      baseMetaRow({
        id: "dr-1",
        kind: "meta-drain-review",
        scope: "trace-1",
        drainId: "trace-1",
        issueId: null,
        contentJson: JSON.stringify({
          review: {
            severity: "routine",
            severity_justification: "fine",
            issue_count: 2,
            outcomes_summary: { opened: 2 },
            recommendations: [],
          },
        }),
      }),
    );
    const html = await (await fetch(`${base}/meta-reviews/dr-1`)).text();
    expect(html).toContain('href="/?drain=trace-1"');
  });

  it("GET /meta-reviews/:id renders an older v1.0.0 Run Review without crashing", async () => {
    // Legacy v1.0.0 carried `relative: null` nested inside each
    // quality section and no top-level relative axis. The detail
    // view should tolerate the older shape.
    storage.saveMetaReview(
      baseMetaRow({
        id: "old-rr",
        templateVersion: "1.0.0",
        contentJson: JSON.stringify({
          review: {
            issue_identifier: "VA-1",
            agent_quality: {
              absolute: "WEAK",
              relative: null,
              justification: "legacy",
            },
            recommendations: [
              { target: "prompt", change: "tighten", confidence: "LOW" },
            ],
            hindsight_signals: null,
          },
        }),
      }),
    );
    const res = await fetch(`${base}/meta-reviews/old-rr`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("WEAK");
    expect(html).toContain("tighten");
  });
});
