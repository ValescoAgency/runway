import { z } from "zod";

/**
 * Runway runtime config. Loaded from process.env at startup. We fail
 * fast if a required value is missing — no point starting the loop and
 * blowing up halfway through an issue.
 *
 * Notable absences vs. typical agent runners:
 *   - No ANTHROPIC_API_KEY here. Sandcastle reads it from the target
 *     repo's `.sandcastle/.env` per its own conventions.
 *   - No GH_TOKEN here. We use the `gh` CLI for PR creation; if the
 *     user is logged in (`gh auth status`), it Just Works. If they
 *     aren't, `gh pr create` errors out with a clear message — no need
 *     for runway to second-guess.
 *   - No RUNWAY_TARGET_REPO. Runway runs from inside the target repo
 *     (`process.cwd()`), the same way `sandcastle run` does.
 */
const ConfigSchema = z.object({
  linearApiKey: z.string().min(1, "LINEAR_API_KEY required"),
  /**
   * Optional. If present, forwarded into the sandcastle container so
   * the in-container varlock + 1Password-CLI shim can resolve agent
   * secrets at run time. If absent, the container falls back to
   * sandcastle's normal `.sandcastle/.env` flow. See
   * docs/secrets-with-varlock.md.
   */
  opServiceAccountToken: z.string().optional(),
  linearTeam: z.string().default("VA"),
  readyStatus: z.string().default("Todo"),
  inProgressStatus: z.string().default("In Progress"),
  inReviewStatus: z.string().default("In Review"),
  hitlLabel: z.string().default("needs-human"),
  maxIterations: z.coerce.number().int().positive().default(5),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  return ConfigSchema.parse({
    linearApiKey: process.env.LINEAR_API_KEY,
    opServiceAccountToken: process.env.OP_SERVICE_ACCOUNT_TOKEN,
    linearTeam: process.env.RUNWAY_LINEAR_TEAM,
    readyStatus: process.env.RUNWAY_READY_STATUS,
    inProgressStatus: process.env.RUNWAY_IN_PROGRESS_STATUS,
    inReviewStatus: process.env.RUNWAY_IN_REVIEW_STATUS,
    hitlLabel: process.env.RUNWAY_HITL_LABEL,
    maxIterations: process.env.RUNWAY_MAX_ITERATIONS,
  });
}
