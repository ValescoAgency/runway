import { Effect } from "effect";
import { createStorage } from "../dashboard/storage.js";
import { createMetaDashboardRead } from "./dashboard-read.js";
import { createMetaLinearGateway } from "./linear-meta.js";
import { runRunReviewPass, type RunReviewPassOutcome } from "./passes/run-review.js";

/**
 * VA-402: dispatch for the `runway review` subcommand family. One
 * verb per pass — `run`, then `drain` (VA-406), then `weekly`
 * (VA-408). The runner owns wiring (storage handle, gateway
 * construction) so the pass modules stay pure.
 */

import type { RunwayConfig } from "../config.js";
import type { Redacted } from "effect";

export interface RunnerEnv {
  readonly config: RunwayConfig;
  /** Path to the dashboard SQLite file. Source: `RUNWAY_DASHBOARD_DB`. */
  readonly dashboardDbPath: string;
  /** Anthropic API key — `ANTHROPIC_API_KEY` env in the runway process. */
  readonly anthropicApiKey: string;
}

export interface RunReviewArgs {
  readonly traceId: string;
  readonly issueIdentifier: string;
}

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
    const storage = createStorage(env.dashboardDbPath);
    try {
      const dashboardRead = createMetaDashboardRead(env.dashboardDbPath);
      const metaLinear = createMetaLinearGateway({
        linearApiKey: env.config.linearApiKey as Redacted.Redacted<string>,
        linearTeam: env.config.linearTeam,
        metaProjectName: env.config.metaProjectName,
      });
      return yield* runRunReviewPass(
        { traceId: args.traceId, issueIdentifier: args.issueIdentifier },
        {
          anthropicApiKey: env.anthropicApiKey,
          metaReviewModel: env.config.metaReviewModel,
          dashboardRead,
          metaLinear,
          storage,
        },
      );
    } finally {
      storage.close();
    }
  });
