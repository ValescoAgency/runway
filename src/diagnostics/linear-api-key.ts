import {
  type CheckResult,
  type Diagnostic,
  type DoctorContext,
  envSet,
} from "./index.js";

/**
 * Hard requirement for any Linear-touching runway command. Missing
 * is `fail` (not `warn`) — without this the Linear configuration
 * section can't run at all.
 */
export const linearApiKeyDiagnostic: Diagnostic = {
  name: "linear-api-key",
  section: "Environment",
  tier: "both",
  async run(_ctx: DoctorContext): Promise<readonly CheckResult[]> {
    return [envSet("LINEAR_API_KEY", "fail")];
  },
};
