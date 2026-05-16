import { loadConfig } from "../config.js";
import { validateLinearConfig } from "../linear.js";
import {
  type CheckResult,
  type Diagnostic,
  type DoctorContext,
  errMsg,
} from "./index.js";

/**
 * Multi-result adapter. A single `validateLinearConfig()` API call
 * drives the team + label sub-checks — splitting these into
 * separate adapters would hit Linear's API N× per `runway doctor`
 * run, which is rude and slow. The checks share the result of one
 * call, so they live as one adapter that emits 1-3 CheckResults.
 *
 * VA-423: workflow-state checks retired alongside the status-mutation
 * model. Runway's queue contract is label-gated; the doctor verifies
 * the team plus the two labels (`ready-for-agent`, `ready-for-human`)
 * that drive pickup and HITL routing.
 *
 * Early-exits with a single "skipped" result when LINEAR_API_KEY is
 * unset (the env section already failed; we don't re-fail here).
 */
export const linearConfigDiagnostic: Diagnostic = {
  name: "linear-config",
  section: "Linear configuration",
  tier: "both",
  async run(_ctx: DoctorContext): Promise<readonly CheckResult[]> {
    if (!process.env.LINEAR_API_KEY) {
      return [
        {
          status: "skip",
          label: "Linear config",
          detail: "LINEAR_API_KEY unset — skipped",
        },
      ];
    }

    let config;
    try {
      config = loadConfig();
    } catch (err) {
      return [
        {
          status: "fail",
          label: "Linear config",
          detail: `failed to load runway config: ${errMsg(err)}`,
        },
      ];
    }

    let result;
    try {
      result = await validateLinearConfig(config);
    } catch (err) {
      return [
        {
          status: "fail",
          label: "Linear API",
          detail: `validation request failed: ${errMsg(err)}`,
        },
      ];
    }

    const results: CheckResult[] = [];

    if (result.team.kind === "missing") {
      results.push({
        status: "fail",
        label: `team ${config.linearTeam}`,
        detail: `Linear team key "${result.team.key}" not found — set RUNWAY_LINEAR_TEAM`,
      });
      results.push({
        status: "skip",
        label: "ready label",
        detail: "skipped (team missing)",
      });
      results.push({
        status: "skip",
        label: "HITL label",
        detail: "skipped (team missing)",
      });
      return results;
    }

    results.push({
      status: "ok",
      label: `team ${config.linearTeam}`,
      detail: `id=${result.team.id}`,
    });

    for (const [role, envVar, configured, label] of [
      ["ready", "RUNWAY_READY_LABEL", config.readyLabel, result.readyLabel],
      ["HITL", "RUNWAY_HITL_LABEL", config.hitlLabel, result.hitlLabel],
    ] as const) {
      const checkName = `${role} label "${configured}"`;
      if (label.kind === "ok") {
        results.push({
          status: "ok",
          label: checkName,
          detail: "present",
        });
      } else if (label.kind === "skipped") {
        results.push({
          status: "skip",
          label: checkName,
          detail: label.reason,
        });
      } else {
        results.push({
          status: "fail",
          label: checkName,
          detail: `not found on team — set ${envVar} or create the label. Available: ${formatList(label.available)}`,
        });
      }
    }

    return results;
  },
};

function formatList(items: readonly string[]): string {
  if (items.length === 0) return "(none)";
  return items.map((s) => `"${s}"`).join(", ");
}
