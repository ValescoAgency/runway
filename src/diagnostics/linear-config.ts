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
 * drives the team / state / label sub-checks — splitting these into
 * separate adapters would hit Linear's API N× per `runway doctor`
 * run, which is rude and slow. The checks share the result of one
 * call, so they live as one adapter that emits 1-5 CheckResults.
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
        label: "workflow states",
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

    for (const [configured, state] of [
      [config.readyStatus, result.readyStatus],
      [config.inProgressStatus, result.inProgressStatus],
      [config.inReviewStatus, result.inReviewStatus],
    ] as const) {
      if (state.kind === "ok") {
        results.push({
          status: "ok",
          label: `workflow state "${configured}"`,
          detail: "present",
        });
      } else if (state.kind === "skipped") {
        results.push({
          status: "skip",
          label: `workflow state "${configured}"`,
          detail: state.reason,
        });
      } else {
        results.push({
          status: "fail",
          label: `workflow state "${configured}"`,
          detail: `not found on team; available: ${formatList(state.available)}`,
        });
      }
    }

    if (result.hitlLabel.kind === "ok") {
      results.push({
        status: "ok",
        label: `HITL label "${config.hitlLabel}"`,
        detail: "present",
      });
    } else if (result.hitlLabel.kind === "skipped") {
      results.push({
        status: "skip",
        label: `HITL label "${config.hitlLabel}"`,
        detail: result.hitlLabel.reason,
      });
    } else {
      results.push({
        status: "fail",
        label: `HITL label "${config.hitlLabel}"`,
        detail: `not found on team — set RUNWAY_HITL_LABEL or create the label. Available: ${formatList(result.hitlLabel.available)}`,
      });
    }

    return results;
  },
};

function formatList(items: readonly string[]): string {
  if (items.length === 0) return "(none)";
  return items.map((s) => `"${s}"`).join(", ");
}
