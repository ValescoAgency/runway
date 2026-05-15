import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CheckResult,
  type Diagnostic,
  type DoctorContext,
} from "./index.js";

/**
 * VA-413: report whether the tier-2 `.env.schema` opts into agent
 * commit signing, and — when it does — whether the local git client
 * is set up to verify SSH-signed commits.
 *
 * Three states surface:
 *
 *   - `.env.schema` declares all four RUNWAY_SIGNING_* references →
 *     "ok" (signing is on); a follow-up check warns if the host's
 *     git has no `gpg.ssh.allowedSignersFile` so the operator knows
 *     `git log --show-signature` won't render Verified locally
 *     without one extra config step.
 *   - `.env.schema` declares some but not all four → "fail" (a
 *     partial config is treated as "off" by the container shim, so
 *     the operator would silently get unsigned commits).
 *   - `.env.schema` declares none → "warn" with a pointer to the
 *     ADR / README for setup.
 *
 * Tier-1 scaffolds (no varlock layer) skip this diagnostic entirely
 * — the tier filter is `tier-2`.
 */
export const gitSigningDiagnostic: Diagnostic = {
  name: "git-signing",
  section: "Environment",
  tier: "tier-2",
  async run(ctx: DoctorContext): Promise<readonly CheckResult[]> {
    const results: CheckResult[] = [];

    const schemaPath = join(ctx.cwd, ".env.schema");
    if (!existsSync(schemaPath)) {
      // The runway-scaffold diagnostic already reports this; don't
      // duplicate the noise — silently skip.
      return [
        {
          status: "skip",
          label: "agent commit signing",
          detail: "no .env.schema (tier-2 scaffold not present)",
        },
      ];
    }

    const schema = readFileSync(schemaPath, "utf8");
    // We look at uncommented declarations only. A `# RUNWAY_SIGNING_…`
    // line is documentation; only `RUNWAY_SIGNING_…=exec(…)` counts
    // as opting in.
    const declared = new Set<string>();
    for (const line of schema.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      const m = /^([A-Z0-9_]+)\s*=/.exec(trimmed);
      if (!m) continue;
      const name = m[1] ?? "";
      if (name.startsWith("RUNWAY_SIGNING_")) declared.add(name);
    }

    const REQUIRED = [
      "RUNWAY_SIGNING_SSH_PRIVKEY",
      "RUNWAY_SIGNING_SSH_PUBKEY",
      "RUNWAY_SIGNING_NAME",
      "RUNWAY_SIGNING_EMAIL",
    ];

    if (declared.size === 0) {
      results.push({
        status: "warn",
        label: "agent commit signing",
        detail:
          "off — see docs/adr/0003-agent-commit-signing.md to enable Verified-badge commits",
      });
      return results;
    }

    const missing = REQUIRED.filter((k) => !declared.has(k));
    if (missing.length > 0) {
      results.push({
        status: "fail",
        label: "agent commit signing",
        detail: `partial config — missing: ${missing.join(", ")}. Add all four or comment them all out.`,
      });
      return results;
    }

    results.push({
      status: "ok",
      label: "agent commit signing",
      detail: ".env.schema declares all four RUNWAY_SIGNING_* refs",
    });

    // Soft host-side check: the operator may want to verify the
    // agent's commits locally with `git log --show-signature`. That
    // needs `gpg.ssh.allowedSignersFile` configured on the host. We
    // warn (not fail) because the in-container signing path doesn't
    // depend on this — it's purely a local verification convenience.
    results.push(await checkAllowedSigners());

    return results;
  },
};

async function checkAllowedSigners(): Promise<CheckResult> {
  const { execa } = await import("execa");
  try {
    const { stdout } = await execa(
      "git",
      ["config", "--global", "gpg.ssh.allowedSignersFile"],
      { reject: false },
    );
    const path = stdout.trim();
    if (path.length === 0) {
      return {
        status: "warn",
        label: "host: gpg.ssh.allowedSignersFile",
        detail:
          "unset — `git log --show-signature` won't render Verified locally without it",
      };
    }
    return {
      status: "ok",
      label: "host: gpg.ssh.allowedSignersFile",
      detail: path,
    };
  } catch (err) {
    return {
      status: "warn",
      label: "host: gpg.ssh.allowedSignersFile",
      detail: `git config probe failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
