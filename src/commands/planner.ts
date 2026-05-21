import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Deferred, Effect, Layer, Logger, Runtime } from "effect";
import { ConfigLive, ConfigTag } from "../config.js";
import {
  installSignalHandlers,
  makeHealthReader,
  makePlannerLoop,
  makePlannerState,
} from "../planner.js";
import {
  PLANNER_RECOMMENDATION_ACCEPTED_LOG,
  PLANNER_RECOMMENDATION_REJECTED_LOG,
} from "../dashboard/projector.js";
import {
  startPlannerHttpServer,
  type DecisionEmitter,
  type RunningPlannerHttpServer,
} from "../planner-http.js";
import { createPlannerReadClient } from "../planner-storage.js";
import { TelemetryLive } from "../telemetry.js";

/**
 * VA-473: `runway planner` subcommand. Sub-1 ships a single verb
 * (`run`) that boots the planner daemon in the foreground. launchd
 * (on a Mac mini) or systemd is expected to supervise restarts —
 * we don't reinvent process management.
 */

export interface PlannerOptions {
  readonly verb: "run";
}

export function printPlannerUsage(): void {
  console.log(`runway planner — long-running daemon for queue selection and PR shepherding

Sub-1 scaffold (VA-473): boots the tick loop with no capabilities wired.
Capabilities arrive in VA-474..VA-482 per ADR 0004.

USAGE
  runway planner run

VERBS
  run    Boot the planner in the foreground. Emits a planner.tick
         heartbeat each RUNWAY_PLANNER_TICK_SECONDS. SIGINT / SIGTERM
         triggers graceful shutdown (OTLP flush, then exit).

OPTIONS
  --help, -h    Show this help.

ENDPOINTS (VA-475)
  GET  /planner/health                                liveness probe
  GET  /planner/recommendations[?status=&limit=N]     list (status: proposed|accepted|rejected|all)
  GET  /planner/recommendations/:id                   single
  POST /planner/recommendations/:id/accept            emits accepted
  POST /planner/recommendations/:id/reject            emits rejected (requires { reason })
  GET  /planner/actions[?status=]                     list (status: started|completed|failed|all)

  Auth is network-layer (Tailscale ACLs). Same-origin-only CORS —
  browsers at a different origin are rejected; route through the
  dashboard's backend.

ENVIRONMENT
  RUNWAY_PLANNER_TICK_SECONDS   default 30 — tick cadence.
  RUNWAY_PLANNER_HOST           default 127.0.0.1 — HTTP bind host.
                                Set to a tailnet IP to expose the API
                                across your Tailscale network.
  RUNWAY_PLANNER_PORT           default 3002 — HTTP bind port.
  RUNWAY_PLANNER_SQLITE_PATH    optional — path to the dashboard's
                                SQLite file (the planner opens it
                                read-only). When unset, GET endpoints
                                return 503; POST endpoints still emit
                                OTLP (the dashboard validates on
                                receive).

  LINEAR_API_KEY                required (planner reads the queue).
  OTEL_EXPORTER_OTLP_ENDPOINT   optional — when set, planner emissions
                                stream to the dashboard's OTLP receiver.

SUPERVISION
  Mac mini operators: install the bundled launchd plist at
    ~/Library/LaunchAgents/com.valescoagency.runway-planner.plist
  (template ships at templates/com.valescoagency.runway-planner.plist
  in the runway package) and run \`launchctl load\` once. launchd
  restarts the planner on crash and on login.

REFERENCES
  ADR 0004 — Planner daemon architecture.
  Epic VA-472 — Planner daemon (replatform shepherd).
`);
}

export function parsePlannerArgs(argv: readonly string[]): PlannerOptions {
  if (argv.length === 0) {
    throw new Error(
      "missing verb — expected `run`. Run `runway planner --help`.",
    );
  }
  const [verbRaw, ...rest] = argv;
  if (verbRaw === "--help" || verbRaw === "-h") {
    printPlannerUsage();
    process.exit(0);
  }
  if (verbRaw !== "run") {
    throw new Error(
      `unknown verb "${verbRaw}" — expected \`run\`. Run \`runway planner --help\`.`,
    );
  }
  for (const arg of rest) {
    if (arg === "--help" || arg === "-h") {
      printPlannerUsage();
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { verb: "run" };
}

export async function plannerCommand(argv: readonly string[]): Promise<void> {
  parsePlannerArgs(argv);

  const LoggerLive =
    process.env.RUNWAY_JSON_LOGS === "1"
      ? Logger.replace(Logger.defaultLogger, Logger.jsonLogger)
      : Layer.empty;
  const MainLayer = Layer.mergeAll(ConfigLive, TelemetryLive, LoggerLive);

  const program = Effect.gen(function* () {
    const config = yield* ConfigTag;
    yield* Effect.logInfo(
      `[runway planner] boot host=${config.plannerHost} port=${config.plannerPort} tick=${config.plannerTickSeconds}s sqlite=${config.plannerSqlitePath ?? "(unset — GET endpoints will 503)"}`,
    );

    const shutdownSignal = yield* Deferred.make<void>();
    yield* installSignalHandlers(shutdownSignal);

    const stateRef = yield* makePlannerState(Date.now());

    // Capture the current runtime so the HTTP request handlers (which
    // are non-Effect functions) can fire-and-forget OTLP log emissions
    // through the same TelemetryLive layer the loop uses.
    const runtime = yield* Effect.runtime();
    const runFork = Runtime.runFork(runtime);
    const emitter: DecisionEmitter = makeDecisionEmitter(runFork);

    // Open the read-only SQLite client when configured. Absent path
    // is non-fatal — the daemon stays useful for POST endpoints (the
    // dashboard validates against its own storage on receive); GET
    // endpoints will return 503 with a clear remediation message.
    const readClient = yield* Effect.acquireRelease(
      Effect.sync(() =>
        config.plannerSqlitePath
          ? createPlannerReadClient({ sqlitePath: config.plannerSqlitePath })
          : null,
      ),
      (client) => Effect.sync(() => client?.close()),
    );

    const httpServer = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startPlannerHttpServer({
          host: config.plannerHost,
          port: config.plannerPort,
          readClient,
          getHealth: makeHealthReader(stateRef, packageVersion()),
          emitter,
        }),
      ),
      (server) => Effect.promise(() => server.close()),
    );

    yield* Effect.logInfo(
      `[runway planner] http listening on ${config.plannerHost}:${httpServer.port}`,
    );

    yield* makePlannerLoop(shutdownSignal, stateRef);
  }).pipe(Effect.scoped, Effect.provide(MainLayer));

  await Effect.runPromise(program);
  console.log("[runway planner] shutdown complete");
  process.exit(0);
}

/**
 * VA-475: turn the captured Effect runtime into a synchronous emitter
 * the HTTP handlers can call without re-entering Effect.gen. Each
 * call schedules a single log emission on the runtime; the
 * TelemetryLive layer flushes it through the OTLP exporter to the
 * dashboard's projector.
 */
export function makeDecisionEmitter(
  runFork: <A, E>(effect: Effect.Effect<A, E>) => unknown,
): DecisionEmitter {
  return {
    emitAccepted: ({ recommendationId, source, reason, timestampUnixNano }) => {
      const attrs: Record<string, string> = {
        recommendationId,
        source,
      };
      if (reason) attrs.reason = reason;
      runFork(
        Effect.logInfo(PLANNER_RECOMMENDATION_ACCEPTED_LOG).pipe(
          Effect.annotateLogs(attrs),
          // Force the log timestamp so the dashboard projector sees
          // the operator-perceived decision moment, not the OTLP
          // emit moment (close in practice; explicit is clearer).
          Effect.annotateLogs({ timestampUnixNano }),
        ),
      );
    },
    emitRejected: ({ recommendationId, source, reason, timestampUnixNano }) => {
      runFork(
        Effect.logInfo(PLANNER_RECOMMENDATION_REJECTED_LOG).pipe(
          Effect.annotateLogs({
            recommendationId,
            source,
            reason,
            timestampUnixNano,
          }),
        ),
      );
    },
  };
}

/**
 * Resolve `package.json#version` for the health endpoint. Reads
 * synchronously at boot — runtime cost is one stat + parse. Cached
 * after first call.
 */
let cachedVersion: string | null = null;
function packageVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(join(here, "..", "..", "package.json"), "utf8"),
    );
    cachedVersion = String(pkg.version ?? "unknown");
  } catch (err) {
    // Surface the read failure to stderr so an operator running the
    // foreground daemon can see what's wrong; the "unknown" fallback
    // keeps the health endpoint usable.
    console.error(
      "[runway planner] could not resolve package version:",
      err instanceof Error ? err.message : String(err),
    );
    cachedVersion = "unknown";
  }
  return cachedVersion;
}
