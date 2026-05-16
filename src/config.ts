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
  /**
   * VA-423: label that marks an issue as "ready for the agent to
   * pick up." Default `ready-for-agent` matches the flightplan
   * v1.1.0 contract. Runway's drain queue filters by this label
   * instead of workflow status because Linear's GitHub integration
   * auto-mutates status when a PR cross-references an issue —
   * draining the queue silently every time someone mentions the
   * issue from a PR. Labels are not touched by that integration.
   * Override via `RUNWAY_READY_LABEL`.
   */
  readonly readyLabel: string;
  // VA-354 / VA-423: default to `ready-for-human`. Runway adopts
  // flightplan's `ready-for-agent` for drain pickup but keeps
  // `ready-for-human` for HITL (not flightplan's canonical
  // `needs-human`). One convention across our triage / to-prd /
  // to-issues / gstack skills wins over matching any single tool's
  // canonical exactly. Override via `RUNWAY_HITL_LABEL`.
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
  /**
   * VA-402: env-only signal for the Anthropic model the IRA's Run
   * Review pass invokes. `undefined` when `RUNWAY_META_REVIEW_MODEL`
   * is unset — the runner then falls back to `.runway/config.yml`
   * (matches the PRD's `.afk/config.yml` intent under runway's
   * existing `.runway/*.yml` convention) and finally to the
   * hard-coded `claude-sonnet-4-6` default. Resolution lives in
   * `meta/runner.ts` so the file-merge stays close to the pass that
   * actually consumes it.
   */
  readonly metaReviewModel?: string;
  /**
   * VA-402: env-only signal for the Linear project the IRA writes
   * its Reviews into. Same resolution chain as `metaReviewModel`:
   * env → `.runway/config.yml` → `"runway-meta"` default.
   */
  readonly metaProjectName?: string;
  /**
   * VA-403: minimum drain age (in hours) before `runway review run`
   * grades it. The IRA's hindsight signals (PR merge / human
   * comments / follow-up issues) need real time to land — judging
   * too early scores against absent signals. PRD constrains the
   * value to 12–24h; default 18. Use `--force` on the CLI for a
   * one-off bypass; persistent disable isn't a supported mode.
   * Source: `RUNWAY_REVIEW_DELAY_HOURS`. Resolution: env →
   * `.runway/config.yml` → 18-hour hardcoded default.
   */
  readonly metaReviewDelayHours?: number;
  /**
   * VA-404: one-off override for the IRA heuristic-filter
   * thresholds. Operators tuning thresholds for real edit
   * `.runway/config.yml`; this env var is for one-shot overrides
   * (e.g. running a single `runway review run` with `minIterationCount=1`
   * to force a Review on a clean run for debugging). Source:
   * `RUNWAY_META_FILTER_THRESHOLDS` as a JSON object — partial
   * overrides supported (set just one field, the other falls
   * through to the file / hardcoded default). Resolution lives in
   * `meta/runner.ts` alongside the other meta knobs.
   */
  readonly metaFilterThresholds?: { readonly minIterationCount?: number; readonly minReviewerRejections?: number };
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
  readyLabel: EConfig.string("RUNWAY_READY_LABEL").pipe(
    EConfig.withDefault("ready-for-agent"),
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
  metaReviewModel: EConfig.option(EConfig.string("RUNWAY_META_REVIEW_MODEL")),
  metaProjectName: EConfig.option(EConfig.string("RUNWAY_META_PROJECT_NAME")),
  // VA-403: PRD constrains the configurable delay to the 12–24h
  // band — too short and the IRA judges before hindsight lands; too
  // long and operators lose the freshness operators expect from a
  // ~daily retrospective. The explicit `--force` CLI flag (or
  // `force: true` to dispatchRunReview) is the supported bypass
  // for one-off operator overrides; persistent disable isn't.
  metaReviewDelayHours: EConfig.option(
    EConfig.number("RUNWAY_REVIEW_DELAY_HOURS").pipe(
      EConfig.validate({
        message: "RUNWAY_REVIEW_DELAY_HOURS must be in the 12-24 hour band (PRD VA-403); use --force on the CLI for one-off bypass",
        validation: (n): n is number => n >= 12 && n <= 24,
      }),
    ),
  ),
  metaFilterThresholdsJson: EConfig.option(
    EConfig.string("RUNWAY_META_FILTER_THRESHOLDS"),
  ),
}).pipe(
  Effect.map(
    (raw): RunwayConfig => ({
      linearApiKey: raw.linearApiKey,
      opServiceAccountToken: Option.getOrUndefined(raw.opServiceAccountToken),
      linearTeam: raw.linearTeam,
      linearProject: Option.getOrUndefined(raw.linearProject),
      baseBranch: Option.getOrUndefined(raw.baseBranch),
      readyLabel: raw.readyLabel,
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
      metaReviewModel: Option.getOrUndefined(raw.metaReviewModel),
      metaProjectName: Option.getOrUndefined(raw.metaProjectName),
      metaReviewDelayHours: Option.getOrUndefined(raw.metaReviewDelayHours),
      metaFilterThresholds: parseMetaFilterThresholdsJson(
        Option.getOrUndefined(raw.metaFilterThresholdsJson),
      ),
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

// VA-404: parse the optional `RUNWAY_META_FILTER_THRESHOLDS` env JSON.
// Malformed JSON or out-of-range numbers are silently ignored —
// per-threshold env vars are an anti-feature; if the operator wants
// safety they edit `.runway/config.yml`. We accept partial objects.
function parseMetaFilterThresholdsJson(
  raw: string | undefined,
):
  | { readonly minIterationCount?: number; readonly minReviewerRejections?: number }
  | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const obj = parsed as Record<string, unknown>;
  const out: { minIterationCount?: number; minReviewerRejections?: number } = {};
  if (typeof obj.minIterationCount === "number" && obj.minIterationCount >= 1) {
    out.minIterationCount = Math.floor(obj.minIterationCount);
  }
  if (
    typeof obj.minReviewerRejections === "number" &&
    obj.minReviewerRejections >= 1
  ) {
    out.minReviewerRejections = Math.floor(obj.minReviewerRejections);
  }
  return Object.keys(out).length === 0 ? undefined : out;
}
