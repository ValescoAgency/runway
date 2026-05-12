import {
  type CheckResult,
  checkBinaryVersion,
  type Diagnostic,
  type DoctorContext,
} from "./index.js";

export const opDiagnostic: Diagnostic = {
  name: "op",
  section: "Host tooling",
  tier: "tier-2",
  async run(_ctx: DoctorContext): Promise<readonly CheckResult[]> {
    return [await checkBinaryVersion("op", ["--version"])];
  },
};
