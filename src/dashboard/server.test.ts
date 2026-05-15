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

const sampleLogsPayload = {
  resourceLogs: [
    {
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: "runway" } }],
      },
      scopeLogs: [
        {
          scope: { name: "@effect/opentelemetry" },
          logRecords: [
            {
              timeUnixNano: "1715000000500000000",
              severityText: "INFO",
              severityNumber: 9,
              body: { stringValue: "base branch resolved" },
              traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              spanId: "2222222222222222",
              attributes: [
                { key: "issue", value: { stringValue: "VA-312" } },
                { key: "branch", value: { stringValue: "agent/va-312" } },
              ],
            },
            {
              timeUnixNano: "1715000000700000000",
              severityText: "WARN",
              severityNumber: 13,
              body: { stringValue: "agent retry" },
              traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              spanId: "2222222222222222",
              attributes: [
                { key: "issue", value: { stringValue: "VA-312" } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe("dashboard HTTP server — OTLP /v1/logs + detail pane (VA-388)", () => {
  it("accepts POST /v1/logs and returns 200 + partialSuccess envelope", async () => {
    const res = await fetch(`${base}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sampleLogsPayload),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { partialSuccess: unknown };
    expect(body.partialSuccess).toEqual({});
  });

  it("returns 415 for /v1/logs without application/json", async () => {
    const res = await fetch(`${base}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify(sampleLogsPayload),
    });
    expect(res.status).toBe(415);
  });

  it("returns 400 for /v1/logs with malformed JSON", async () => {
    const res = await fetch(`${base}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
  });

  it("renders the trace's logs on /trace/:id ordered ascending by timestamp", async () => {
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

    const res = await fetch(
      `${base}/trace/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("VA-312");
    expect(html).toContain("base branch resolved");
    expect(html).toContain("agent retry");
    // INFO row precedes WARN row because the INFO timestamp is earlier.
    expect(html.indexOf("base branch resolved")).toBeLessThan(
      html.indexOf("agent retry"),
    );
    // Annotated context attributes surface on the row.
    expect(html).toContain("issue=VA-312");
  });

  it("returns 404 from /trace/:id when nothing is stored for the trace", async () => {
    const res = await fetch(`${base}/trace/nonexistenttraceid`);
    expect(res.status).toBe(404);
  });

  it("links the list view's issue identifier to its detail pane", async () => {
    await fetch(`${base}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sampleTracesPayload),
    });
    const res = await fetch(`${base}/`);
    const html = await res.text();
    expect(html).toContain(
      `href="/trace/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"`,
    );
  });
});
