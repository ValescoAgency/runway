import {
  Deferred,
  Duration,
  Effect,
  Ref,
  Schedule,
  type Scope,
} from "effect";
import { ConfigTag } from "./config.js";
import {
  CI_CAPABILITY,
  evaluateCi,
  type CiCapabilityContext,
} from "./planner-ci.js";
import {
  evaluateMergeability,
  MERGEABILITY_CAPABILITY,
  type MergeabilityCapabilityContext,
} from "./planner-mergeability.js";
import type { PlannerHealth } from "./planner-http.js";
import {
  evaluateQueueSelection,
  type QueueSelectionContext,
} from "./planner-queue-selection.js";

/**
 * VA-473: planner daemon — long-running host process that will own
 * queue selection (VA-476) and cross-PR shepherding (VA-477..479) per
 * ADR 0004. Sub-1 ships the bare scaffold: a tick loop emitting a
 * `planner.tick` heartbeat marker. Capabilities arrive in later
 * sub-issues; the tick body here is intentionally empty.
 *
 * The loop is structured so each capability later becomes a sequential
 * step inside `oneTick` — that's the planner's deterministic
 * state-machine pattern from ADR 0004 § Smartness (Level 1).
 *
 * Shutdown is signal-driven: SIGINT / SIGTERM resolves a `Deferred`
 * the main race awaits, so the loop is interrupted cooperatively and
 * the surrounding `Effect.scoped` finalizers (TelemetryLive's OTLP
 * flush) run before the process exits.
 */

export interface PlannerRuntime {
  readonly tickSeconds: number;
  readonly host: string;
  readonly port: number;
}

/**
 * VA-475: shared mutable state the HTTP health endpoint reads while
 * the tick loop writes. Lives in a Ref so reads + writes are
 * concurrency-safe across the Effect runtime.
 */
export interface PlannerStateSnapshot {
  readonly tickCount: number;
  readonly lastTickAtUnixMs: number | null;
  readonly startMs: number;
}

export const makePlannerState = (
  startMs: number,
): Effect.Effect<Ref.Ref<PlannerStateSnapshot>> =>
  Ref.make<PlannerStateSnapshot>({
    tickCount: 0,
    lastTickAtUnixMs: null,
    startMs,
  });

/**
 * Build a health-snapshot getter usable from the non-Effect HTTP
 * handler context. Captures a synchronous `Ref.unsafeGet` so the
 * handler can resolve health without invoking the Effect runtime
 * per request.
 */
export const makeHealthReader =
  (
    stateRef: Ref.Ref<PlannerStateSnapshot>,
    version: string,
  ): (() => PlannerHealth) =>
  () => {
    const snap = Effect.runSync(Ref.get(stateRef));
    return {
      uptimeSeconds: Math.floor((Date.now() - snap.startMs) / 1000),
      tickCount: snap.tickCount,
      lastTickAtUnixMs: snap.lastTickAtUnixMs,
      version,
    };
  };

export const PLANNER_BOOT_LOG = "planner.boot";
export const PLANNER_TICK_LOG = "planner.tick";
export const PLANNER_SHUTDOWN_LOG = "planner.shutdown";

/**
 * VA-476: capabilities are bundled into a single `PlannerCapabilities`
 * object the loop dispatches each tick. Each entry is optional so
 * the foundation tests (no SQLite, no Linear) can run with an empty
 * bag, and later sub-issues (VA-477..479) just slot more entries in.
 */
export interface PlannerCapabilities {
  readonly queueSelection?: QueueSelectionContext;
  readonly mergeability?: MergeabilityCapabilityContext;
  readonly ci?: CiCapabilityContext;
}

/**
 * One tick of the planner loop. Emits the heartbeat marker, updates
 * the shared `PlannerStateSnapshot`, then dispatches each capability
 * sequentially. Capability errors are caught + logged — one
 * capability's failure must not poison the loop.
 *
 * VA-475: writes through to the shared state so the HTTP health
 * endpoint sees fresh tickCount + lastTickAtUnixMs after each tick.
 *
 * VA-476: invokes queue-selection when configured.
 */
export const makeOneTick = (
  stateRef: Ref.Ref<PlannerStateSnapshot>,
  startMs: number,
  capabilities: PlannerCapabilities = {},
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const updated = yield* Ref.updateAndGet(stateRef, (s) => ({
      ...s,
      tickCount: s.tickCount + 1,
      lastTickAtUnixMs: Date.now(),
    }));
    const wallClockSinceStartSeconds = Math.floor(
      (Date.now() - startMs) / 1000,
    );
    yield* Effect.logInfo(PLANNER_TICK_LOG).pipe(
      Effect.annotateLogs({
        tickNumber: updated.tickCount,
        wallClockSinceStartSeconds,
      }),
    );

    if (capabilities.queueSelection) {
      yield* evaluateQueueSelection(capabilities.queueSelection).pipe(
        // A capability throw stays local — log it as a structured
        // error and continue. The alternative (whole-loop crash) is
        // worse: a stale linear_snapshots row would take down the
        // entire planner.
        Effect.catchAllCause((cause) =>
          Effect.logError("planner.capability.error").pipe(
            Effect.annotateLogs({
              capability: "queue-selection",
              cause: cause.toString(),
            }),
          ),
        ),
      );
    }

    if (capabilities.mergeability) {
      // VA-477: mergeability capability already catches per-PR
      // failures internally, but a higher-level guard here keeps the
      // tick alive if `listOpenShepherdedPrs` itself throws (e.g.,
      // SQLite I/O error).
      yield* evaluateMergeability(capabilities.mergeability).pipe(
        Effect.catchAllCause((cause) =>
          Effect.logError("planner.capability.error").pipe(
            Effect.annotateLogs({
              capability: MERGEABILITY_CAPABILITY,
              cause: cause.toString(),
            }),
          ),
        ),
      );
    }

    if (capabilities.ci) {
      // VA-478: CI capability has the same per-PR error containment
      // as mergeability. Outer guard catches projection-side failures.
      yield* evaluateCi(capabilities.ci).pipe(
        Effect.catchAllCause((cause) =>
          Effect.logError("planner.capability.error").pipe(
            Effect.annotateLogs({
              capability: CI_CAPABILITY,
              cause: cause.toString(),
            }),
          ),
        ),
      );
    }
  });

/**
 * The planner's main loop as an Effect. Resolves when the
 * `shutdownSignal` deferred is resolved (race against the infinite
 * tick stream). Returns `void` on graceful shutdown.
 *
 * The schedule is `Schedule.spaced` (sleep AFTER work) rather than
 * `Schedule.fixed` (sleep at fixed wall-clock intervals) — if a future
 * capability tick body takes longer than `tickSeconds`, we don't want
 * back-pressure to compound into a thundering herd.
 */
export const makePlannerLoop = (
  shutdownSignal: Deferred.Deferred<void>,
  stateRef: Ref.Ref<PlannerStateSnapshot>,
  capabilities: PlannerCapabilities = {},
): Effect.Effect<void, never, ConfigTag> =>
  Effect.gen(function* () {
    const config = yield* ConfigTag;
    const runtime: PlannerRuntime = {
      tickSeconds: config.plannerTickSeconds,
      host: config.plannerHost,
      port: config.plannerPort,
    };

    yield* Effect.logInfo(PLANNER_BOOT_LOG).pipe(
      Effect.annotateLogs({
        tickSeconds: runtime.tickSeconds,
        host: runtime.host,
        port: runtime.port,
        capabilities: Object.keys(capabilities).filter(
          (k) => capabilities[k as keyof PlannerCapabilities] !== undefined,
        ).join(",") || "(none)",
      }),
    );

    const initialState = yield* Ref.get(stateRef);
    const startMs = initialState.startMs;

    const tickStream = makeOneTick(stateRef, startMs, capabilities).pipe(
      Effect.repeat(
        Schedule.spaced(Duration.seconds(runtime.tickSeconds)),
      ),
      Effect.asVoid,
    );

    yield* Effect.race(tickStream, Deferred.await(shutdownSignal));

    const finalState = yield* Ref.get(stateRef);
    yield* Effect.logInfo(PLANNER_SHUTDOWN_LOG).pipe(
      Effect.annotateLogs({
        totalTicks: finalState.tickCount,
      }),
    );
  });

/**
 * Wire OS signals (SIGINT / SIGTERM) to resolve the shutdown
 * deferred so the planner loop exits cooperatively. Returns a
 * scoped Effect — the handlers are torn down on scope close so a
 * second `Effect.runPromise` in tests doesn't accumulate listeners.
 */
export const installSignalHandlers = (
  shutdownSignal: Deferred.Deferred<void>,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const handler = (): void => {
        // Fire-and-forget; the planner loop is awaiting this deferred.
        void Effect.runPromise(Deferred.succeed(shutdownSignal, void 0));
      };
      process.on("SIGINT", handler);
      process.on("SIGTERM", handler);
      return handler;
    }),
    (handler) =>
      Effect.sync(() => {
        process.off("SIGINT", handler);
        process.off("SIGTERM", handler);
      }),
  ).pipe(Effect.asVoid);
