import { Effect } from "effect";
import { createStorage } from "../dashboard/storage.js";
import { loadRunwayConfigFile } from "../runway-config-file.js";
import { createMetaDashboardRead } from "./dashboard-read.js";
import {
  createGitHubHindsightGateway,
  createLinearHindsightGateway,
} from "./hindsight.js";
import {
  DEFAULT_META_FILTER_THRESHOLDS,
  type MetaFilterThresholds,
} from "./heuristic-filter.js";
import { createMetaLinearGateway } from "./linear-meta.js";
import {
  runDrainReviewPass,
  type DrainReviewPassOutcome,
} from "./passes/drain-review.js";
import { runRunReviewPass, type RunReviewPassOutcome } from "./passes/run-review.js";

/**
 * VA-402: dispatch for the `runway review` subcommand family. One
 * verb per pass — `run`, then `drain` (VA-406), then `weekly`
 * (VA-408). The runner owns wiring (storage handle, gateway
 * construction) so the pass modules stay pure.
 *
 * Resolution chain for the `metaReviewModel` / `metaProjectName`
 * fields:
 *
 *     env var → .runway/config.yml field → hardcoded default
 *
 * Env always wins so an operator can flip the model on a single
 * invocation without editing the file. The file is the persistent
 * default. The hardcoded fallback (`claude-sonnet-4-6`, `runway-meta`)
 * applies when neither layer set a value.
 */

import type { RunwayConfig } from "../config.js";
import type { Redacted } from "effect";

export interface RunnerEnv {
  readonly config: RunwayConfig;
  /**
   * cwd of the runway invocation. Used to locate `.runway/config.yml`
   * for the meta-review override chain. Defaults to `process.cwd()`
   * in production; tests inject a tmpdir.
   */
  readonly cwd: string;
  /** Path to the dashboard SQLite file. Source: `RUNWAY_DASHBOARD_DB`. */
  readonly dashboardDbPath: string;
  /** Anthropic API key — `ANTHROPIC_API_KEY` env in the runway process. */
  readonly anthropicApiKey: string;
  /**
   * VA-403: optional GitHub token for hindsight PR fetching. When
   * absent, the GitHub gateway runs unauthenticated (60 reqs/hr,
   * public-repo-only) — sufficient for solo / OSS workflows. Source:
   * `GITHUB_TOKEN` env in the runway process.
   */
  readonly githubToken?: string;
}

export interface RunReviewArgs {
  readonly traceId: string;
  readonly issueIdentifier: string;
  /** VA-403: bypass the delay gate. Set by the CLI's `--force` flag. */
  readonly force?: boolean;
}

const DEFAULT_META_REVIEW_MODEL = "claude-sonnet-4-6";
const DEFAULT_META_PROJECT_NAME = "runway-meta";
const DEFAULT_META_REVIEW_DELAY_HOURS = 18;
// VA-405: match the dashboard's default `DASHBOARD_AGGREGATE_WINDOW`
// so a stock dashboard + a stock IRA see the same denominator. The
// IRA computes its own aggregates (parameterized on the raw event
// tables) rather than reading the view, so the windows can diverge
// later without a coordinated bump.
const DEFAULT_META_NORMS_WINDOW_DRAINS = 30;

/**
 * VA-402: resolve the meta-review model + project name through
 * env → file → default. Exported so tests + the dashboard (if it
 * ever needs to surface the effective model) can compute the same
 * value without re-implementing the chain.
 */
export function resolveMetaConfig(env: {
  readonly config: RunwayConfig;
  readonly cwd: string;
}): {
  readonly metaReviewModel: string;
  readonly metaProjectName: string;
  /**
   * VA-403: minimum drain age before the IRA grades the run. Default
   * 18h gives hindsight (PR merge state, human comments, follow-up
   * issues) time to land. PRD constrains operator overrides to the
   * 12–24h band; for one-off bypass use `--force` on the CLI.
   */
  readonly metaReviewDelayHours: number;
  readonly metaFilterThresholds: MetaFilterThresholds;
  /**
   * VA-406: project name for severity-critical Drain Review
   * escalations. Undefined means "skip project assignment on the
   * escalation issue; just put it on the team."
   */
  readonly runwayRepoProjectName: string | undefined;
  readonly source: {
    readonly model: string;
    readonly project: string;
    readonly delayHours: string;
    readonly thresholds: string;
    readonly runwayRepoProject: string;
  };
} {
  const file = loadRunwayConfigFile(env.cwd);
  const model = resolveLayered(
    env.config.metaReviewModel,
    file.metaReviewModel,
    DEFAULT_META_REVIEW_MODEL,
  );
  const project = resolveLayered(
    env.config.metaProjectName,
    file.metaProjectName,
    DEFAULT_META_PROJECT_NAME,
  );
  const delay = resolveLayered(
    env.config.metaReviewDelayHours,
    file.metaReviewDelayHours,
    DEFAULT_META_REVIEW_DELAY_HOURS,
  );
  // VA-404: env JSON override → file block → hardcoded defaults.
  // The env knob is one-off only — operators tuning thresholds for
  // real edit `.runway/config.yml`. Each missing field falls through
  // to the default individually, so a partial override (just
  // `minIterationCount`) doesn't reset the other knob.
  const thresholds = resolveThresholds(env.config.metaFilterThresholds, file.metaFilterThresholds);
  // VA-406: no hardcoded default — absence means "skip project
  // assignment on critical-severity escalations."
  const runwayRepoProject = resolveLayered<string | undefined>(
    env.config.runwayRepoProjectName,
    file.runwayRepoProjectName,
    undefined,
  );
  return {
    metaReviewModel: model.value,
    metaProjectName: project.value,
    metaReviewDelayHours: delay.value,
    metaFilterThresholds: thresholds.value,
    runwayRepoProjectName: runwayRepoProject.value,
    source: {
      model: model.source,
      project: project.source,
      delayHours: delay.source,
      thresholds: thresholds.source,
      runwayRepoProject: runwayRepoProject.source,
    },
  };
}

/**
 * VA-406: env → file → default resolution for a single knob. Flattens
 * the otherwise-nested ternary chain `resolveMetaConfig` was repeating
 * for each knob. Returns the resolved value + which layer provided it
 * so `source.<name>` stays an honest audit trail.
 *
 * `undefined` in `fromEnv` / `fromFile` means "unset at that layer" —
 * we fall through. Other falsy values (empty string, zero) are
 * treated as set; operators who explicitly want an empty string have
 * intentionally typed it.
 */
const resolveLayered = <T>(
  fromEnv: T | undefined,
  fromFile: T | undefined,
  defaultValue: T,
): { readonly value: T; readonly source: string } => {
  if (fromEnv !== undefined) return { value: fromEnv, source: "env" };
  if (fromFile !== undefined) {
    return { value: fromFile, source: ".runway/config.yml" };
  }
  return { value: defaultValue, source: "default" };
};

const resolveThresholds = (
  fromEnv: Partial<MetaFilterThresholds> | undefined,
  fromFile: Partial<MetaFilterThresholds> | undefined,
): { readonly value: MetaFilterThresholds; readonly source: string } => {
  if (!fromEnv && !fromFile) {
    return { value: DEFAULT_META_FILTER_THRESHOLDS, source: "default" };
  }
  const merged: MetaFilterThresholds = {
    minIterationCount:
      fromEnv?.minIterationCount ??
      fromFile?.minIterationCount ??
      DEFAULT_META_FILTER_THRESHOLDS.minIterationCount,
    minReviewerRejections:
      fromEnv?.minReviewerRejections ??
      fromFile?.minReviewerRejections ??
      DEFAULT_META_FILTER_THRESHOLDS.minReviewerRejections,
  };
  const source = fromEnv ? "env" : ".runway/config.yml";
  return { value: merged, source };
};

/**
 * VA-402: invoke the Run Review pass end-to-end. Manages storage +
 * gateway lifetimes so the subcommand doesn't need to. Returns the
 * pass outcome verbatim; the CLI exit handler maps that to an exit
 * code (currently always 0 per PRD — Run Review failures stub and
 * continue rather than crash).
 */
export const dispatchRunReview = (
  args: RunReviewArgs,
  env: RunnerEnv,
): Effect.Effect<RunReviewPassOutcome, never, never> =>
  Effect.gen(function* () {
    const resolved = resolveMetaConfig(env);
    const storage = createStorage(env.dashboardDbPath);
    try {
      const dashboardRead = createMetaDashboardRead(env.dashboardDbPath);
      const metaLinear = createMetaLinearGateway({
        linearApiKey: env.config.linearApiKey as Redacted.Redacted<string>,
        linearTeam: env.config.linearTeam,
        metaProjectName: resolved.metaProjectName,
        // VA-406: optional. When unset, escalation issues land in the
        // team with their labels but skip project assignment.
        runwayRepoProjectName: resolved.runwayRepoProjectName,
      });
      // VA-403: hindsight gateways. GitHub may run unauthenticated
      // (sufficient for public repos, 60 reqs/hr); Linear uses the
      // same workspace API key the rest of runway uses. Both are
      // wired unconditionally — the pass falls back to v1.0.0
      // semantics (null hindsight) if any individual fetch fails.
      const githubHindsight = createGitHubHindsightGateway({
        token: env.githubToken,
      });
      const linearHindsight = createLinearHindsightGateway({
        linearApiKey: env.config.linearApiKey as Redacted.Redacted<string>,
        linearTeam: env.config.linearTeam,
      });
      return yield* runRunReviewPass(
        { traceId: args.traceId, issueIdentifier: args.issueIdentifier },
        {
          anthropicApiKey: env.anthropicApiKey,
          metaReviewModel: resolved.metaReviewModel,
          dashboardRead,
          metaLinear,
          storage,
          hindsight: {
            github: githubHindsight,
            linear: linearHindsight,
          },
          delayHours: resolved.metaReviewDelayHours,
          force: args.force ?? false,
          metaFilterThresholds: resolved.metaFilterThresholds,
          // VA-405: rolling norms always wired with the default 30-drain
          // window. The IRA's prompt degrades to v1.1.0 behavior (null
          // relative slots) automatically when the category has no rows
          // in the window, so no operator opt-in is needed.
          normsWindow: DEFAULT_META_NORMS_WINDOW_DRAINS,
        },
      );
    } finally {
      storage.close();
    }
  });

export interface DrainReviewArgs {
  readonly traceId: string;
}

/**
 * VA-406: invoke the Drain Review pass end-to-end. Same lifetime
 * management as `dispatchRunReview` — opens the storage handle, builds
 * gateways, runs the pass, closes the handle in `finally`. The CLI
 * verb (`runway review drain --id <drain-id>`) routes through here
 * for operator / scheduled invocations; the Run Review trigger
 * (VA-406 AC4) calls `runDrainReviewPass` directly instead of going
 * through this dispatch — the gateways are already wired in that
 * context, so we'd just be opening a second SQLite handle for no
 * reason.
 */
export const dispatchDrainReview = (
  args: DrainReviewArgs,
  env: RunnerEnv,
): Effect.Effect<DrainReviewPassOutcome, never, never> =>
  Effect.gen(function* () {
    const resolved = resolveMetaConfig(env);
    const storage = createStorage(env.dashboardDbPath);
    try {
      const dashboardRead = createMetaDashboardRead(env.dashboardDbPath);
      const metaLinear = createMetaLinearGateway({
        linearApiKey: env.config.linearApiKey as Redacted.Redacted<string>,
        linearTeam: env.config.linearTeam,
        metaProjectName: resolved.metaProjectName,
        runwayRepoProjectName: resolved.runwayRepoProjectName,
      });
      return yield* runDrainReviewPass(
        { traceId: args.traceId },
        {
          anthropicApiKey: env.anthropicApiKey,
          metaReviewModel: resolved.metaReviewModel,
          dashboardRead,
          metaLinear,
          storage,
        },
      );
    } finally {
      storage.close();
    }
  });
