import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ScaffolderOptions, TEMPLATES_DIR } from "./scaffolder.js";

/**
 * Phase 2: write `.sandcastle/Dockerfile` directly from the vendored
 * `templates/Dockerfile.claude-code.base`. We don't invoke
 * `sandcastle init` because it has unconditional interactive prompts
 * (sandbox provider, backlog manager, label creation) with no CLI
 * flag override — they hang in non-TTY environments. Runway only
 * uses sandcastle's programmatic `run()` API, which needs the
 * Dockerfile + a built image; nothing else `init` produces matters
 * for our use case.
 */
export async function writeDockerfile(
  cwd: string,
  opts: ScaffolderOptions,
): Promise<void> {
  const sandcastleDir = join(cwd, ".sandcastle");
  const dockerfilePath = join(sandcastleDir, "Dockerfile");

  if (existsSync(dockerfilePath) && !opts.force) {
    console.log(
      "[runway init] .sandcastle/Dockerfile already exists — skipping (pass --force to overwrite)",
    );
    return;
  }

  if (!existsSync(sandcastleDir)) {
    mkdirSync(sandcastleDir, { recursive: true });
  }

  const base = readFileSync(
    join(TEMPLATES_DIR, "Dockerfile.claude-code.base"),
    "utf8",
  );
  writeFileSync(dockerfilePath, base);
  console.log(`  ✓ wrote ${dockerfilePath}`);
}
