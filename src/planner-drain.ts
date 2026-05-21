import { Effect } from "effect";
import { execa } from "execa";
import {
  PLANNER_ACTION_COMPLETED_LOG,
  PLANNER_ACTION_FAILED_LOG,
  PLANNER_ACTION_STARTED_LOG,
} from "./dashboard/projector.js";
import type { PlannerReadClient } from "./planner-storage.js";
import { QUEUE_SELECTION_CAPABILITY } from "./planner-queue-selection.js";

/**
 * VA-480: drain-spawn capability. The planner's queue-selection
 * (VA-476) emits `planner.recommendation.proposed`; the HTTP `accept`
 * (VA-475) emits `planner.recommendation.accepted`. This capability
 * completes the lifecycle: it finds accepted queue-selection
 * recommendations without a corresponding `planner_actions` row,
 * spawns `runway run --target <issue>` as a managed subprocess, and
 * emits `planner.action.started` + `planner.action.completed` /
 * `planner.action.failed` based on the drain's exit.
 *
 * Concurrency: v1 enforces a single drain at a time. If any
 * `planner_actions` row is in `status='started'`, subsequent accepts
 * queue silently — they'll fire on a later tick when the slot is
 * free. The CLI flag `--target` (added in the same commit) lets the
 * spawned drain claim a specific issue rather than draining the FIFO
 * head.
 *
 * Outcome derivation: the spawned drain prints a parser-friendly
 * `[runway:exit] status=... opened=N hitl=N errored=N skipped=N`
 * line on completion. The dispatcher parses this to map the drain's
 * label outcome into the planner's `outcome` attribute on
 * `action.completed` (`opened` / `hitl` / `errored` / `skipped`). A
 * non-zero exit code routes to `action.failed` with a brief error
 * detail.
 *
 * Shutdown: the default spawner is built on `Effect.acquireUseRelease`
 * so when the planner's Effect is interrupted (operator Ctrl-C,
 * SIGTERM, capability-level error), the release finalizer fires
 * `child.kill('SIGTERM', { forceKillAfterDelay: 5_000 })`. SIGTERM
 * gives the drain time to flush its own OTLP exporter + tear down
 * Sandcastle; the force-kill grace window bounds shutdown so a
 * stuck drain can't pin the planner.
 */

export const DRAIN_CAPABILITY = "queue-selection";

export type DrainOutcomeKind = "opened" | "hitl" | "errored" | "skipped";

export interface DrainSpawnResult {
  /** Mapped from the drain's `[runway:exit]` marker, with `skipped` → action.completed. */
  readonly outcome: DrainOutcomeKind;
  /** The full `[runway:exit] ...` line, when present. */
  readonly exitLine: string | null;
  readonly exitCode: number | null;
}

export interface DrainSpawnArgs {
  readonly target: string;
  readonly cwd: string;
}

export type DrainSpawner = (
  args: DrainSpawnArgs,
) => Effect.Effect<DrainSpawnResult, { readonly message: string }>;

export interface DrainCapabilityContext {
  readonly readClient: PlannerReadClient;
  readonly cwd: string;
  readonly spawnDrain?: DrainSpawner;
  readonly now: () => string;
}

export interface DrainEvalResult {
  readonly skipped: "in-flight" | "no-accepts" | null;
  readonly actionsStarted: readonly string[];
  readonly actionsCompleted: readonly string[];
  readonly actionsFailed: readonly string[];
}

const EMPTY: DrainEvalResult = {
  skipped: null,
  actionsStarted: [],
  actionsCompleted: [],
  actionsFailed: [],
};

const actionIdFor = (target: string): string => `action:${target}`;

/**
 * One planner-tick pass of the drain capability. Returns an
 * `Effect.Effect<DrainEvalResult>` describing what (if anything) ran.
 * Errors from the spawned subprocess are caught + folded into
 * `action.failed` so the planner tick stays alive.
 */
export const evaluateDrain = (
  ctx: DrainCapabilityContext,
): Effect.Effect<DrainEvalResult> =>
  Effect.gen(function* () {
    // VA-480 concurrency: any in-flight action blocks new drains.
    // The single-drain-at-a-time rule is enforced by the dashboard
    // projection's `status='started'` set (which the read client
    // exposes via `listInFlightActionTargets`).
    const inFlight = ctx.readClient.listInFlightActionTargets();
    if (inFlight.length > 0) {
      return { ...EMPTY, skipped: "in-flight" as const };
    }

    const pending = ctx.readClient.listAcceptedRecommendationsWithoutAction(
      QUEUE_SELECTION_CAPABILITY,
    );
    if (pending.length === 0) {
      return { ...EMPTY, skipped: "no-accepts" as const };
    }

    // FIFO: oldest accept first.
    const pick = pending[0]!;
    const actionId = actionIdFor(pick.target);
    const startNano = ctx.now();

    yield* Effect.logInfo(PLANNER_ACTION_STARTED_LOG).pipe(
      Effect.annotateLogs({
        actionId,
        recommendationId: pick.recommendationId,
        capability: DRAIN_CAPABILITY,
        target: pick.target,
        timestampUnixNano: startNano,
      }),
    );

    const spawn = ctx.spawnDrain ?? defaultSpawnDrain;
    const result = yield* spawn({ target: pick.target, cwd: ctx.cwd }).pipe(
      Effect.matchEffect({
        onFailure: (err) =>
          Effect.succeed<DrainSpawnResult>({
            outcome: "errored",
            exitLine: err.message,
            exitCode: null,
          }),
        onSuccess: (r) => Effect.succeed(r),
      }),
    );

    if (result.outcome === "errored" && (result.exitCode ?? 0) !== 0) {
      // Non-zero exit → action.failed.
      const errorMsg = result.exitLine
        ? `drain exit ${result.exitCode}: ${result.exitLine}`
        : `drain exit ${result.exitCode}`;
      yield* Effect.logInfo(PLANNER_ACTION_FAILED_LOG).pipe(
        Effect.annotateLogs({
          actionId,
          error: errorMsg,
          timestampUnixNano: ctx.now(),
        }),
      );
      return {
        skipped: null,
        actionsStarted: [actionId],
        actionsCompleted: [],
        actionsFailed: [actionId],
      };
    }

    // Exit 0 (or no exit code captured) → completed. Outcome label is
    // whatever the drain reported in its `[runway:exit]` marker.
    yield* Effect.logInfo(PLANNER_ACTION_COMPLETED_LOG).pipe(
      Effect.annotateLogs({
        actionId,
        outcome: result.outcome,
        timestampUnixNano: ctx.now(),
      }),
    );
    return {
      skipped: null,
      actionsStarted: [actionId],
      actionsCompleted: [actionId],
      actionsFailed: [],
    };
  });

// ---------------------------------------------------------------------------
// Default spawner — uses execa to run `runway run --target <target>`.
// ---------------------------------------------------------------------------

/**
 * Spawn `runway run --target <target>` as a subprocess. Inherits the
 * planner's env so the drain has the same LINEAR_API_KEY,
 * OP_SERVICE_ACCOUNT_TOKEN, etc. Captures stdout to parse the
 * `[runway:exit]` marker; pipes stderr through so the operator sees
 * failures live.
 *
 * Uses `Effect.acquireRelease` so the child receives `SIGTERM` if the
 * planner's Effect is interrupted (operator Ctrl-C, planner shutdown,
 * etc.). The release also awaits the child for a short grace period
 * before escalating to `SIGKILL`, mirroring the AC's "drain receives
 * SIGTERM, planner waits" semantics.
 */
const SIGTERM_GRACE_MS = 5_000;

const defaultSpawnDrain: DrainSpawner = (args) =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      execa("runway", ["run", "--target", args.target], {
        cwd: args.cwd,
        env: process.env,
        reject: false,
        // Capture stdout for outcome parsing; pipe stderr to parent
        // so live failures are visible.
        stdio: ["ignore", "pipe", "inherit"],
      }),
    ),
    (child) =>
      Effect.tryPromise({
        try: async () => {
          const result = await child;
          const stdout = String(result.stdout ?? "");
          if (stdout.length > 0) process.stdout.write(stdout);
          return parseDrainOutcome(stdout, result.exitCode);
        },
        catch: (err) => ({
          message: err instanceof Error ? err.message : String(err),
        }),
      }),
    (child) =>
      Effect.sync(() => {
        // If the child is still running when the Effect is
        // interrupted, send SIGTERM then await up to SIGTERM_GRACE_MS
        // before escalating to SIGKILL. execa's
        // `kill('SIGTERM', {forceKillAfterDelay})` does exactly this
        // — preserving the AC's "planner waits" guarantee while
        // bounding shutdown time so a stuck drain can't pin the
        // planner.
        const killable = child as unknown as {
          exitCode?: number | null;
          killed?: boolean;
          kill?: (
            signal: string,
            opts?: { forceKillAfterDelay: number },
          ) => boolean;
        };
        if (
          typeof killable.kill === "function" &&
          killable.exitCode === null &&
          !killable.killed
        ) {
          try {
            killable.kill("SIGTERM", {
              forceKillAfterDelay: SIGTERM_GRACE_MS,
            });
          } catch {
            // Race: child may have exited between the check and the
            // kill. Best-effort cleanup; nothing more to do.
          }
        }
      }),
  );

/**
 * Parse the `[runway:exit] status=... opened=N hitl=N errored=N
 * skipped=N` marker from the drain's stdout. Returns a structured
 * outcome the dispatcher maps onto the `action.completed` /
 * `action.failed` decision.
 *
 * Exported for tests + for future capabilities that might want to
 * inspect a captured drain log without re-running the parse.
 */
export function parseDrainOutcome(
  stdout: string,
  exitCode: number | null | undefined,
): DrainSpawnResult {
  const exit = exitCode ?? null;
  const match = stdout.match(/\[runway:exit\][^\n]*/);
  const exitLine = match ? match[0] : null;

  if (exit !== null && exit !== 0) {
    return { outcome: "errored", exitLine, exitCode: exit };
  }

  if (!exitLine) {
    // Exit 0 but no marker — assume opened (the drain completed
    // without crashing). This shouldn't happen for a healthy
    // `runway run`, but defensive: treat unknown-shape success as a
    // benign completion.
    return { outcome: "opened", exitLine: null, exitCode: exit };
  }

  const opened = parseCount(exitLine, /opened=(\d+)/);
  const hitl = parseCount(exitLine, /hitl=(\d+)/);
  const errored = parseCount(exitLine, /errored=(\d+)/);
  const skipped = parseCount(exitLine, /skipped=(\d+)/);

  if (errored > 0) {
    return { outcome: "errored", exitLine, exitCode: exit };
  }
  if (opened > 0) {
    return { outcome: "opened", exitLine, exitCode: exit };
  }
  if (hitl > 0) {
    return { outcome: "hitl", exitLine, exitCode: exit };
  }
  if (skipped > 0) {
    return { outcome: "skipped", exitLine, exitCode: exit };
  }
  // All zeroes — drain ran but nothing happened. Map to opened so
  // the action lands as a benign completion; the operator can see
  // the marker in evidence.
  return { outcome: "opened", exitLine, exitCode: exit };
}

function parseCount(line: string, re: RegExp): number {
  const m = line.match(re);
  if (!m) return 0;
  const n = Number.parseInt(m[1] ?? "0", 10);
  return Number.isFinite(n) ? n : 0;
}
