import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { execa, type ExecaError } from "execa";
import {
  AUTH_MODE_ENV_VAR,
  expectedImageName,
  type ScaffolderOptions,
} from "./scaffolder.js";

/**
 * Phase 5: post-init verification. Confirms the scaffold landed where
 * we expect, the image was built (when not skipped), and — for
 * tier 2 — that `.env.schema` is properly shaped and no literal
 * secrets leaked into tracked files. Fails fast with a
 * `VERIFY FAIL: ...` error if anything is off.
 */
export async function verify(
  cwd: string,
  opts: ScaffolderOptions,
): Promise<void> {
  console.log(`[runway init] verify (tier ${opts.tier})`);
  const ok = (msg: string) => console.log(`  ✓ ${msg}`);
  const fail = (msg: string): never => {
    throw new Error(`VERIFY FAIL: ${msg}`);
  };

  if (!existsSync(join(cwd, ".sandcastle"))) fail(".sandcastle/ missing");
  if (!existsSync(join(cwd, ".sandcastle", "Dockerfile")))
    fail(".sandcastle/Dockerfile missing");
  ok(".sandcastle/Dockerfile present");

  if (!opts.skipBuild) {
    const imageName = expectedImageName(cwd);
    try {
      await execa("docker", ["image", "inspect", imageName], { cwd });
      ok(`docker image ${imageName} built`);
    } catch {
      fail(
        `docker image ${imageName} not found — build step must have failed`,
      );
    }
  }

  if (opts.tier === 1) {
    console.log("[runway init] verify OK (tier 1)");
    return;
  }

  // Tier 2 only.
  const schemaPath = join(cwd, ".env.schema");
  if (!existsSync(schemaPath))
    fail(".env.schema missing at repo root (tier 2 requires it)");
  const schema = readFileSync(schemaPath, "utf8");
  const anthropicEnvVar = AUTH_MODE_ENV_VAR[opts.authMode];
  if (!schema.includes(`${anthropicEnvVar}=`))
    fail(`.env.schema missing ${anthropicEnvVar} (auth-mode=${opts.authMode})`);
  if (!schema.includes("GH_TOKEN=")) fail(".env.schema missing GH_TOKEN");
  ok(`.env.schema declares ${anthropicEnvVar} + GH_TOKEN`);

  // Inline secret shape check.
  const secretRe =
    /(sk-ant-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|lin_api_[A-Za-z0-9]{20,})/;
  if (secretRe.test(schema)) {
    fail(
      ".env.schema appears to contain a real secret value — refactor to use op:// references",
    );
  }
  ok(".env.schema contains no inline secrets");

  const dockerfile = readFileSync(join(cwd, ".sandcastle", "Dockerfile"), "utf8");
  // Post-VA-413 the Dockerfile no longer inlines the shim (`varlock
  // run …` lives inside the vendored `.sandcastle/runway-claude-shim`
  // file). It does still rename the binary and COPY the vendored shim
  // over it, so those are the two on-Dockerfile signals.
  if (!dockerfile.includes("COPY runway-claude-shim"))
    fail("Dockerfile not patched with claude-shim COPY (run `runway upgrade-repo --force`)");
  if (!dockerfile.includes("/home/agent/.local/bin/claude.real"))
    fail("Dockerfile shim not in expected layout");
  ok("Dockerfile patched with claude-shim COPY");

  // VA-426 (sibling): the COPY above points at
  // `.sandcastle/runway-claude-shim`, which `runway init` and
  // `runway upgrade-repo` both materialise. Confirm it landed on disk
  // and carries the wrapper's signal lines so a truncated/empty file
  // doesn't slip past verify and trip on `docker build` instead.
  const shimPath = join(cwd, ".sandcastle", "runway-claude-shim");
  if (!existsSync(shimPath))
    fail(".sandcastle/runway-claude-shim missing (run `runway upgrade-repo --force`)");
  const shim = readFileSync(shimPath, "utf8");
  if (!shim.includes("varlock run --env-file"))
    fail(".sandcastle/runway-claude-shim doesn't invoke varlock — stale file?");
  if (!shim.includes("claude.real"))
    fail(".sandcastle/runway-claude-shim doesn't exec claude.real — stale file?");
  ok(".sandcastle/runway-claude-shim present and wraps claude.real via varlock");

  if (existsSync(join(cwd, ".sandcastle", ".env"))) {
    fail(".sandcastle/.env still on disk — tier 2 deletes it");
  }
  ok(".sandcastle/.env not on disk");

  // Scan tracked files for literal secrets (best-effort, skip .env.schema).
  try {
    const { stdout } = await execa("git", ["ls-files"], { cwd });
    const tracked = stdout.split("\n").filter(Boolean);
    for (const file of tracked) {
      if (file === ".env.schema") continue;
      const full = join(cwd, file);
      try {
        if (!statSync(full).isFile()) continue;
      } catch {
        continue;
      }
      let content: string;
      try {
        content = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      if (secretRe.test(content)) {
        fail(`found literal secret value in tracked file: ${file}`);
      }
    }
    ok("no literal secret values in tracked files");
  } catch (err) {
    // git ls-files can fail on a brand-new repo with no commits — that's fine.
    if ((err as ExecaError).exitCode !== undefined) {
      console.log("  ⚠  skipped tracked-file secret scan (no git index yet)");
    } else {
      throw err;
    }
  }

  console.log("[runway init] verify OK (tier 2)");
}
