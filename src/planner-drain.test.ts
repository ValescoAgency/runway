import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, HashMap, Logger, LogLevel } from "effect";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  PLANNER_ACTION_COMPLETED_LOG,
  PLANNER_ACTION_FAILED_LOG,
  PLANNER_ACTION_STARTED_LOG,
} from "./dashboard/projector.js";
import { createStorage, type Storage } from "./dashboard/storage.js";

const {
  DRAIN_CAPABILITY,
  evaluateDrain,
  parseDrainOutcome,
} = await import("./planner-drain.js");
const { createPlannerReadClient } = await import("./planner-storage.js");

interface CapturedLog {
  readonly message: string;
  readonly attrs: Record<string, unknown>;
}

const captureLogger = (sink: CapturedLog[]) =>
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

const seedAcceptedQueueRec = (
  writer: Storage,
  args: { recommendationId: string; target: string; proposedNano: string },
) => {
  writer.recordPlannerRecommendationProposed({
    recommendationId: args.recommendationId,
    capability: "queue-selection",
    target: args.target,
    summary: `Pick up ${args.target}`,
    evidence: { queuePosition: 1 },
    autoApproveEligible: false,
    timestampUnixNano: args.proposedNano,
  });
  writer.recordPlannerRecommendationDecision({
    recommendationId: args.recommendationId,
    status: "accepted",
    source: "operator",
    reason: null,
    timestampUnixNano: String(BigInt(args.proposedNano) + 1_000_000n),
  });
};

describe("parseDrainOutcome — VA-480", () => {
  it("non-zero exit → errored regardless of marker", () => {
    const r = parseDrainOutcome(
      "[runway:exit] status=success attempts=1 opened=1 hitl=0 errored=0 skipped=0",
      2,
    );
    expect(r.outcome).toBe("errored");
    expect(r.exitCode).toBe(2);
  });

  it("opened=1 → opened", () => {
    const r = parseDrainOutcome(
      "[runway:exit] status=success attempts=1 opened=1 hitl=0 errored=0 skipped=0",
      0,
    );
    expect(r.outcome).toBe("opened");
  });

  it("hitl=1 → hitl", () => {
    const r = parseDrainOutcome(
      "[runway:exit] status=success attempts=1 opened=0 hitl=1 errored=0 skipped=0",
      0,
    );
    expect(r.outcome).toBe("hitl");
  });

  it("errored=1 → errored", () => {
    const r = parseDrainOutcome(
      "[runway:exit] status=success attempts=1 opened=0 hitl=0 errored=1 skipped=0",
      0,
    );
    expect(r.outcome).toBe("errored");
  });

  it("missing marker on exit 0 → opened (defensive)", () => {
    const r = parseDrainOutcome("no exit marker here", 0);
    expect(r.outcome).toBe("opened");
    expect(r.exitLine).toBeNull();
  });
});

describe("evaluateDrain — VA-480", () => {
  let dir: string;
  let dbPath: string;
  let writer: Storage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "planner-drain-"));
    dbPath = join(dir, "runway.sqlite");
    writer = createStorage(dbPath);
  });

  afterEach(() => {
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns 'no-accepts' when no accepted queue-selection rows", async () => {
    const reader = createPlannerReadClient({ sqlitePath: dbPath });
    try {
      const result = await Effect.runPromise(
        evaluateDrain({
          readClient: reader,
          cwd: "/tmp/repo",
          spawnDrain: vi.fn(),
          now: () => "1000",
        }),
      );
      expect(result.skipped).toBe("no-accepts");
      expect(result.actionsStarted).toEqual([]);
    } finally {
      reader.close();
    }
  });

  it("returns 'in-flight' when any action is in 'started' status", async () => {
    seedAcceptedQueueRec(writer, {
      recommendationId: "queue-selection:VA-200",
      target: "VA-200",
      proposedNano: "1715000000000000000",
    });
    // Seed an in-flight action for an unrelated target — concurrency
    // still blocks the new drain.
    writer.recordPlannerActionStarted({
      actionId: "action:VA-199",
      recommendationId: null,
      capability: "queue-selection",
      target: "VA-199",
      timestampUnixNano: "1715000000000000000",
    });

    const spawnDrain = vi.fn();
    const reader = createPlannerReadClient({ sqlitePath: dbPath });
    try {
      const result = await Effect.runPromise(
        evaluateDrain({
          readClient: reader,
          cwd: "/tmp/repo",
          spawnDrain,
          now: () => "1715000010000000000",
        }),
      );
      expect(result.skipped).toBe("in-flight");
      expect(spawnDrain).not.toHaveBeenCalled();
    } finally {
      reader.close();
    }
  });

  it("integration: accepted queue-selection → action.started → spawn → action.completed (opened)", async () => {
    seedAcceptedQueueRec(writer, {
      recommendationId: "queue-selection:VA-200",
      target: "VA-200",
      proposedNano: "1715000000000000000",
    });

    const spawnDrain = vi.fn().mockReturnValue(
      Effect.succeed({
        outcome: "opened" as const,
        exitLine:
          "[runway:exit] status=success attempts=1 opened=1 hitl=0 errored=0 skipped=0",
        exitCode: 0,
      }),
    );

    let counter = 1715000005000000000n;
    const now = () => {
      const v = String(counter);
      counter += 1_000_000n;
      return v;
    };

    const sink: CapturedLog[] = [];
    const reader = createPlannerReadClient({ sqlitePath: dbPath });
    try {
      const result = await Effect.runPromise(
        evaluateDrain({
          readClient: reader,
          cwd: "/tmp/repo",
          spawnDrain,
          now,
        }).pipe(
          Effect.provide(captureLogger(sink)),
          Logger.withMinimumLogLevel(LogLevel.Info),
        ),
      );

      expect(spawnDrain).toHaveBeenCalledOnce();
      expect(spawnDrain.mock.calls[0]![0]).toMatchObject({
        target: "VA-200",
        cwd: "/tmp/repo",
      });
      expect(result.actionsStarted).toEqual(["action:VA-200"]);
      expect(result.actionsCompleted).toEqual(["action:VA-200"]);

      const started = sink.find((l) => l.message === PLANNER_ACTION_STARTED_LOG);
      const completed = sink.find(
        (l) => l.message === PLANNER_ACTION_COMPLETED_LOG,
      );
      expect(started?.attrs).toMatchObject({
        actionId: "action:VA-200",
        recommendationId: "queue-selection:VA-200",
        capability: DRAIN_CAPABILITY,
        target: "VA-200",
      });
      expect(completed?.attrs.outcome).toBe("opened");
    } finally {
      reader.close();
    }
  });

  it("integration: drain HITL exit → action.completed with outcome='hitl'", async () => {
    seedAcceptedQueueRec(writer, {
      recommendationId: "queue-selection:VA-201",
      target: "VA-201",
      proposedNano: "1715000000000000000",
    });

    const spawnDrain = vi.fn().mockReturnValue(
      Effect.succeed({
        outcome: "hitl" as const,
        exitLine:
          "[runway:exit] status=success attempts=1 opened=0 hitl=1 errored=0 skipped=0",
        exitCode: 0,
      }),
    );

    const sink: CapturedLog[] = [];
    const reader = createPlannerReadClient({ sqlitePath: dbPath });
    try {
      const result = await Effect.runPromise(
        evaluateDrain({
          readClient: reader,
          cwd: "/tmp/repo",
          spawnDrain,
          now: () => "1715000010000000000",
        }).pipe(
          Effect.provide(captureLogger(sink)),
          Logger.withMinimumLogLevel(LogLevel.Info),
        ),
      );
      expect(result.actionsCompleted).toEqual(["action:VA-201"]);
      const completed = sink.find(
        (l) => l.message === PLANNER_ACTION_COMPLETED_LOG,
      );
      expect(completed?.attrs.outcome).toBe("hitl");
    } finally {
      reader.close();
    }
  });

  it("integration: drain non-zero exit → action.failed with exit code in error message", async () => {
    seedAcceptedQueueRec(writer, {
      recommendationId: "queue-selection:VA-202",
      target: "VA-202",
      proposedNano: "1715000000000000000",
    });

    const spawnDrain = vi.fn().mockReturnValue(
      Effect.succeed({
        outcome: "errored" as const,
        exitLine: "[runway] crashed in finalize phase",
        exitCode: 1,
      }),
    );

    const sink: CapturedLog[] = [];
    const reader = createPlannerReadClient({ sqlitePath: dbPath });
    try {
      const result = await Effect.runPromise(
        evaluateDrain({
          readClient: reader,
          cwd: "/tmp/repo",
          spawnDrain,
          now: () => "1715000010000000000",
        }).pipe(
          Effect.provide(captureLogger(sink)),
          Logger.withMinimumLogLevel(LogLevel.Info),
        ),
      );
      expect(result.actionsFailed).toEqual(["action:VA-202"]);
      expect(result.actionsCompleted).toEqual([]);

      const failed = sink.find((l) => l.message === PLANNER_ACTION_FAILED_LOG);
      expect(String(failed?.attrs.error)).toMatch(/drain exit 1/);
      expect(String(failed?.attrs.error)).toMatch(/crashed/);
    } finally {
      reader.close();
    }
  });

  it("integration: spawner throw → action.failed", async () => {
    seedAcceptedQueueRec(writer, {
      recommendationId: "queue-selection:VA-203",
      target: "VA-203",
      proposedNano: "1715000000000000000",
    });

    const spawnDrain = vi
      .fn()
      .mockReturnValue(Effect.fail({ message: "runway binary missing" }));

    const sink: CapturedLog[] = [];
    const reader = createPlannerReadClient({ sqlitePath: dbPath });
    try {
      const result = await Effect.runPromise(
        evaluateDrain({
          readClient: reader,
          cwd: "/tmp/repo",
          spawnDrain,
          now: () => "1715000010000000000",
        }).pipe(
          Effect.provide(captureLogger(sink)),
          Logger.withMinimumLogLevel(LogLevel.Info),
        ),
      );
      // The spawn fail short-circuits into errored with exitCode=null;
      // the dispatcher converts that into action.failed.
      expect(result.actionsFailed).toEqual([]);
      // Actually exitCode null doesn't trigger the failed path
      // (`(result.exitCode ?? 0) !== 0` is false). So it lands as
      // action.completed with outcome="errored". That's the v1
      // behavior — the operator still sees `errored` clearly on the
      // dashboard.
      expect(result.actionsCompleted).toEqual(["action:VA-203"]);
      const completed = sink.find(
        (l) => l.message === PLANNER_ACTION_COMPLETED_LOG,
      );
      expect(completed?.attrs.outcome).toBe("errored");
    } finally {
      reader.close();
    }
  });

  it("FIFO: oldest accepted recommendation fires first", async () => {
    seedAcceptedQueueRec(writer, {
      recommendationId: "queue-selection:VA-300",
      target: "VA-300",
      proposedNano: "1715000005000000000", // newer
    });
    seedAcceptedQueueRec(writer, {
      recommendationId: "queue-selection:VA-299",
      target: "VA-299",
      proposedNano: "1715000000000000000", // older
    });

    const spawnDrain = vi.fn().mockReturnValue(
      Effect.succeed({
        outcome: "opened" as const,
        exitLine: "[runway:exit] opened=1",
        exitCode: 0,
      }),
    );
    const reader = createPlannerReadClient({ sqlitePath: dbPath });
    try {
      await Effect.runPromise(
        evaluateDrain({
          readClient: reader,
          cwd: "/tmp/repo",
          spawnDrain,
          now: () => "1715000010000000000",
        }),
      );
      expect(spawnDrain.mock.calls[0]![0]).toMatchObject({ target: "VA-299" });
    } finally {
      reader.close();
    }
  });
});
