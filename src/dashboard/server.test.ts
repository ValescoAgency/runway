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
