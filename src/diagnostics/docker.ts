import { execa } from "execa";
import {
  type CheckResult,
  type Diagnostic,
  type DoctorContext,
  errMsg,
} from "./index.js";

/**
 * Two-step probe: `docker --version` proves the binary is on PATH;
 * `docker info` proves the daemon is reachable. Reporting the daemon
 * state separately makes "docker installed but Docker Desktop is
 * paused" a single-line diagnosis rather than a confused error.
 */
export const dockerDiagnostic: Diagnostic = {
  name: "docker",
  section: "Host tooling",
  tier: "both",
  async run(_ctx: DoctorContext): Promise<readonly CheckResult[]> {
    try {
      await execa("docker", ["--version"], { reject: true });
    } catch {
      return [
        {
          status: "fail",
          label: "docker",
          detail: "docker not on PATH (Docker Desktop or Podman)",
        },
      ];
    }
    try {
      await execa("docker", ["info"], { reject: true });
      return [{ status: "ok", label: "docker", detail: "daemon up" }];
    } catch (err) {
      return [
        {
          status: "fail",
          label: "docker",
          detail: `daemon not running — ${errMsg(err)}`,
        },
      ];
    }
  },
};
