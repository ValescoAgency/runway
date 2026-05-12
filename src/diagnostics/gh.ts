import { execa } from "execa";
import {
  type CheckResult,
  type Diagnostic,
  type DoctorContext,
  errMsg,
} from "./index.js";

/**
 * `gh auth status` reports the host header on its first non-empty
 * line — we surface that as the detail so the operator can see
 * which gh hostname is authenticated.
 */
export const ghDiagnostic: Diagnostic = {
  name: "gh",
  section: "Host tooling",
  tier: "both",
  async run(_ctx: DoctorContext): Promise<readonly CheckResult[]> {
    try {
      await execa("gh", ["--version"], { reject: true });
    } catch {
      return [
        {
          status: "fail",
          label: "gh",
          detail: "gh not on PATH",
        },
      ];
    }
    try {
      const { stdout, stderr } = await execa("gh", ["auth", "status"], {
        reject: true,
      });
      const summary = ((stdout || stderr || "") as string)
        .split("\n")
        .map((s) => s.trim())
        .find((s) => s.length > 0);
      return [
        {
          status: "ok",
          label: "gh",
          detail: summary ?? "authenticated",
        },
      ];
    } catch (err) {
      return [
        {
          status: "fail",
          label: "gh",
          detail: `not authenticated — ${errMsg(err)}`,
        },
      ];
    }
  },
};
