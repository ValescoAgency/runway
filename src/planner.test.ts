import {
  Deferred,
  Effect,
  HashMap,
  Layer,
  Logger,
  LogLevel,
  Ref,
} from "effect";
import { describe, expect, it } from "vitest";
import { ConfigTag, makeConfigLive } from "./config.js";
import {
  PLANNER_BOOT_LOG,
  PLANNER_SHUTDOWN_LOG,
  PLANNER_TICK_LOG,
  makeOneTick,
  makePlannerLoop,
} from "./planner.js";

interface CapturedLog {
  readonly level: string;
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
      sink.push({ level: options.logLevel.label, message: msg, attrs });
    }),
  );

// Hermetic config layer — bypasses host env (RUNWAY_PLANNER_*).
const HermeticConfig = makeConfigLive({
  LINEAR_API_KEY: "test-key",
  RUNWAY_LINEAR_TEAM: "VA",
  RUNWAY_PLANNER_TICK_SECONDS: "1",
  RUNWAY_PLANNER_HOST: "127.0.0.1",
  RUNWAY_PLANNER_PORT: "3002",
});

describe("makeOneTick", () => {
  it("emits a planner.tick log with tickNumber + wallClockSinceStartSeconds", async () => {
    const sink: CapturedLog[] = [];
    const program = Effect.gen(function* () {
      const tickRef = yield* Ref.make(0);
      const startMs = Date.now() - 5_000; // pretend planner started 5s ago
      yield* makeOneTick(tickRef, startMs);
      yield* makeOneTick(tickRef, startMs);
      return yield* Ref.get(tickRef);
    }).pipe(
      Effect.provide(makeCapturingLogger(sink)),
      Logger.withMinimumLogLevel(LogLevel.Info),
    );

    const total = await Effect.runPromise(program);
    expect(total).toBe(2);

    const tickLogs = sink.filter((l) => l.message === PLANNER_TICK_LOG);
    expect(tickLogs).toHaveLength(2);
    expect(tickLogs[0]?.attrs.tickNumber).toBe(1);
    expect(tickLogs[1]?.attrs.tickNumber).toBe(2);
    // The first tick was emitted at roughly startMs + 5s, so the
    // wall-clock attribute should be >= 5. Tolerate small jitter.
    expect(
      Number(tickLogs[0]?.attrs.wallClockSinceStartSeconds),
    ).toBeGreaterThanOrEqual(5);
  });
});

describe("makePlannerLoop", () => {
  it("emits boot + at least one tick before honoring a shutdown signal", async () => {
    const sink: CapturedLog[] = [];
    const program = Effect.gen(function* () {
      const shutdown = yield* Deferred.make<void>();

      // Spawn the loop, then trip the shutdown shortly after — gives
      // it time to emit boot + the first immediate tick.
      const fiber = yield* Effect.fork(makePlannerLoop(shutdown));
      yield* Effect.sleep("100 millis");
      yield* Deferred.succeed(shutdown, void 0);
      yield* fiber.await;
    }).pipe(
      Effect.provide(HermeticConfig),
      Effect.provide(makeCapturingLogger(sink)),
      Logger.withMinimumLogLevel(LogLevel.Info),
    );

    await Effect.runPromise(program);

    const messages = sink.map((l) => l.message);
    expect(messages).toContain(PLANNER_BOOT_LOG);
    expect(messages).toContain(PLANNER_TICK_LOG);
    expect(messages).toContain(PLANNER_SHUTDOWN_LOG);

    const boot = sink.find((l) => l.message === PLANNER_BOOT_LOG);
    expect(boot?.attrs.tickSeconds).toBe(1);
    expect(boot?.attrs.host).toBe("127.0.0.1");
    expect(boot?.attrs.port).toBe(3002);

    const shutdownLog = sink.find((l) => l.message === PLANNER_SHUTDOWN_LOG);
    expect(Number(shutdownLog?.attrs.totalTicks)).toBeGreaterThanOrEqual(1);
  });
});
