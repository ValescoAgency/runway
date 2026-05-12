import type { CheckResult, Diagnostic, DoctorContext } from "./index.js";

/**
 * Tier-2 only. Surfaces which Claude Code auth env var the
 * `.env.schema` declares — ANTHROPIC_API_KEY (pay-per-token) and
 * CLAUDE_CODE_OAUTH_TOKEN (Pro/Max subscription) are not
 * interchangeable, and a mismatch between this and what's stored in
 * 1Password yields a generic "Invalid API key" inside the container
 * with no useful diagnostic. Declaring both is a hard fail; declaring
 * neither is a hard fail.
 */
export const claudeAuthModeDiagnostic: Diagnostic = {
  name: "claude-auth-mode",
  section: "Environment",
  tier: "tier-2",
  async run(ctx: DoctorContext): Promise<readonly CheckResult[]> {
    const { repo } = ctx;
    if (repo.hasConflictingAuthVars) {
      return [
        {
          status: "fail",
          label: "claude auth mode",
          detail:
            ".env.schema declares both ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN — pick one (they are not interchangeable)",
        },
      ];
    }
    if (repo.authMode === "oauth") {
      return [
        {
          status: "ok",
          label: "claude auth mode",
          detail: "oauth (CLAUDE_CODE_OAUTH_TOKEN — Pro/Max subscription)",
        },
      ];
    }
    if (repo.authMode === "api-key") {
      return [
        {
          status: "ok",
          label: "claude auth mode",
          detail: "api-key (ANTHROPIC_API_KEY — pay-per-token)",
        },
      ];
    }
    return [
      {
        status: "fail",
        label: "claude auth mode",
        detail:
          ".env.schema declares neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN",
      },
    ];
  },
};
