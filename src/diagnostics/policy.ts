import { loadPolicy } from "../policy.js";
import {
  type CheckResult,
  type Diagnostic,
  type DoctorContext,
  errMsg,
} from "./index.js";

/**
 * VA-352: surface the active impl-pass write-path policy so the
 * operator can see whether an agent run can touch CI workflows, etc.
 * `loadPolicy` falls back to a sensible default if `.runway/policy.yml`
 * is absent — that's still `ok`. Hard fail only when the YAML is
 * present but malformed.
 */
export const policyDiagnostic: Diagnostic = {
  name: "policy",
  section: "Environment",
  tier: "both",
  async run(ctx: DoctorContext): Promise<readonly CheckResult[]> {
    try {
      const policy = loadPolicy(ctx.cwd);
      return [
        {
          status: "ok",
          label: "impl policy",
          detail: `${policy.source} (${policy.forbiddenPaths.length} forbidden path${policy.forbiddenPaths.length === 1 ? "" : "s"})`,
        },
      ];
    } catch (err) {
      return [
        {
          status: "fail",
          label: "impl policy",
          detail: errMsg(err),
        },
      ];
    }
  },
};
