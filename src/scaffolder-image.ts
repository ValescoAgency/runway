import { execa } from "execa";
import { expectedImageName } from "./scaffolder.js";

/**
 * Phase 4 (optional — skipped if `--skip-build`): `docker build` the
 * .sandcastle/ Dockerfile so the image is ready for the first
 * `runway run`. Build args align AGENT_UID/AGENT_GID to the host
 * user so bind-mounts don't trip on permissions. Mirrors what
 * `sandcastle docker build-image` does.
 */
export async function buildAgentImage(cwd: string): Promise<void> {
  const imageName = expectedImageName(cwd);

  const uid = String(process.getuid?.() ?? 1000);
  const gid = String(process.getgid?.() ?? 1000);

  console.log(
    `[runway init] building agent image ${imageName} (this can take ~2–5 min on first run)`,
  );
  await execa(
    "docker",
    [
      "build",
      "--build-arg",
      `AGENT_UID=${uid}`,
      "--build-arg",
      `AGENT_GID=${gid}`,
      "-t",
      imageName,
      ".sandcastle",
    ],
    { cwd, stdio: "inherit" },
  );
  console.log(`  ✓ built ${imageName}`);
}
