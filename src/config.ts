import { z } from "zod";

/**
 * Runway runtime config. Loaded from process.env at startup. We fail
 * fast if a required value is missing — no point starting the loop and
 * blowing up halfway through an issue.
 */
const ConfigSchema = z.object({
  anthropicApiKey: z.string().min(1, "ANTHROPIC_API_KEY required"),
  ghToken: z.string().min(1, "GH_TOKEN required"),
  linearApiKey: z.string().min(1, "LINEAR_API_KEY required"),
  targetRepo: z
    .string()
    .min(1, "RUNWAY_TARGET_REPO required (absolute path to a local clone)"),
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
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    ghToken: process.env.GH_TOKEN,
    linearApiKey: process.env.LINEAR_API_KEY,
    targetRepo: process.env.RUNWAY_TARGET_REPO,
    linearTeam: process.env.RUNWAY_LINEAR_TEAM,
    readyStatus: process.env.RUNWAY_READY_STATUS,
    inProgressStatus: process.env.RUNWAY_IN_PROGRESS_STATUS,
    inReviewStatus: process.env.RUNWAY_IN_REVIEW_STATUS,
    hitlLabel: process.env.RUNWAY_HITL_LABEL,
    maxIterations: process.env.RUNWAY_MAX_ITERATIONS,
  });
}
