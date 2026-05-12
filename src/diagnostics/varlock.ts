import {
  type CheckResult,
  checkBinaryVersion,
  type Diagnostic,
  type DoctorContext,
} from "./index.js";

export const varlockDiagnostic: Diagnostic = {
  name: "varlock",
  section: "Host tooling",
  tier: "tier-2",
  async run(_ctx: DoctorContext): Promise<readonly CheckResult[]> {
    return [await checkBinaryVersion("varlock", ["--version"])];
  },
};
