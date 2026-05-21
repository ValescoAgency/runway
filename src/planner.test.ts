import {
  Deferred,
  Effect,
  Fiber,
  HashMap,
  Layer,
  Logger,
  LogLevel,
  Option,
  Ref,
  TestClock,
  TestContext,
} from "effect";
import { describe, expect, it } from "vitest";
import { makeConfigLive } from "./config.js";
import {
  PLANNER_BOOT_LOG,
  PLANNER_SHUTDOWN_LOG,
  PLANNER_TICK_LOG,
  installSignalHandlers,
  makeOneTick,
  makePlannerLoop,
  makePlannerState,
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
  it("emits a planner.tick log with tickNumber + wallClockSinceStartSeconds and updates the state ref", async () => {
    const sink: CapturedLog[] = [];
    const startMs = Date.now() - 5_000; // pretend planner started 5s ago
    const program = Effect.gen(function* () {
      const stateRef = yield* makePlannerState(startMs);
      yield* makeOneTick(stateRef, startMs);
      yield* makeOneTick(stateRef, startMs);
      // Read final state from the same ref so we exercise the
      // shared-state path the HTTP /planner/health endpoint relies on.
      return yield* Ref.get(stateRef);
    }).pipe(
      Effect.provide(makeCapturingLogger(sink)),
      Logger.withMinimumLogLevel(LogLevel.Info),
    );

    const finalState = await Effect.runPromise(program);
    expect(finalState.tickCount).toBe(2);
    expect(finalState.lastTickAtUnixMs).not.toBeNull();
    expect(finalState.startMs).toBe(startMs);

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
      const stateRef = yield* makePlannerState(Date.now());

      // Spawn the loop, then trip the shutdown shortly after — gives
      // it time to emit boot + the first immediate tick.
      const fiber = yield* Effect.fork(makePlannerLoop(shutdown, stateRef));
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

  // VA-473 scope: tick-cadence under TestClock. The pattern mirrors
  // gateway-policy.test.ts: fork the loop, advance virtual time, then
  // resolve the shutdown deferred and join. With `Schedule.spaced`
  // the first tick fires at t=0 and subsequent ticks at t=N, t=2N, ...
  it("ticks at the configured cadence under TestClock", async () => {
    const sink: CapturedLog[] = [];
    const program = Effect.gen(function* () {
      const shutdown = yield* Deferred.make<void>();
      const stateRef = yield* makePlannerState(Date.now());
      const fiber = yield* Effect.fork(makePlannerLoop(shutdown, stateRef));

      // tickSeconds=1 (HermeticConfig). At t=0 the immediate tick fires.
      // Advancing 3s should produce 3 additional ticks (t=1,2,3).
      yield* TestClock.adjust("3 seconds");

      yield* Deferred.succeed(shutdown, void 0);
      yield* Fiber.join(fiber);
    }).pipe(
      Effect.provide(HermeticConfig),
      Effect.provide(makeCapturingLogger(sink)),
      Effect.provide(TestContext.TestContext),
      Logger.withMinimumLogLevel(LogLevel.Info),
    );

    await Effect.runPromise(program);

    const ticks = sink.filter((l) => l.message === PLANNER_TICK_LOG);
    // Immediate t=0 tick + ticks at t=1,2,3 = 4. Tolerate ±1 for the
    // exact moment Deferred.succeed wins the race vs the next tick.
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.length).toBeLessThanOrEqual(5);

    // Verify monotonic tickNumber attribution.
    const tickNumbers = ticks.map((l) => Number(l.attrs.tickNumber));
    expect(tickNumbers).toEqual([...tickNumbers].sort((a, b) => a - b));
    expect(tickNumbers[0]).toBe(1);

    expect(sink.map((l) => l.message)).toContain(PLANNER_SHUTDOWN_LOG);
  });
});

describe("installSignalHandlers", () => {
  // VA-473 scope: SIGINT path. Verifies that the handler installed
  // via `process.on("SIGINT", ...)` resolves the shutdown Deferred.
  // We invoke the handler directly (rather than emitting via
  // `process.emit`) so the test is hermetic — no chance of stray
  // signal listeners from vitest catching it.
  it("registers SIGINT + SIGTERM handlers that resolve the shutdown deferred", async () => {
    const program = Effect.gen(function* () {
      const shutdown = yield* Deferred.make<void>();
      const beforeSigint = process.listeners("SIGINT").length;
      const beforeSigterm = process.listeners("SIGTERM").length;

      yield* installSignalHandlers(shutdown);

      // Both signals should have one additional listener.
      const sigintListeners = process.listeners("SIGINT");
      const sigtermListeners = process.listeners("SIGTERM");
      expect(sigintListeners.length).toBe(beforeSigint + 1);
      expect(sigtermListeners.length).toBe(beforeSigterm + 1);

      // The installed handler is the most-recently-added listener.
      // Invoke it as Node would on a SIGINT.
      const handler = sigintListeners[sigintListeners.length - 1] as (
        sig: NodeJS.Signals,
      ) => void;
      handler("SIGINT");

      // The handler runs `Effect.runPromise(Deferred.succeed(...))`
      // fire-and-forget. Race the await against a short virtual
      // timeout — if the handler worked, the deferred wins immediately.
      const winner: "shutdown" | "timeout" = yield* Effect.race(
        Deferred.await(shutdown).pipe(Effect.as("shutdown" as const)),
        Effect.sleep("500 millis").pipe(Effect.as("timeout" as const)),
      );
      expect(winner).toBe("shutdown");

      // Deferred should now be done.
      const done = yield* Deferred.poll(shutdown);
      expect(Option.isSome(done)).toBe(true);
    }).pipe(Effect.scoped);

    await Effect.runPromise(program);
  });

  it("removes listeners on scope close", async () => {
    const beforeSigint = process.listeners("SIGINT").length;
    const beforeSigterm = process.listeners("SIGTERM").length;

    const program = Effect.gen(function* () {
      const shutdown = yield* Deferred.make<void>();
      yield* installSignalHandlers(shutdown);
      // While inside the scope, listener counts are +1 — asserted in
      // the previous test. Here we exit the scope and confirm the
      // acquireRelease finalizer ran.
    }).pipe(Effect.scoped);

    await Effect.runPromise(program);

    expect(process.listeners("SIGINT").length).toBe(beforeSigint);
    expect(process.listeners("SIGTERM").length).toBe(beforeSigterm);
  });
});
