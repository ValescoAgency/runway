import {
  type CheckResult,
  checkBinaryVersion,
  type Diagnostic,
  type DoctorContext,
} from "./index.js";

export const gitDiagnostic: Diagnostic = {
  name: "git",
  section: "Host tooling",
  tier: "both",
  async run(_ctx: DoctorContext): Promise<readonly CheckResult[]> {
    return [await checkBinaryVersion("git", ["--version"])];
  },
};
