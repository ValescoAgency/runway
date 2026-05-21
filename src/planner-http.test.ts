import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorage, type Storage } from "./dashboard/storage.js";
import {
  startPlannerHttpServer,
  type DecisionEmitter,
  type RunningPlannerHttpServer,
} from "./planner-http.js";
import { createPlannerReadClient, type PlannerReadClient } from "./planner-storage.js";

// VA-475: integration tests against a real HTTP server on
// localhost:0 (kernel-assigned port). Uses a tempdir-backed SQLite
// file so the read-only client can open it from a separate
// connection.

let dir: string;
let dbPath: string;
let writer: Storage;
let readClient: PlannerReadClient;
let running: RunningPlannerHttpServer;
let base: string;
let emit: {
  accepted: Array<unknown>;
  rejected: Array<unknown>;
  capabilityModeChanged: Array<unknown>;
};
const emitter: DecisionEmitter = {
  emitAccepted: (m) => emit.accepted.push(m),
  emitRejected: (m) => emit.rejected.push(m),
  emitCapabilityModeChanged: (m) => emit.capabilityModeChanged.push(m),
};

const health = () => ({
  uptimeSeconds: 42,
  tickCount: 7,
  lastTickAtUnixMs: 1_700_000_000_000,
  version: "test",
});

beforeEach(async () => {
  emit = { accepted: [], rejected: [], capabilityModeChanged: [] };
  dir = mkdtempSync(join(tmpdir(), "planner-http-"));
  dbPath = join(dir, "runway.sqlite");
  writer = createStorage(dbPath);
  readClient = createPlannerReadClient({ sqlitePath: dbPath });
  running = await startPlannerHttpServer({
    host: "127.0.0.1",
    port: 0,
    readClient,
    getHealth: health,
    emitter,
  });
  base = `http://127.0.0.1:${running.port}`;
});

afterEach(async () => {
  await running.close();
  readClient.close();
  writer.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("planner HTTP — GET /planner/health", () => {
  it("returns the health snapshot", async () => {
    const res = await fetch(`${base}/planner/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      uptimeSeconds: 42,
      tickCount: 7,
      lastTickAtUnixMs: 1_700_000_000_000,
      version: "test",
    });
  });
});

describe("planner HTTP — GET /planner/recommendations", () => {
  it("returns recommendations in newest-first order", async () => {
    writer.recordPlannerRecommendationProposed({
      recommendationId: "old",
      capability: "shepherd-ci",
      target: "PR-1",
      summary: "old",
      evidence: {},
      autoApproveEligible: false,
      timestampUnixNano: "1715000001000000000",
    });
    writer.recordPlannerRecommendationProposed({
      recommendationId: "new",
      capability: "shepherd-ci",
      target: "PR-2",
      summary: "new",
      evidence: {},
      autoApproveEligible: false,
      timestampUnixNano: "1715000099000000000",
    });

    const res = await fetch(`${base}/planner/recommendations`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { recommendations: Array<{ recommendationId: string }> };
    expect(body.recommendations.map((r) => r.recommendationId)).toEqual([
      "new",
      "old",
    ]);
  });

  it("filters by status", async () => {
    writer.recordPlannerRecommendationProposed({
      recommendationId: "a",
      capability: "shepherd-ci",
      target: "PR-1",
      summary: "a",
      evidence: {},
      autoApproveEligible: false,
      timestampUnixNano: "1715000010000000000",
    });
    writer.recordPlannerRecommendationProposed({
      recommendationId: "b",
      capability: "shepherd-ci",
      target: "PR-2",
      summary: "b",
      evidence: {},
      autoApproveEligible: false,
      timestampUnixNano: "1715000011000000000",
    });
    writer.recordPlannerRecommendationDecision({
      recommendationId: "b",
      status: "accepted",
      source: "operator",
      reason: null,
      timestampUnixNano: "1715000012000000000",
    });

    const res = await fetch(`${base}/planner/recommendations?status=accepted`);
    const body = (await res.json()) as { recommendations: Array<{ recommendationId: string }> };
    expect(body.recommendations.map((r) => r.recommendationId)).toEqual(["b"]);
  });

  it("rejects invalid status with 400", async () => {
    const res = await fetch(`${base}/planner/recommendations?status=bogus`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_query");
  });

  it("rejects limit > 250 with 400", async () => {
    const res = await fetch(`${base}/planner/recommendations?limit=999`);
    expect(res.status).toBe(400);
  });
});

describe("planner HTTP — GET /planner/recommendations/:id", () => {
  beforeEach(() => {
    writer.recordPlannerRecommendationProposed({
      recommendationId: "rec-detail",
      capability: "shepherd-mergeability",
      target: "PR-1",
      summary: "rebase",
      evidence: { sha: "abc" },
      autoApproveEligible: false,
      timestampUnixNano: "1715000010000000000",
    });
  });

  it("returns 200 + row when found", async () => {
    const res = await fetch(`${base}/planner/recommendations/rec-detail`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { recommendationId: string };
    expect(body.recommendationId).toBe("rec-detail");
  });

  it("returns 404 when not found", async () => {
    const res = await fetch(`${base}/planner/recommendations/missing-id`);
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid id characters (defence-in-depth)", async () => {
    const res = await fetch(
      `${base}/planner/recommendations/${encodeURIComponent("../../etc/passwd")}`,
    );
    expect(res.status).toBe(400);
  });
});

describe("planner HTTP — POST /planner/recommendations/:id/accept", () => {
  beforeEach(() => {
    writer.recordPlannerRecommendationProposed({
      recommendationId: "rec-a",
      capability: "shepherd-mergeability",
      target: "PR-7",
      summary: "rebase",
      evidence: {},
      autoApproveEligible: false,
      timestampUnixNano: "1715000010000000000",
    });
  });

  it("202 + emits planner.recommendation.accepted to the emitter", async () => {
    const res = await fetch(`${base}/planner/recommendations/rec-a/accept`, {
      method: "POST",
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("accepted");
    expect(emit.accepted).toHaveLength(1);
    expect(emit.accepted[0]).toMatchObject({
      recommendationId: "rec-a",
      source: "operator",
    });
  });

  it("accepts an optional reason in the JSON body", async () => {
    const res = await fetch(`${base}/planner/recommendations/rec-a/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "looks right" }),
    });
    expect(res.status).toBe(202);
    expect(emit.accepted[0]).toMatchObject({
      recommendationId: "rec-a",
      source: "operator",
      reason: "looks right",
    });
  });

  it("404 when the recommendation doesn't exist", async () => {
    const res = await fetch(`${base}/planner/recommendations/missing/accept`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
    expect(emit.accepted).toHaveLength(0);
  });

  it("409 when the recommendation is already decided", async () => {
    writer.recordPlannerRecommendationDecision({
      recommendationId: "rec-a",
      status: "accepted",
      source: "operator",
      reason: null,
      timestampUnixNano: "1715000011000000000",
    });
    const res = await fetch(`${base}/planner/recommendations/rec-a/accept`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
    expect(emit.accepted).toHaveLength(0);
  });
});

describe("planner HTTP — POST /planner/recommendations/:id/reject", () => {
  beforeEach(() => {
    writer.recordPlannerRecommendationProposed({
      recommendationId: "rec-r",
      capability: "shepherd-ci",
      target: "PR-9",
      summary: "ci fix",
      evidence: {},
      autoApproveEligible: false,
      timestampUnixNano: "1715000010000000000",
    });
  });

  it("202 + emits planner.recommendation.rejected with the reason", async () => {
    const res = await fetch(`${base}/planner/recommendations/rec-r/reject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "ci flake; will retry" }),
    });
    expect(res.status).toBe(202);
    expect(emit.rejected).toHaveLength(1);
    expect(emit.rejected[0]).toMatchObject({
      recommendationId: "rec-r",
      source: "operator",
      reason: "ci flake; will retry",
    });
  });

  it("400 when reason is missing or empty (audit requires motivation)", async () => {
    const res = await fetch(`${base}/planner/recommendations/rec-r/reject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("missing_reason");
  });
});

describe("planner HTTP — GET /planner/actions", () => {
  it("returns recent actions, optionally filtered by status", async () => {
    writer.recordPlannerActionStarted({
      actionId: "act-1",
      recommendationId: null,
      capability: "queue-selection",
      target: "VA-1",
      timestampUnixNano: "1715000010000000000",
    });
    writer.recordPlannerActionStarted({
      actionId: "act-2",
      recommendationId: null,
      capability: "queue-selection",
      target: "VA-2",
      timestampUnixNano: "1715000011000000000",
    });
    writer.recordPlannerActionCompleted({
      actionId: "act-2",
      outcome: "opened",
      timestampUnixNano: "1715000012000000000",
    });

    const all = await (await fetch(`${base}/planner/actions`)).json();
    expect(all.actions).toHaveLength(2);

    const started = await (
      await fetch(`${base}/planner/actions?status=started`)
    ).json();
    expect(started.actions.map((a: { actionId: string }) => a.actionId)).toEqual([
      "act-1",
    ]);
  });

  it("400 on invalid status", async () => {
    const res = await fetch(`${base}/planner/actions?status=bogus`);
    expect(res.status).toBe(400);
  });
});

describe("planner HTTP — readClient unset (RUNWAY_PLANNER_SQLITE_PATH unset)", () => {
  let runningNoSqlite: RunningPlannerHttpServer;
  let baseNoSqlite: string;

  beforeEach(async () => {
    runningNoSqlite = await startPlannerHttpServer({
      host: "127.0.0.1",
      port: 0,
      readClient: null,
      getHealth: health,
      emitter,
    });
    baseNoSqlite = `http://127.0.0.1:${runningNoSqlite.port}`;
  });

  afterEach(async () => {
    await runningNoSqlite.close();
  });

  it("GET endpoints return 503 with planner_sqlite_not_configured", async () => {
    for (const path of [
      "/planner/recommendations",
      "/planner/recommendations/anything",
      "/planner/actions",
    ]) {
      const res = await fetch(`${baseNoSqlite}${path}`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("planner_sqlite_not_configured");
    }
  });

  it("POST /accept still emits without read-side validation", async () => {
    const res = await fetch(`${baseNoSqlite}/planner/recommendations/x/accept`, {
      method: "POST",
    });
    expect(res.status).toBe(202);
    expect(emit.accepted).toHaveLength(1);
  });

  it("GET /planner/health still works without SQLite", async () => {
    const res = await fetch(`${baseNoSqlite}/planner/health`);
    expect(res.status).toBe(200);
  });
});

describe("planner HTTP — unknown route", () => {
  it("404 with not_found code", async () => {
    const res = await fetch(`${base}/planner/nope`);
    expect(res.status).toBe(404);
  });
});

describe("planner HTTP — DecisionEmitter is wired through correctly", () => {
  it("emitter is invoked exactly once per accept call", async () => {
    writer.recordPlannerRecommendationProposed({
      recommendationId: "rec-once",
      capability: "shepherd-reviewer",
      target: "PR-3",
      summary: "respond",
      evidence: {},
      autoApproveEligible: false,
      timestampUnixNano: "1715000010000000000",
    });
    const accSpy = vi.fn();
    const stubRunning = await startPlannerHttpServer({
      host: "127.0.0.1",
      port: 0,
      readClient,
      getHealth: health,
      emitter: {
        emitAccepted: accSpy,
        emitRejected: vi.fn(),
        emitCapabilityModeChanged: vi.fn(),
      },
    });
    try {
      await fetch(`http://127.0.0.1:${stubRunning.port}/planner/recommendations/rec-once/accept`, {
        method: "POST",
      });
      expect(accSpy).toHaveBeenCalledTimes(1);
    } finally {
      await stubRunning.close();
    }
  });
});

// VA-475 acceptance: the ticket calls for an end-to-end test of the
// proposed → GET → POST /accept → dashboard projection → GET shows
// accepted lifecycle. The OTLP exporter loop isn't wired in tests
// (we'd need to boot a dashboard listener too), so we wire the
// emitter's accepted callback directly to the writer's
// recordPlannerRecommendationDecision — that's exactly what the
// dashboard's VA-474 projector does on receive. The result is the
// full lifecycle exercised through the planner's HTTP surface.
describe("planner HTTP — end-to-end accept lifecycle (VA-475 acceptance)", () => {
  it("proposed → GET → POST /accept → projection → GET shows accepted", async () => {
    // 1. Seed a proposed recommendation (simulating the planner's
    //    earlier emit + the dashboard's projection of it).
    writer.recordPlannerRecommendationProposed({
      recommendationId: "rec-e2e-life",
      capability: "shepherd-mergeability",
      target: "PR-42",
      summary: "rebase against main",
      evidence: { headSha: "abc123" },
      autoApproveEligible: false,
      timestampUnixNano: "1715000010000000000",
    });

    // Build a server whose emitter routes accepted/rejected back
    // through the writer — closes the OTLP-projection loop the
    // ticket asks the test to exercise.
    const projectingEmitter = {
      emitAccepted: (m: {
        recommendationId: string;
        source: "operator";
        reason: string | null;
        timestampUnixNano: string;
      }) =>
        writer.recordPlannerRecommendationDecision({
          recommendationId: m.recommendationId,
          status: "accepted",
          source: m.source,
          reason: m.reason,
          timestampUnixNano: m.timestampUnixNano,
        }),
      emitRejected: (m: {
        recommendationId: string;
        source: "operator";
        reason: string;
        timestampUnixNano: string;
      }) =>
        writer.recordPlannerRecommendationDecision({
          recommendationId: m.recommendationId,
          status: "rejected",
          source: m.source,
          reason: m.reason,
          timestampUnixNano: m.timestampUnixNano,
        }),
      emitCapabilityModeChanged: vi.fn(),
    };
    const e2eServer = await startPlannerHttpServer({
      host: "127.0.0.1",
      port: 0,
      readClient,
      getHealth: health,
      emitter: projectingEmitter,
    });
    const e2eBase = `http://127.0.0.1:${e2eServer.port}`;

    try {
      // 2. GET /planner/recommendations — proposed visible.
      const list = (await (
        await fetch(`${e2eBase}/planner/recommendations`)
      ).json()) as {
        recommendations: Array<{ recommendationId: string; status: string }>;
      };
      const proposed = list.recommendations.find(
        (r) => r.recommendationId === "rec-e2e-life",
      );
      expect(proposed?.status).toBe("proposed");

      // 3. POST /accept with an optional reason.
      const acceptRes = await fetch(
        `${e2eBase}/planner/recommendations/rec-e2e-life/accept`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "approved by operator" }),
        },
      );
      expect(acceptRes.status).toBe(202);
      const acceptBody = (await acceptRes.json()) as { status: string };
      expect(acceptBody.status).toBe("accepted");

      // 4. The projecting emitter has already round-tripped the
      //    decision through the writer (synchronously). GET the
      //    detail and confirm the new status.
      const after = (await (
        await fetch(`${e2eBase}/planner/recommendations/rec-e2e-life`)
      ).json()) as {
        status: string;
        decidedBy: string | null;
        decisionReason: string | null;
        decidedUnixNano: string | null;
      };
      expect(after.status).toBe("accepted");
      expect(after.decidedBy).toBe("operator");
      expect(after.decisionReason).toBe("approved by operator");
      expect(after.decidedUnixNano).not.toBeNull();

      // 5. ?status=accepted filter surfaces it; ?status=proposed
      //    no longer does.
      const accepted = (await (
        await fetch(`${e2eBase}/planner/recommendations?status=accepted`)
      ).json()) as { recommendations: Array<{ recommendationId: string }> };
      expect(
        accepted.recommendations.map((r) => r.recommendationId),
      ).toContain("rec-e2e-life");
      const stillProposed = (await (
        await fetch(`${e2eBase}/planner/recommendations?status=proposed`)
      ).json()) as { recommendations: Array<{ recommendationId: string }> };
      expect(
        stillProposed.recommendations.map((r) => r.recommendationId),
      ).not.toContain("rec-e2e-life");

      // 6. A second POST /accept is 409 — the projection landed,
      //    further accepts (e.g. a double-click) bounce off.
      const dupRes = await fetch(
        `${e2eBase}/planner/recommendations/rec-e2e-life/accept`,
        { method: "POST" },
      );
      expect(dupRes.status).toBe(409);
    } finally {
      await e2eServer.close();
    }
  });
});

describe("planner HTTP — same-origin CORS (VA-475)", () => {
  it("allows requests without an Origin header (curl, server-side)", async () => {
    // The standard test setup omits Origin headers; covered by the
    // existing test suite. This case just re-asserts via a single
    // /planner/health probe.
    const res = await fetch(`${base}/planner/health`);
    expect(res.status).toBe(200);
  });

  it("allows requests whose Origin host matches the request Host", async () => {
    const url = new URL(base);
    const res = await fetch(`${base}/planner/health`, {
      headers: { Origin: `http://${url.host}` },
    });
    expect(res.status).toBe(200);
  });

  it("blocks cross-origin requests with 403 cross_origin_blocked", async () => {
    const res = await fetch(`${base}/planner/health`, {
      headers: { Origin: "http://evil.example.com" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("cross_origin_blocked");
  });

  it("blocks cross-origin POSTs too — no side-effect emission", async () => {
    writer.recordPlannerRecommendationProposed({
      recommendationId: "rec-cors",
      capability: "shepherd-ci",
      target: "PR-1",
      summary: "x",
      evidence: {},
      autoApproveEligible: false,
      timestampUnixNano: "1715000010000000000",
    });
    const res = await fetch(
      `${base}/planner/recommendations/rec-cors/accept`,
      {
        method: "POST",
        headers: { Origin: "http://attacker.invalid" },
      },
    );
    expect(res.status).toBe(403);
    expect(emit.accepted).toHaveLength(0);
  });

  it("OPTIONS preflight from same-origin returns 204; cross-origin 403", async () => {
    const url = new URL(base);
    const ok = await fetch(`${base}/planner/recommendations`, {
      method: "OPTIONS",
      headers: { Origin: `http://${url.host}` },
    });
    expect(ok.status).toBe(204);
    const blocked = await fetch(`${base}/planner/recommendations`, {
      method: "OPTIONS",
      headers: { Origin: "http://other.host" },
    });
    expect(blocked.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // VA-481 — capability mode endpoints
  // -------------------------------------------------------------------------

  it("GET /planner/capabilities returns suggest defaults for never-set capabilities", async () => {
    const res = await fetch(`${base}/planner/capabilities`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      capabilities: ReadonlyArray<{ capability: string; mode: string }>;
    };
    const map = new Map(body.capabilities.map((c) => [c.capability, c.mode]));
    expect(map.get("queue-selection")).toBe("suggest");
    expect(map.get("shepherd-mergeability")).toBe("suggest");
    expect(map.get("shepherd-ci")).toBe("suggest");
    expect(map.get("shepherd-reviewer")).toBe("suggest");
  });

  it("GET /planner/capabilities reflects explicit DB rows", async () => {
    writer.recordPlannerCapabilityModeChange({
      capability: "queue-selection",
      mode: "auto",
      updatedBy: "operator",
      timestampUnixNano: "1715000010000000000",
    });
    const res = await fetch(`${base}/planner/capabilities`);
    const body = (await res.json()) as {
      capabilities: ReadonlyArray<{ capability: string; mode: string }>;
    };
    const map = new Map(body.capabilities.map((c) => [c.capability, c.mode]));
    expect(map.get("queue-selection")).toBe("auto");
    expect(map.get("shepherd-ci")).toBe("suggest");
  });

  it("PUT /planner/capabilities/:capability emits mode_changed", async () => {
    const res = await fetch(`${base}/planner/capabilities/queue-selection`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "auto" }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { capability: string; mode: string };
    expect(body).toEqual({ capability: "queue-selection", mode: "auto" });
    expect(emit.capabilityModeChanged).toHaveLength(1);
    expect(emit.capabilityModeChanged[0]).toMatchObject({
      capability: "queue-selection",
      mode: "auto",
      updatedBy: "operator",
    });
  });

  it("PUT /planner/capabilities rejects unknown capability with 404", async () => {
    const res = await fetch(`${base}/planner/capabilities/not-a-real-cap`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "auto" }),
    });
    expect(res.status).toBe(404);
  });

  it("PUT /planner/capabilities rejects invalid mode with 400", async () => {
    const res = await fetch(`${base}/planner/capabilities/queue-selection`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "yolo" }),
    });
    expect(res.status).toBe(400);
    expect(emit.capabilityModeChanged).toHaveLength(0);
  });

  it("PUT /planner/capabilities rejects non-JSON body with 415", async () => {
    const res = await fetch(`${base}/planner/capabilities/queue-selection`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "mode=auto",
    });
    expect(res.status).toBe(415);
  });
});
