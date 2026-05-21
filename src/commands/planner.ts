import { Deferred, Effect, Layer, Logger } from "effect";
import { ConfigLive, ConfigTag } from "../config.js";
import {
  installSignalHandlers,
  makePlannerLoop,
} from "../planner.js";
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

ENVIRONMENT
  RUNWAY_PLANNER_TICK_SECONDS   default 30 — tick cadence.
  RUNWAY_PLANNER_HOST           default 127.0.0.1 — HTTP bind host
                                (consumed by the listener wired in
                                VA-475). Set to a tailnet IP to expose
                                the API across your Tailscale network.
  RUNWAY_PLANNER_PORT           default 3002 — HTTP bind port.

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
      `[runway planner] boot host=${config.plannerHost} port=${config.plannerPort} tick=${config.plannerTickSeconds}s`,
    );

    const shutdownSignal = yield* Deferred.make<void>();
    yield* installSignalHandlers(shutdownSignal);
    yield* makePlannerLoop(shutdownSignal);
  }).pipe(Effect.scoped, Effect.provide(MainLayer));

  await Effect.runPromise(program);
  console.log("[runway planner] shutdown complete");
  process.exit(0);
}
