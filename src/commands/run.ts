import { Effect, Layer, Logger, RateLimiter } from "effect";
import { ConfigLive, ConfigTag } from "../config.js";
import { createLinearGateway } from "../linear.js";
import { createGithubGateway } from "../github.js";
import {
  assertSandcastleInitialised,
  drainQueue,
} from "../orchestrator.js";
import { TelemetryLive } from "../telemetry.js";

export interface RunOptions {
  readonly max?: number;
  readonly project?: string;
  readonly allowPaths?: readonly string[];
  readonly implTurns?: number;
  readonly reviewRetries?: number;
}

export function parseRunArgs(argv: readonly string[]): RunOptions {
  const opts: {
    max?: number;
    project?: string;
    allowPaths?: string[];
    implTurns?: number;
    reviewRetries?: number;
  } = {};
  const collectAllow = (raw: string): void => {
    const paths = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (paths.length === 0) {
      throw new Error("--allow-paths requires at least one glob");
    }
    opts.allowPaths = [...(opts.allowPaths ?? []), ...paths];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--max" || a === "-n") {
      const v = argv[i + 1];
      if (!v) throw new Error("--max requires a number");
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--max must be a positive integer, got "${v}"`);
      }
      opts.max = n;
      i += 1;
    } else if (a === "--project") {
      const v = argv[i + 1];
      if (!v) throw new Error("--project requires a value");
      opts.project = v;
      i += 1;
    } else if (a?.startsWith("--project=")) {
      opts.project = a.slice("--project=".length);
    } else if (a === "--allow-paths") {
      const v = argv[i + 1];
      if (!v) throw new Error("--allow-paths requires a value");
      collectAllow(v);
      i += 1;
    } else if (a?.startsWith("--allow-paths=")) {
      collectAllow(a.slice("--allow-paths=".length));
    } else if (a === "--impl-turns") {
      const v = argv[i + 1];
      if (!v) throw new Error("--impl-turns requires a number");
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--impl-turns must be a positive integer, got "${v}"`);
      }
      opts.implTurns = n;
      i += 1;
    } else if (a?.startsWith("--impl-turns=")) {
      const v = a.slice("--impl-turns=".length);
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--impl-turns must be a positive integer, got "${v}"`);
      }
      opts.implTurns = n;
    } else if (a === "--review-retries") {
      const v = argv[i + 1];
      if (!v) throw new Error("--review-retries requires a number");
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(
          `--review-retries must be a non-negative integer, got "${v}"`,
        );
      }
      opts.reviewRetries = n;
      i += 1;
    } else if (a?.startsWith("--review-retries=")) {
      const v = a.slice("--review-retries=".length);
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(
          `--review-retries must be a non-negative integer, got "${v}"`,
        );
      }
      opts.reviewRetries = n;
    } else if (a === "--help" || a === "-h") {
      printRunUsage();
      process.exit(0);
    } else if (a) {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return opts;
}

export function printRunUsage(): void {
  console.log(`runway run — drain a Linear queue against the cwd repo

USAGE
  cd /path/to/your/repo
  runway run [--max N]

OPTIONS
  --max, -n N     Attempt at most N issues then exit (counts every
                  attempt — success, HITL, or revert-to-Todo).
                  Default: drain queue.
  --project ID    Scope the queue to a single Linear project under the
                  team. Accepts project UUID, slug, or name. Overrides
                  RUNWAY_LINEAR_PROJECT. Default: team-wide.
  --allow-paths GLOBS
                  Comma-separated globs removed from the impl policy's
                  forbidden-paths list for this invocation only.
                  Example: --allow-paths='.github/workflows/**' lets
                  the agent touch CI for issues whose AC require it.
                  Repeatable; pairs with .runway/policy.yml.
  --impl-turns N  Sandcastle inner turn budget for each impl phase
                  (how many turns the Claude agent gets per attempt
                  before it has to signal IMPL: DONE / BLOCKED).
                  Overrides RUNWAY_IMPL_TURNS. Default: 3.
  --review-retries N
                  In-run review-rejection retry budget. When the
                  reviewer emits REVIEW: REJECTED-RETRY — <reason>
                  (mechanically fixable), runway re-runs the impl
                  agent with the reason in {{IN_RUN_REVIEWER_FEEDBACK}}
                  and re-runs review. N caps the extra impl+review
                  pairs per drain pickup. 0 disables retries entirely.
                  Overrides RUNWAY_REVIEW_RETRIES. Default: 1.
  --help, -h      Show this help.

ENVIRONMENT
  LINEAR_API_KEY              required
  RUNWAY_LINEAR_TEAM          default "VA"
  RUNWAY_LINEAR_PROJECT       optional — scope to one project
  RUNWAY_BASE_BRANCH          optional — override the auto-detected base
                              branch (the branch runway diffs against
                              and targets with PRs). Detected from
                              origin/HEAD when unset.
  RUNWAY_READY_LABEL          default "ready-for-agent" — the
                              flightplan v1.1.0 contract. Runway's
                              drain queue filters by this label, not
                              by workflow status, because Linear's
                              GitHub integration auto-mutates status
                              on PR cross-references. Labels are
                              immune to that integration. Runway
                              removes the label on pickup (the
                              atomic claim signal).
  RUNWAY_HITL_LABEL           default "ready-for-human" — applied
                              when the agent or reviewer can't
                              finish, AND when a run fails outright.
                              Runway never re-applies the ready
                              label on failure (terminal failures
                              shouldn't retry indefinitely); an
                              operator triages and re-applies
                              the ready label manually if the
                              cause was transient.
  RUNWAY_MAX_ITERATIONS       default 5  — outer impl re-prompt loop
                              (only fires when the agent fails to
                              signal IMPL: DONE / BLOCKED at all)
  RUNWAY_IMPL_TURNS           default 3  — sandcastle inner turn
                              budget per impl phase. Overridden by
                              --impl-turns.
  RUNWAY_REVIEW_RETRIES       default 1  — review-rejection retry
                              loop. On REVIEW: REJECTED-RETRY, runway
                              re-runs impl with the rejection in the
                              prompt, then re-runs review. 0 disables
                              entirely. Overridden by --review-retries.
`);
}

export async function runCommand(argv: readonly string[]): Promise<void> {
  const opts = parseRunArgs(argv);
  const cwd = process.cwd();
  assertSandcastleInitialised(cwd);

  // VA-358 / VA-359: a single `Effect.runPromise` at the CLI
  // boundary. Composed layers:
  //
  // - `ConfigLive` (VA-359) resolves every env var via Effect's
  //   `Config` module. Secrets (LINEAR_API_KEY,
  //   OP_SERVICE_ACCOUNT_TOKEN) are `Redacted<string>` and won't
  //   appear in `Effect.log` output or stringified errors.
  // - `Logger.jsonLogger` is wired when `RUNWAY_JSON_LOGS=1` so the
  //   operator can pipe runway's output to a log aggregator.
  // - `TelemetryLive` (VA-358) is env-conditional — only wires the
  //   OTLP exporter when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
  // - Linear `RateLimiter` (folded in from VA-357): conservative
  //   30/minute, built inside `Effect.scoped` so its internals are
  //   torn down on program exit.
  const LoggerLive =
    process.env.RUNWAY_JSON_LOGS === "1"
      ? Logger.replace(Logger.defaultLogger, Logger.jsonLogger)
      : Layer.empty;
  const MainLayer = Layer.mergeAll(ConfigLive, TelemetryLive, LoggerLive);

  const program = Effect.gen(function* () {
    const baseConfig = yield* ConfigTag;
    const config = {
      ...baseConfig,
      ...(opts.project ? { linearProject: opts.project } : {}),
      ...(opts.implTurns !== undefined ? { implTurns: opts.implTurns } : {}),
      ...(opts.reviewRetries !== undefined
        ? { reviewRetries: opts.reviewRetries }
        : {}),
    };

    const scope = config.linearProject
      ? `team ${config.linearTeam} / project ${config.linearProject}`
      : `team ${config.linearTeam}`;
    yield* Effect.logInfo(
      `draining queue from ${scope} (label="${config.readyLabel}") against ${cwd}`,
    );

    const linearLimiter = yield* RateLimiter.make({
      limit: 30,
      interval: "1 minute",
    });
    const linear = createLinearGateway(config, linearLimiter);
    const github = createGithubGateway();
    return yield* drainQueue(
      { config, linear, github, cwd },
      { max: opts.max, allowPaths: opts.allowPaths },
    );
  }).pipe(Effect.scoped, Effect.provide(MainLayer));

  const result = await Effect.runPromise(program);
  console.log(
    `[runway] done — attempts=${result.attempts} opened=${result.opened} hitl=${result.hitl} errored=${result.errored} skipped=${result.skipped}`,
  );
  // Single-line, parser-friendly completion marker. Background
  // watchers (Claude Code's `run_in_background` bash task, CI,
  // scripts) can grep for `[runway:exit]` instead of guessing
  // whether the drain is still in flight.
  console.log(
    `[runway:exit] status=success attempts=${result.attempts} opened=${result.opened} hitl=${result.hitl} errored=${result.errored} skipped=${result.skipped}`,
  );
  // Hard exit so any lingering handle (OTel BatchSpanProcessor's
  // interval when OTEL_EXPORTER_OTLP_ENDPOINT is set, a Docker
  // stream Sandcastle left open, etc.) can't keep the process — and
  // the background task that launched it — alive after the drain is
  // logically done. By this point `Effect.scoped` has already torn
  // down its finalizers.
  process.exit(0);
}
