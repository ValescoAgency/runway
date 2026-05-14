import {
  Config as EConfig,
  type ConfigError,
  ConfigProvider,
  Context,
  Effect,
  Layer,
  Option,
  type Redacted,
} from "effect";

/**
 * Runway runtime config. Resolved from `process.env` at startup via
 * Effect's `Config` module — we fail fast if a required value is
 * missing rather than letting the loop blow up halfway through an
 * issue.
 *
 * Secrets are `Redacted<string>`: their `.toString()` / log
 * serialisation prints `<redacted>`, so an accidental `Effect.log`
 * or `console.error` of a config object never leaks them. Call
 * `Redacted.value(...)` once, at the boundary where the secret is
 * actually used (the Linear SDK constructor, the Docker env map).
 *
 * Notable absences vs. typical agent runners:
 *   - No ANTHROPIC_API_KEY here. Sandcastle reads it from the target
 *     repo's `.sandcastle/.env` per its own conventions.
 *   - No GH_TOKEN here. We use the `gh` CLI for PR creation; if the
 *     user is logged in (`gh auth status`), it Just Works. If they
 *     aren't, `gh pr create` errors out with a clear message — no
 *     need for runway to second-guess.
 *   - No RUNWAY_TARGET_REPO. Runway runs from inside the target repo
 *     (`process.cwd()`), the same way `sandcastle run` does.
 */
export interface RunwayConfig {
  readonly linearApiKey: Redacted.Redacted<string>;
  /**
   * Optional. If present, forwarded into the sandcastle container so
   * the in-container varlock + 1Password-CLI shim can resolve agent
   * secrets at run time. If absent, the container falls back to
   * sandcastle's normal `.sandcastle/.env` flow. See
   * docs/secrets-with-varlock.md.
   */
  readonly opServiceAccountToken?: Redacted.Redacted<string>;
  readonly linearTeam: string;
  /**
   * Optional. Scopes the `runway run` queue to a single project under
   * `linearTeam`. Resolved by Linear project ID, slug, or name. When
   * unset, runway drains every `Todo` issue on the team (legacy
   * behavior). Source: `RUNWAY_LINEAR_PROJECT` env var or
   * `--project` CLI flag on `runway run`.
   */
  readonly linearProject?: string;
  /**
   * Optional. Override the auto-detected base branch — the branch
   * runway diffs against, opens PRs against, and uses to count
   * agent-branch commits. Source: `RUNWAY_BASE_BRANCH` env var. When
   * unset, runway resolves the default branch from `origin/HEAD` at
   * orchestrator startup.
   */
  readonly baseBranch?: string;
  readonly readyStatus: string;
  readonly inProgressStatus: string;
  readonly inReviewStatus: string;
  // VA-354: default to the Flightplan canonical state label
  // `ready-for-human`. Workspaces that use a different label
  // override via `RUNWAY_HITL_LABEL`.
  readonly hitlLabel: string;
  readonly maxIterations: number;
  /**
   * Sandcastle inner turn budget for the impl phase — i.e. how many
   * turns the Claude agent gets per `runSandcastle` call before it
   * has to signal `IMPL: DONE` / `IMPL: BLOCKED`. Distinct from
   * `maxIterations`, which controls the *outer* impl re-prompt loop
   * (and only fires when the agent fails to signal at all). Source:
   * `RUNWAY_IMPL_TURNS` env var or `--impl-turns` CLI flag on
   * `runway run`. Defaults to 3 so single-pass agents have headroom
   * for harder tasks; bump higher for very large changes.
   */
  readonly implTurns: number;
  /**
   * VA-418: in-run review-rejection retry budget. When the reviewer
   * emits `REVIEW: REJECTED-RETRY — <reason>` (or the legacy bare
   * `REVIEW: REJECTED — <reason>`), runway re-runs the impl agent
   * with the rejection text in the `{{IN_RUN_REVIEWER_FEEDBACK}}`
   * slot, then re-runs review. `reviewRetries` caps the number of
   * additional impl+review attempts per drain pickup — default `1`
   * means up to 2 total impl+review pairs. `0` disables retries
   * entirely (every rejection escalates immediately, useful as a
   * kill-switch). Source: `RUNWAY_REVIEW_RETRIES` env var or
   * `--review-retries N` CLI flag on `runway run`. Distinct from
   * `maxIterations` (outer impl-marker-missing loop) and `implTurns`
   * (inner sandcastle turn budget).
   */
  readonly reviewRetries: number;
  /**
   * VA-383: Linear-user names whose comments on an issue get surfaced
   * to the impl agent as "Review feedback from prior attempts."
   * `undefined` (the default) means runway uses the Linear user the
   * API key authenticates as — which is both the reviewer-agent's
   * identity and, in the solo-dev case, the repo owner's identity.
   * Override via `RUNWAY_COMMENT_AUTHOR_ALLOWLIST` as a
   * comma-separated list of Linear user names when reviewer and owner
   * are split across distinct identities.
   */
  readonly commentAuthorAllowlist?: readonly string[];
}

// Back-compat alias — existing consumers (orchestrator, gateways)
// import `Config` and shouldn't have to change just because the
// underlying loader did.
export type Config = RunwayConfig;

/**
 * VA-359: Effect.Config program that reads every var from
 * `process.env`, applies defaults, and yields a typed `RunwayConfig`.
 * The `Option<T>` returns from `Config.option(...)` are flattened to
 * `T | undefined` in the final shape so consumers don't have to
 * import `Option` everywhere.
 */
const configEffect: Effect.Effect<RunwayConfig, ConfigError.ConfigError> = EConfig.all({
  linearApiKey: EConfig.redacted("LINEAR_API_KEY"),
  opServiceAccountToken: EConfig.option(
    EConfig.redacted("OP_SERVICE_ACCOUNT_TOKEN"),
  ),
  linearTeam: EConfig.string("RUNWAY_LINEAR_TEAM").pipe(
    EConfig.withDefault("VA"),
  ),
  linearProject: EConfig.option(EConfig.string("RUNWAY_LINEAR_PROJECT")),
  baseBranch: EConfig.option(EConfig.string("RUNWAY_BASE_BRANCH")),
  readyStatus: EConfig.string("RUNWAY_READY_STATUS").pipe(
    EConfig.withDefault("Todo"),
  ),
  inProgressStatus: EConfig.string("RUNWAY_IN_PROGRESS_STATUS").pipe(
    EConfig.withDefault("In Progress"),
  ),
  inReviewStatus: EConfig.string("RUNWAY_IN_REVIEW_STATUS").pipe(
    EConfig.withDefault("In Review"),
  ),
  hitlLabel: EConfig.string("RUNWAY_HITL_LABEL").pipe(
    EConfig.withDefault("ready-for-human"),
  ),
  maxIterations: EConfig.integer("RUNWAY_MAX_ITERATIONS").pipe(
    EConfig.withDefault(5),
    EConfig.validate({
      message: "RUNWAY_MAX_ITERATIONS must be a positive integer",
      validation: (n): n is number => n > 0,
    }),
  ),
  implTurns: EConfig.integer("RUNWAY_IMPL_TURNS").pipe(
    EConfig.withDefault(3),
    EConfig.validate({
      message: "RUNWAY_IMPL_TURNS must be a positive integer",
      validation: (n): n is number => n > 0,
    }),
  ),
  // VA-418: zero is a valid value here (operator kill-switch) so the
  // validation accepts >= 0, unlike implTurns/maxIterations which
  // both require >= 1.
  reviewRetries: EConfig.integer("RUNWAY_REVIEW_RETRIES").pipe(
    EConfig.withDefault(1),
    EConfig.validate({
      message: "RUNWAY_REVIEW_RETRIES must be a non-negative integer",
      validation: (n): n is number => n >= 0,
    }),
  ),
  commentAuthorAllowlist: EConfig.option(
    EConfig.string("RUNWAY_COMMENT_AUTHOR_ALLOWLIST"),
  ),
}).pipe(
  Effect.map(
    (raw): RunwayConfig => ({
      linearApiKey: raw.linearApiKey,
      opServiceAccountToken: Option.getOrUndefined(raw.opServiceAccountToken),
      linearTeam: raw.linearTeam,
      linearProject: Option.getOrUndefined(raw.linearProject),
      baseBranch: Option.getOrUndefined(raw.baseBranch),
      readyStatus: raw.readyStatus,
      inProgressStatus: raw.inProgressStatus,
      inReviewStatus: raw.inReviewStatus,
      hitlLabel: raw.hitlLabel,
      maxIterations: raw.maxIterations,
      implTurns: raw.implTurns,
      reviewRetries: raw.reviewRetries,
      commentAuthorAllowlist: Option.getOrUndefined(
        raw.commentAuthorAllowlist,
      )
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    }),
  ),
);

/**
 * VA-359: Context tag for the resolved RunwayConfig. Provided by
 * `ConfigLive` at the top of every CLI entry point; consumed by
 * `yield* ConfigTag` inside Effect.gen.
 */
export class ConfigTag extends Context.Tag("RunwayConfig")<
  ConfigTag,
  RunwayConfig
>() {}

// VA-411: Build a ConfigProvider from an explicit env-like object so
// tests (and any other caller that needs hermetic isolation from the
// host environment) can drive config loading without mutating
// `process.env`. The path delimiter matches Effect's `fromEnv` so a
// `Map(process.env)` and a real env behave the same for our flat
// `RUNWAY_*` keys.
const providerFromEnv = (
  env: Record<string, string | undefined>,
): ConfigProvider.ConfigProvider => {
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") map.set(k, v);
  }
  return ConfigProvider.fromMap(map, { pathDelim: "_" });
};

/**
 * VA-411: Build a `ConfigLive` Layer that resolves env vars from an
 * explicit env map instead of `process.env`. Production callers use
 * the default `ConfigLive` (which reads `process.env`); tests pass
 * an explicit map so host env leaks (e.g. an `.envrc` that exports
 * `RUNWAY_LINEAR_PROJECT`) can't break assertions.
 */
export function makeConfigLive(
  env: Record<string, string | undefined> = process.env,
): Layer.Layer<ConfigTag, ConfigError.ConfigError> {
  return Layer.effect(
    ConfigTag,
    configEffect.pipe(Effect.withConfigProvider(providerFromEnv(env))),
  );
}

/**
 * Layer that resolves env vars once and makes the result available
 * via `ConfigTag` for the rest of the program.
 */
export const ConfigLive: Layer.Layer<ConfigTag, ConfigError.ConfigError> =
  makeConfigLive();

/**
 * Sync helper for non-Effect callers (`runway doctor` early
 * validation, the `runway run` CLI bootstrap before it enters
 * Effect-land). `Effect.runSync` throws a `FiberFailure` carrying
 * the `ConfigError` on a missing/invalid env var — the caller's
 * existing `catch (err) { … errMsg(err) … }` shape rendered the
 * Zod issue the same way it'll now render the Effect ConfigError.
 *
 * VA-411: Accepts an optional `env` map so tests can drive the
 * loader hermetically. Defaults to `process.env` for production
 * callers.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): RunwayConfig {
  return Effect.runSync(
    configEffect.pipe(Effect.withConfigProvider(providerFromEnv(env))),
  );
}
