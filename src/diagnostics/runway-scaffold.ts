import type { CheckResult, Diagnostic, DoctorContext } from "./index.js";

/**
 * Reports whether the cwd looks like a runway-scaffolded repo and
 * which tier was detected. Warn (not fail) when no scaffold — the
 * host-tooling section still has useful diagnostics for a fresh
 * repo, and the warn hints that `runway init` is the next step.
 */
export const runwayScaffoldDiagnostic: Diagnostic = {
  name: "runway-scaffold",
  section: "Repo state",
  tier: "both",
  async run(ctx: DoctorContext): Promise<readonly CheckResult[]> {
    const { repo } = ctx;
    if (repo.tier === null) {
      return [
        {
          status: "warn",
          label: "runway scaffold",
          detail:
            "no runway scaffold detected — run `runway init` first " +
            "(only host-tooling diagnostics apply until then)",
        },
      ];
    }
    return [
      {
        status: "ok",
        label: "runway scaffold",
        detail: `tier ${repo.tier} — Dockerfile=${repo.hasDockerfile} schema=${repo.hasSchema}`,
      },
    ];
  },
};
