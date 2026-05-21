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
let emit: { accepted: Array<unknown>; rejected: Array<unknown> };
const emitter: DecisionEmitter = {
  emitAccepted: (m) => emit.accepted.push(m),
  emitRejected: (m) => emit.rejected.push(m),
};

const health = () => ({
  uptimeSeconds: 42,
  tickCount: 7,
  lastTickAtUnixMs: 1_700_000_000_000,
  version: "test",
});

beforeEach(async () => {
  emit = { accepted: [], rejected: [] };
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
      emitter: { emitAccepted: accSpy, emitRejected: vi.fn() },
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
