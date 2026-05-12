import {
  type CheckResult,
  type Diagnostic,
  type DoctorContext,
  envSet,
} from "./index.js";

/**
 * Tier-2 only. varlock uses OP_SERVICE_ACCOUNT_TOKEN inside the
 * container to resolve `op://` references; without it the container
 * boots but Claude Code / GH auth resolution fails opaquely.
 */
export const opTokenDiagnostic: Diagnostic = {
  name: "op-token",
  section: "Environment",
  tier: "tier-2",
  async run(_ctx: DoctorContext): Promise<readonly CheckResult[]> {
    return [envSet("OP_SERVICE_ACCOUNT_TOKEN", "fail")];
  },
};
