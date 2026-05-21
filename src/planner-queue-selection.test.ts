import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, HashMap, Layer, Logger, LogLevel } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLANNER_RECOMMENDATION_PROPOSED_LOG } from "./dashboard/projector.js";
import { createStorage, type Storage } from "./dashboard/storage.js";
import {
  evaluateQueueSelection,
  QUEUE_SELECTION_CAPABILITY,
  type QueueSelectionContext,
} from "./planner-queue-selection.js";
import {
  createPlannerReadClient,
  type PlannerReadClient,
} from "./planner-storage.js";

// VA-476: integration tests against a real SQLite file populated via
// the dashboard's writer interface, read via the planner's read-only
// client. End-to-end through the projector boundary.

interface CapturedLog {
  readonly message: string;
  readonly attrs: Record<string, unknown>;
}

const makeCapturingLogger = (
  sink: CapturedLog[],
): Layer.Layer<never, never, never> =>
  Logger.replace(
    Logger.defaultLogger,
    Logger.make((options) => {
      const msg = Array.isArray(options.message)
        ? options.message.join(" ")
        : String(options.message);
      const attrs: Record<string, unknown> = {};
      for (const [k, v] of HashMap.toEntries(options.annotations)) {
        attrs[k] = v;
      }
      sink.push({ message: msg, attrs });
    }),
  );

let dir: string;
let dbPath: string;
let writer: Storage;
let readClient: PlannerReadClient;
let sink: CapturedLog[];
let ctx: QueueSelectionContext;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "queue-sel-"));
  dbPath = join(dir, "runway.sqlite");
  writer = createStorage(dbPath);
  readClient = createPlannerReadClient({ sqlitePath: dbPath });
  sink = [];
  ctx = {
    readClient,
    readyLabel: "ready-for-agent",
    now: () => "1715000010000000000",
  };
});

afterEach(() => {
  readClient.close();
  writer.close();
  rmSync(dir, { recursive: true, force: true });
});

const seedSnapshot = (over: {
  identifier: string;
  title?: string;
  labels?: readonly string[];
  queuePosition?: number | null;
  statusType?: string;
  projectId?: string | null;
  projectName?: string | null;
}): void => {
  writer.saveLinearSnapshot({
    issueIdentifier: over.identifier,
    snapshotAt: new Date().toISOString(),
    status: "Todo",
    title: over.title ?? `Title for ${over.identifier}`,
    labels: over.labels ?? ["ready-for-agent"],
    queuePosition: over.queuePosition ?? 0,
    projectId: over.projectId ?? null,
    projectName: over.projectName ?? null,
    statusType: over.statusType ?? "unstarted",
  });
};

const runProgram = (
  effect: Effect.Effect<unknown, unknown, never>,
): Promise<unknown> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(makeCapturingLogger(sink)),
      Logger.withMinimumLogLevel(LogLevel.Info),
    ) as Effect.Effect<unknown, never, never>,
  );

describe("evaluateQueueSelection — VA-476", () => {
  it("returns no-ready when linear_snapshots is empty", async () => {
    const result = (await runProgram(evaluateQueueSelection(ctx))) as {
      kind: string;
    };
    expect(result.kind).toBe("no-ready");
    expect(sink.filter((l) => l.message === PLANNER_RECOMMENDATION_PROPOSED_LOG)).toHaveLength(0);
  });

  it("emits a recommendation for the top of queue", async () => {
    seedSnapshot({ identifier: "VA-101", queuePosition: 0 });
    seedSnapshot({ identifier: "VA-102", queuePosition: 1 });

    const result = (await runProgram(evaluateQueueSelection(ctx))) as {
      kind: string;
      target: string;
    };
    expect(result).toEqual({ kind: "emitted", target: "VA-101" });

    const emit = sink.find(
      (l) => l.message === PLANNER_RECOMMENDATION_PROPOSED_LOG,
    );
    expect(emit).toBeDefined();
    expect(emit?.attrs).toMatchObject({
      recommendationId: "queue-selection:VA-101",
      capability: QUEUE_SELECTION_CAPABILITY,
      target: "VA-101",
      autoApproveEligible: "true",
      timestampUnixNano: "1715000010000000000",
    });
    expect(String(emit?.attrs.summary)).toContain("VA-101");
    // Evidence is JSON-stringified for OTLP transport.
    const evidence = JSON.parse(String(emit?.attrs.evidence));
    expect(evidence).toMatchObject({ queuePosition: 0 });
  });

  it("skips issues without the configured ready label", async () => {
    seedSnapshot({
      identifier: "VA-201",
      queuePosition: 0,
      labels: ["other-label"],
    });
    seedSnapshot({
      identifier: "VA-202",
      queuePosition: 1,
      labels: ["ready-for-agent"],
    });

    const result = (await runProgram(evaluateQueueSelection(ctx))) as {
      target: string;
    };
    expect(result.target).toBe("VA-202");
  });

  it("skips issues whose status_type is started/completed/canceled", async () => {
    seedSnapshot({
      identifier: "VA-301",
      queuePosition: 0,
      statusType: "started",
    });
    seedSnapshot({
      identifier: "VA-302",
      queuePosition: 1,
      statusType: "unstarted",
    });

    const result = (await runProgram(evaluateQueueSelection(ctx))) as {
      target: string;
    };
    expect(result.target).toBe("VA-302");
  });

  it("dedup: skips targets with an open (proposed) recommendation", async () => {
    seedSnapshot({ identifier: "VA-401", queuePosition: 0 });
    seedSnapshot({ identifier: "VA-402", queuePosition: 1 });

    // Pre-existing proposed recommendation for VA-401 — typical of
    // the previous tick's emission still sitting unaccepted.
    writer.recordPlannerRecommendationProposed({
      recommendationId: "queue-selection:VA-401",
      capability: "queue-selection",
      target: "VA-401",
      summary: "old",
      evidence: {},
      autoApproveEligible: false,
      timestampUnixNano: "1715000001000000000",
    });

    const result = (await runProgram(evaluateQueueSelection(ctx))) as {
      target: string;
    };
    expect(result.target).toBe("VA-402");
  });

  it("dedup: skips targets with an accepted recommendation (waiting for action)", async () => {
    seedSnapshot({ identifier: "VA-501", queuePosition: 0 });
    seedSnapshot({ identifier: "VA-502", queuePosition: 1 });

    writer.recordPlannerRecommendationProposed({
      recommendationId: "queue-selection:VA-501",
      capability: "queue-selection",
      target: "VA-501",
      summary: "old",
      evidence: {},
      autoApproveEligible: false,
      timestampUnixNano: "1715000001000000000",
    });
    writer.recordPlannerRecommendationDecision({
      recommendationId: "queue-selection:VA-501",
      status: "accepted",
      source: "operator",
      reason: null,
      timestampUnixNano: "1715000002000000000",
    });

    const result = (await runProgram(evaluateQueueSelection(ctx))) as {
      target: string;
    };
    expect(result.target).toBe("VA-502");
  });

  it("dedup: skips targets with an in-flight action", async () => {
    seedSnapshot({ identifier: "VA-601", queuePosition: 0 });
    seedSnapshot({ identifier: "VA-602", queuePosition: 1 });

    writer.recordPlannerActionStarted({
      actionId: "act-1",
      recommendationId: null,
      capability: "queue-selection",
      target: "VA-601",
      timestampUnixNano: "1715000003000000000",
    });

    const result = (await runProgram(evaluateQueueSelection(ctx))) as {
      target: string;
    };
    expect(result.target).toBe("VA-602");
  });

  it("returns all-pending when every ready issue is open or in-flight", async () => {
    seedSnapshot({ identifier: "VA-701", queuePosition: 0 });
    writer.recordPlannerRecommendationProposed({
      recommendationId: "queue-selection:VA-701",
      capability: "queue-selection",
      target: "VA-701",
      summary: "old",
      evidence: {},
      autoApproveEligible: false,
      timestampUnixNano: "1715000001000000000",
    });

    const result = (await runProgram(evaluateQueueSelection(ctx))) as {
      kind: string;
    };
    expect(result.kind).toBe("all-pending");
    expect(
      sink.filter((l) => l.message === PLANNER_RECOMMENDATION_PROPOSED_LOG),
    ).toHaveLength(0);
  });

  it("dedup: skips targets with a rejected recommendation (operator decision is terminal)", async () => {
    // PR #206 Cursor review surfaced a doc/code disagreement: the
    // module comment said rejected was terminal, but the filter
    // only matched proposed|accepted, so the planner re-emitted
    // every tick (idempotent insert on the dashboard side absorbed
    // it but the OTLP traffic was noise). Broadened to filter ANY
    // recommendation row regardless of status. Operator removes +
    // re-adds the ready-for-agent label to retry.
    seedSnapshot({ identifier: "VA-801", queuePosition: 0 });
    seedSnapshot({ identifier: "VA-802", queuePosition: 1 });
    writer.recordPlannerRecommendationProposed({
      recommendationId: "queue-selection:VA-801",
      capability: "queue-selection",
      target: "VA-801",
      summary: "old",
      evidence: {},
      autoApproveEligible: false,
      timestampUnixNano: "1715000001000000000",
    });
    writer.recordPlannerRecommendationDecision({
      recommendationId: "queue-selection:VA-801",
      status: "rejected",
      source: "operator",
      reason: "not now",
      timestampUnixNano: "1715000002000000000",
    });

    const result = (await runProgram(evaluateQueueSelection(ctx))) as {
      target: string;
    };
    expect(result.target).toBe("VA-802");
  });

  it("sort is deterministic: queue_position ASC, then issue_identifier ASC", async () => {
    seedSnapshot({ identifier: "VA-100", queuePosition: 5 });
    seedSnapshot({ identifier: "VA-50", queuePosition: 5 });
    seedSnapshot({ identifier: "VA-200", queuePosition: 1 });

    const result = (await runProgram(evaluateQueueSelection(ctx))) as {
      target: string;
    };
    expect(result.target).toBe("VA-200");
  });

  // VA-481 — capability-mode gating
  it("manual mode → capability stays silent (no emissions, no dedup hit)", async () => {
    seedSnapshot({ identifier: "VA-900", queuePosition: 0 });
    writer.recordPlannerCapabilityModeChange({
      capability: "queue-selection",
      mode: "manual",
      updatedBy: "operator",
      timestampUnixNano: "1715000000000000000",
    });

    const result = (await runProgram(evaluateQueueSelection(ctx))) as {
      kind: string;
      target: string | null;
    };
    expect(result.kind).toBe("no-ready");
    expect(sink.filter((l) => l.message === PLANNER_RECOMMENDATION_PROPOSED_LOG)).toHaveLength(0);
  });

  it("auto mode → emits both recommendation.proposed AND recommendation.accepted (source=auto)", async () => {
    seedSnapshot({ identifier: "VA-901", queuePosition: 0 });
    writer.recordPlannerCapabilityModeChange({
      capability: "queue-selection",
      mode: "auto",
      updatedBy: "operator",
      timestampUnixNano: "1715000000000000000",
    });

    const result = (await runProgram(evaluateQueueSelection(ctx))) as {
      kind: string;
      target: string;
    };
    expect(result.target).toBe("VA-901");

    const proposed = sink.find(
      (l) => l.message === PLANNER_RECOMMENDATION_PROPOSED_LOG,
    );
    expect(proposed?.attrs.autoApproveEligible).toBe("true");
    const accepted = sink.find(
      (l) => l.message === "planner.recommendation.accepted",
    );
    expect(accepted).toBeDefined();
    expect(accepted?.attrs.source).toBe("auto");
    expect(accepted?.attrs.recommendationId).toBe("queue-selection:VA-901");
  });
});
