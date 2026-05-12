import type { CheckResult, Diagnostic, DoctorContext } from "./index.js";

/**
 * Informational. Reports which team + (optional) project a
 * `runway run` would scope to, so the operator can confirm before
 * draining a queue. Always `ok` — defaults are baked in (team "VA"
 * if RUNWAY_LINEAR_TEAM unset; team-wide if RUNWAY_LINEAR_PROJECT
 * unset).
 */
export const linearScopeDiagnostic: Diagnostic = {
  name: "linear-scope",
  section: "Environment",
  tier: "both",
  async run(_ctx: DoctorContext): Promise<readonly CheckResult[]> {
    const team = process.env.RUNWAY_LINEAR_TEAM?.trim() || "VA";
    const project = process.env.RUNWAY_LINEAR_PROJECT?.trim();
    return [
      {
        status: "ok",
        label: "linear scope",
        detail: project
          ? `team ${team} / project ${project}`
          : `team ${team} (team-wide — RUNWAY_LINEAR_PROJECT unset)`,
      },
    ];
  },
};
