import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTH_MODE_ENV_VAR,
  type ScaffolderOptions,
  TEMPLATES_DIR,
} from "./scaffolder.js";

/**
 * Phase 3 (tier 2 only): layer varlock + 1Password CLI on top of
 * the base Dockerfile so the container can resolve `op://` references
 * at agent run time. Writes `.env.schema` at the repo root, patches
 * the Dockerfile entrypoint, deletes the sandcastle .env shim, and
 * makes sure `.env.schema.bak` is gitignored.
 */
export async function applyVarlockLayer(
  cwd: string,
  opts: ScaffolderOptions,
): Promise<void> {
  console.log("[runway init] applying tier 2 (varlock + 1Password) layer");

  // 1. .env.schema at repo root.
  const schemaPath = join(cwd, ".env.schema");
  if (existsSync(schemaPath)) {
    console.log("  ⚠  .env.schema already exists — backing up to .env.schema.bak");
    writeFileSync(`${schemaPath}.bak`, readFileSync(schemaPath, "utf8"));
  }
  const schemaTemplate = readFileSync(
    join(TEMPLATES_DIR, ".env.schema.target-repo"),
    "utf8",
  );
  const anthropicEnvVar = AUTH_MODE_ENV_VAR[opts.authMode];
  const rendered = schemaTemplate
    .replaceAll("{{OP_VAULT}}", opts.opVault!)
    .replaceAll("{{ANTHROPIC_ITEM}}", opts.anthropicItem!)
    .replaceAll("{{GH_TOKEN_ITEM}}", opts.ghTokenItem!)
    .replaceAll("{{ANTHROPIC_ENV_VAR}}", anthropicEnvVar);
  writeFileSync(schemaPath, rendered);
  console.log(
    `  ✓ wrote .env.schema (auth-mode=${opts.authMode}, ${anthropicEnvVar}, op://${opts.opVault}/...)`,
  );

  // 2. Patch Dockerfile.
  const dockerfilePath = join(cwd, ".sandcastle", "Dockerfile");
  if (!existsSync(dockerfilePath)) {
    throw new Error(`.sandcastle/Dockerfile missing at ${dockerfilePath}`);
  }
  const dockerfile = readFileSync(dockerfilePath, "utf8");
  if (dockerfile.includes("varlock run --env-file")) {
    console.log("  ✓ Dockerfile already patched (idempotent skip)");
  } else {
    const entrypointRe = /^ENTRYPOINT \["sleep", "infinity"\]$/m;
    if (!entrypointRe.test(dockerfile)) {
      throw new Error(
        `expected \`ENTRYPOINT ["sleep", "infinity"]\` line in ${dockerfilePath}.\n` +
          "Sandcastle may have changed its template; update templates/dockerfile-varlock.snippet",
      );
    }
    const snippet = readFileSync(
      join(TEMPLATES_DIR, "dockerfile-varlock.snippet"),
      "utf8",
    );
    const patched = dockerfile.replace(
      entrypointRe,
      `${snippet.trimEnd()}\n\nENTRYPOINT ["sleep", "infinity"]`,
    );
    writeFileSync(dockerfilePath, patched);
    console.log(`  ✓ patched ${dockerfilePath} (varlock + op CLI + claude shim)`);
  }

  // 3. Drop .sandcastle/.env and .env.example.
  for (const f of [".sandcastle/.env", ".sandcastle/.env.example"]) {
    const p = join(cwd, f);
    if (existsSync(p)) {
      rmSync(p);
      console.log(`  ✓ removed ${f}`);
    }
  }

  // 4. .gitignore: keep .env.schema.bak out of commits.
  const gitignorePath = join(cwd, ".gitignore");
  if (existsSync(gitignorePath)) {
    const gi = readFileSync(gitignorePath, "utf8");
    if (!gi.split("\n").includes(".env.schema.bak")) {
      writeFileSync(
        gitignorePath,
        gi.endsWith("\n")
          ? `${gi}.env.schema.bak\n`
          : `${gi}\n.env.schema.bak\n`,
      );
      console.log("  ✓ appended .env.schema.bak to .gitignore");
    }
  }
}
