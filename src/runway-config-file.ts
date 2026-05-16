import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * VA-402: persistent operator-level config file at `.runway/config.yml`.
 * Lives next to `.runway/policy.yml` (VA-352) — same convention, same
 * directory, same "file is optional, defaults are conservative" model.
 *
 * The PRD spells the file as `.afk/config.yml` (an earlier project
 * name); runway's established convention is `.runway/*.yml`, so this
 * loader uses `.runway/config.yml`. The semantics match the PRD intent:
 * persistent operator-level overrides that don't belong in env vars.
 *
 * Resolution chain (in the consuming code):
 *
 *   env var → `.runway/config.yml` field → hardcoded default
 *
 * Env always wins — the runtime knob beats the persistent default.
 * That mirrors how unix tools generally compose CLI > env > file.
 */

const RunwayConfigFileSchema = z.object({
  /**
   * VA-402: Anthropic model name for the IRA's Run / Drain Review
   * passes. Overridden by `RUNWAY_META_REVIEW_MODEL` if set in env.
   */
  metaReviewModel: z.string().optional(),
  /**
   * VA-402: Linear project name the IRA writes its Reviews into.
   * Overridden by `RUNWAY_META_PROJECT_NAME` if set in env.
   */
  metaProjectName: z.string().optional(),
  /**
   * VA-403: minimum drain age before the IRA grades it. PRD
   * constrains the value to the 12–24h band (default 18) — too
   * short and hindsight hasn't landed; too long and the operator
   * loses freshness. Overridden by `RUNWAY_REVIEW_DELAY_HOURS` if
   * set in env. The `--force` CLI flag is the supported one-off
   * bypass; persistent disable isn't a supported mode.
   */
  metaReviewDelayHours: z.number().min(12).max(24).optional(),
  /**
   * VA-404: thresholds for the IRA heuristic pre-filter. Either or
   * both fields may be set; missing fields fall through to the
   * hardcoded defaults (3 iterations, 2 reviewer rejections).
   */
  metaFilterThresholds: z
    .object({
      minIterationCount: z.number().int().min(1).optional(),
      minReviewerRejections: z.number().int().min(1).optional(),
    })
    .optional(),
  /**
   * VA-406: optional Linear project name where the runway repo's own
   * issues live (e.g. "Runway"). When set, severity-critical Drain
   * Review escalations file in that project; when unset, they land
   * team-only. Overridden by `RUNWAY_REPO_PROJECT_NAME` if set in env.
   */
  runwayRepoProjectName: z.string().optional(),
});

export type RunwayConfigFile = z.infer<typeof RunwayConfigFileSchema>;

const CONFIG_RELATIVE_PATH = join(".runway", "config.yml");

/**
 * Read `.runway/config.yml` relative to `cwd` if it exists. Returns
 * an empty object when the file is absent so callers can spread the
 * result over defaults without null-guarding. A malformed file throws
 * a typed Zod error — the runner surfaces that as a `meta-failed`
 * stub rather than silently ignoring operator intent.
 */
export function loadRunwayConfigFile(cwd: string): RunwayConfigFile {
  const path = join(cwd, CONFIG_RELATIVE_PATH);
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  return RunwayConfigFileSchema.parse(parseYaml(raw) ?? {});
}
