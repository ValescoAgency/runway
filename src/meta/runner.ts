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
  readonly source: {
    readonly model: string;
    readonly project: string;
    readonly delayHours: string;
    readonly thresholds: string;
  };
} {
  const file = loadRunwayConfigFile(env.cwd);
  const model = env.config.metaReviewModel
    ? { value: env.config.metaReviewModel, source: "env" }
    : file.metaReviewModel
      ? { value: file.metaReviewModel, source: ".runway/config.yml" }
      : { value: DEFAULT_META_REVIEW_MODEL, source: "default" };
  const project = env.config.metaProjectName
    ? { value: env.config.metaProjectName, source: "env" }
    : file.metaProjectName
      ? { value: file.metaProjectName, source: ".runway/config.yml" }
      : { value: DEFAULT_META_PROJECT_NAME, source: "default" };
  const delay =
    env.config.metaReviewDelayHours !== undefined
      ? { value: env.config.metaReviewDelayHours, source: "env" }
      : file.metaReviewDelayHours !== undefined
        ? { value: file.metaReviewDelayHours, source: ".runway/config.yml" }
        : { value: DEFAULT_META_REVIEW_DELAY_HOURS, source: "default" };
  // VA-404: env JSON override → file block → hardcoded defaults.
  // The env knob is one-off only — operators tuning thresholds for
  // real edit `.runway/config.yml`. Each missing field falls through
  // to the default individually, so a partial override (just
  // `minIterationCount`) doesn't reset the other knob.
  const thresholds = resolveThresholds(env.config.metaFilterThresholds, file.metaFilterThresholds);
  return {
    metaReviewModel: model.value,
    metaProjectName: project.value,
    metaReviewDelayHours: delay.value,
    metaFilterThresholds: thresholds.value,
    source: {
      model: model.source,
      project: project.source,
      delayHours: delay.source,
      thresholds: thresholds.source,
    },
  };
}

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
        },
      );
    } finally {
      storage.close();
    }
  });
