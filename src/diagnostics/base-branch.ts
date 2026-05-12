import { Effect } from "effect";
import { detectBaseBranch } from "../git.js";
import {
  type CheckResult,
  type Diagnostic,
  type DoctorContext,
  errMsg,
} from "./index.js";

/**
 * Reports the base branch a `runway run` would diff against. Honours
 * `RUNWAY_BASE_BRANCH` first; otherwise auto-detects from
 * origin/HEAD. Detection failure is a hard `fail` — the orchestrator
 * can't proceed without it.
 */
export const baseBranchDiagnostic: Diagnostic = {
  name: "base-branch",
  section: "Environment",
  tier: "both",
  async run(ctx: DoctorContext): Promise<readonly CheckResult[]> {
    const override = process.env.RUNWAY_BASE_BRANCH?.trim();
    if (override) {
      return [
        {
          status: "ok",
          label: "base branch",
          detail: `${override} (RUNWAY_BASE_BRANCH override)`,
        },
      ];
    }
    try {
      const detected = await Effect.runPromise(detectBaseBranch(ctx.cwd));
      return [
        {
          status: "ok",
          label: "base branch",
          detail: `${detected} (detected from origin/HEAD)`,
        },
      ];
    } catch (err) {
      return [
        {
          status: "fail",
          label: "base branch",
          detail: errMsg(err),
        },
      ];
    }
  },
};
