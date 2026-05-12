import type { CheckResult, Diagnostic, DoctorContext } from "./index.js";

export const nodeDiagnostic: Diagnostic = {
  name: "node",
  section: "Host tooling",
  tier: "both",
  async run(_ctx: DoctorContext): Promise<readonly CheckResult[]> {
    const nodeVersion = process.versions.node;
    const nodeMajor = Number.parseInt(nodeVersion.split(".")[0] ?? "0", 10);
    return [
      nodeMajor >= 22
        ? { status: "ok", label: "node", detail: `v${nodeVersion}` }
        : {
            status: "fail",
            label: "node",
            detail: `v${nodeVersion} — node ≥ 22 required`,
          },
    ];
  },
};
