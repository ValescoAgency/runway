import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execa, type ExecaError } from "execa";

const __dirname = dirname(fileURLToPath(import.meta.url));
// runway/src/commands/init.ts → runway/templates/
const TEMPLATES_DIR = join(__dirname, "..", "..", "templates");

export interface InitOptions {
  readonly tier: 1 | 2;
  readonly opVault?: string;
  readonly anthropicItem?: string;
  readonly ghTokenItem?: string;
  readonly allowDirty: boolean;
  readonly force: boolean;
  readonly skipBuild: boolean;
}

export function printInitUsage(): void {
  console.log(`runway init — scaffold a target repo for runway consumption

Wraps \`npx sandcastle init\` and layers on Valesco's customizations:
varlock + 1Password CLI inside the container, claude shim, drop-the-.env
posture. Run from the target repo's root.

USAGE
  cd /path/to/your/target/repo
  runway init [--tier=2] [--op-vault=... --anthropic-item=... --gh-token-item=...]
              [--allow-dirty] [--force] [--skip-build]

OPTIONS
  --tier=1            Plain sandcastle scaffold. No varlock; secrets need
                      another mechanism (env vars, repo .env, etc.).
  --tier=2            DEFAULT. Adds varlock + 1Password CLI inside the
                      container. Zero secrets at rest.
  --op-vault=NAME     1Password vault name (e.g. "runway"). Required for tier 2.
  --anthropic-item=N  Item name in the vault that holds ANTHROPIC_API_KEY. Required for tier 2.
  --gh-token-item=N   Item name in the vault that holds GH_TOKEN. Required for tier 2.
  --allow-dirty       Skip the "working tree clean" preflight check.
  --force             Overwrite an existing .sandcastle/Dockerfile.
  --skip-build        Don't \`docker build\` the agent image. Faster init,
                      slower first \`runway run\` (image builds then).
  --help, -h          Show this help.

NOTE
  No --op-account flag — runway uses 1Password service-account auth
  exclusively (OP_SERVICE_ACCOUNT_TOKEN). The token already encodes
  which 1Password tenant to talk to, so the op:// URI omits the
  account segment: \`op://<vault>/<item>\` rather than
  \`op://<account>/<vault>/<item>\`.

WHAT THIS COMMAND DOES
  1. Preflight: docker, gh, node, (tier 2) varlock + op CLI, git state.
  2. Write .sandcastle/Dockerfile (vendored claude-code base; tier 2
     also splices in the varlock + op CLI + claude shim layer).
  3. (Tier 2) Write .env.schema at repo root with op:// references.
  4. \`docker build\` the agent image (skip with --skip-build).
  5. Verify: no inline secrets, Dockerfile correct shape, image present.

WHAT IT DOES NOT DO
  - Run \`sandcastle init\`. Sandcastle's interactive prompts hang in
    non-TTY environments, and runway uses sandcastle's programmatic
    \`run()\` API which only needs the Dockerfile + image — none of
    the prompt.md / main.ts / config.json artifacts \`init\` produces.
  - Push or open a PR. You review and ship.
  - Touch 1Password. You're responsible for putting items in your vault.
  - Modify .github/workflows/.
`);
}

function parseInitArgs(argv: readonly string[]): InitOptions {
  let tier: 1 | 2 = 2;
  let opVault: string | undefined;
  let anthropicItem: string | undefined;
  let ghTokenItem: string | undefined;
  let allowDirty = false;
  let force = false;
  let skipBuild = false;

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      printInitUsage();
      process.exit(0);
    } else if (arg === "--tier=1") {
      tier = 1;
    } else if (arg === "--tier=2") {
      tier = 2;
    } else if (arg === "--allow-dirty") {
      allowDirty = true;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--skip-build") {
      skipBuild = true;
    } else if (arg.startsWith("--op-vault=")) {
      opVault = arg.slice("--op-vault=".length);
    } else if (arg.startsWith("--anthropic-item=")) {
      anthropicItem = arg.slice("--anthropic-item=".length);
    } else if (arg.startsWith("--gh-token-item=")) {
      ghTokenItem = arg.slice("--gh-token-item=".length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (tier === 2) {
    const missing: string[] = [];
    if (!opVault) missing.push("--op-vault");
    if (!anthropicItem) missing.push("--anthropic-item");
    if (!ghTokenItem) missing.push("--gh-token-item");
    if (missing.length) {
      throw new Error(
        `tier 2 requires ${missing.join(", ")} (or pass --tier=1 to skip varlock)`,
      );
    }
  }

  return {
    tier,
    opVault,
    anthropicItem,
    ghTokenItem,
    allowDirty,
    force,
    skipBuild,
  };
}

export async function initCommand(argv: readonly string[]): Promise<void> {
  const opts = parseInitArgs(argv);
  const cwd = process.cwd();

  await preflight(cwd, opts);
  await writeDockerfile(cwd, opts);
  if (opts.tier === 2) {
    await applyVarlockLayer(cwd, opts);
  }
  if (!opts.skipBuild) {
    await buildAgentImage(cwd);
  }
  await verify(cwd, opts);

  console.log(`[runway init] done — tier ${opts.tier} scaffold applied`);
  console.log("[runway init] next steps:");
  console.log("  1. Review the diff (`git diff` and `git status`)");
  console.log("  2. Create a feature branch and commit");
  console.log("  3. Open a PR; merge after review");
  if (opts.tier === 2) {
    console.log(
      "  4. Confirm the op:// items exist in your 1Password vault before the first runway run",
    );
  }
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

export async function preflight(cwd: string, opts: InitOptions): Promise<void> {
  console.log(`[runway init] preflight (tier ${opts.tier})`);
  const ok = (msg: string) => console.log(`  ✓ ${msg}`);
  const fail = (msg: string): never => {
    throw new Error(`PREFLIGHT FAIL: ${msg}`);
  };

  await checkBinary("git", "git not on PATH");
  ok("git");

  const nodeVersion = process.versions.node;
  const nodeMajor = Number.parseInt(nodeVersion.split(".")[0] ?? "0", 10);
  if (nodeMajor < 22) fail(`node ≥ 22 required, found v${nodeVersion}`);
  ok(`node v${nodeVersion}`);

  await checkBinary("docker", "docker not on PATH (Docker Desktop or Podman)");
  await execa("docker", ["info"], { cwd }).catch(() =>
    fail("docker daemon not running — start Docker Desktop"),
  );
  ok("docker daemon up");

  await checkBinary("gh", "gh not on PATH");
  await execa("gh", ["auth", "status"], { cwd }).catch(() =>
    fail("gh not authenticated — run `gh auth login`"),
  );
  ok("gh authenticated");

  if (opts.tier === 2) {
    await checkBinary(
      "varlock",
      "varlock not on PATH (`brew install varlock` or `pnpm add -g varlock`)",
    );
    ok("varlock");
    await checkBinary("op", "1Password CLI (`op`) not on PATH");
    ok("op");
  }

  await execa("git", ["rev-parse", "--git-dir"], { cwd }).catch(() =>
    fail("not inside a git repo"),
  );
  const { stdout: top } = await execa("git", ["rev-parse", "--show-toplevel"], {
    cwd,
  });
  ok(`git repo: ${top}`);

  if (!opts.allowDirty) {
    const { stdout: porcelain } = await execa("git", ["status", "--porcelain"], {
      cwd,
    });
    if (porcelain.trim().length) {
      fail("working tree is dirty — commit/stash first, or pass --allow-dirty");
    }
  }
  ok("working tree clean (or --allow-dirty)");

  // Empty-repo case: no HEAD yet → that's fine.
  try {
    const { stdout: head } = await execa(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd },
    );
    if (head === "main" || head === "master") {
      console.log(
        `  ⚠  on default branch (${head}) — caller must create a feature branch before staging`,
      );
    }
  } catch {
    console.log("  ⚠  repo has no commits yet — caller will commit on a fresh branch");
  }

  console.log("[runway init] preflight OK");
}

async function checkBinary(bin: string, errMsg: string): Promise<void> {
  try {
    await execa("command", ["-v", bin], { shell: true });
  } catch {
    throw new Error(`PREFLIGHT FAIL: ${errMsg}`);
  }
}

// ---------------------------------------------------------------------------
// Dockerfile
// ---------------------------------------------------------------------------

/**
 * Write `.sandcastle/Dockerfile` directly from the vendored
 * `templates/Dockerfile.claude-code.base`. We don't invoke
 * `sandcastle init` because it has unconditional interactive prompts
 * (sandbox provider, backlog manager, label creation) with no CLI
 * flag override — they hang in non-TTY environments. Runway only
 * uses sandcastle's programmatic `run()` API, which needs the
 * Dockerfile + a built image; nothing else `init` produces matters
 * for our use case.
 */
export async function writeDockerfile(cwd: string, opts: InitOptions): Promise<void> {
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

// ---------------------------------------------------------------------------
// Build agent image
// ---------------------------------------------------------------------------

/**
 * `docker build` the .sandcastle/ Dockerfile so the image is ready
 * for the first `runway run`. Skipped if --skip-build was passed.
 *
 * Image name follows sandcastle's convention: `sandcastle:<sanitized-dirname>`
 * (defaultImageName from @ai-hero/sandcastle's mountUtils.ts). Build args
 * align AGENT_UID/AGENT_GID to the host user so bind-mounts don't trip on
 * permissions. Mirrors what `sandcastle docker build-image` does.
 */
export async function buildAgentImage(cwd: string): Promise<void> {
  const dirName =
    cwd
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? "local";
  const sanitized =
    dirName.toLowerCase().replace(/[^a-z0-9_.-]/g, "-") || "local";
  const imageName = `sandcastle:${sanitized}`;

  const uid = String(process.getuid?.() ?? 1000);
  const gid = String(process.getgid?.() ?? 1000);

  console.log(`[runway init] building agent image ${imageName} (this can take ~2–5 min on first run)`);
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

// ---------------------------------------------------------------------------
// Varlock layer (tier 2 only)
// ---------------------------------------------------------------------------

export async function applyVarlockLayer(
  cwd: string,
  opts: InitOptions,
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
  const rendered = schemaTemplate
    .replaceAll("{{OP_VAULT}}", opts.opVault!)
    .replaceAll("{{ANTHROPIC_ITEM}}", opts.anthropicItem!)
    .replaceAll("{{GH_TOKEN_ITEM}}", opts.ghTokenItem!);
  writeFileSync(schemaPath, rendered);
  console.log(
    `  ✓ wrote .env.schema (op://${opts.opVault}/...)`,
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

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

export async function verify(cwd: string, opts: InitOptions): Promise<void> {
  console.log(`[runway init] verify (tier ${opts.tier})`);
  const ok = (msg: string) => console.log(`  ✓ ${msg}`);
  const fail = (msg: string): never => {
    throw new Error(`VERIFY FAIL: ${msg}`);
  };

  if (!existsSync(join(cwd, ".sandcastle"))) fail(".sandcastle/ missing");
  if (!existsSync(join(cwd, ".sandcastle", "Dockerfile")))
    fail(".sandcastle/Dockerfile missing");
  ok(".sandcastle/Dockerfile present");

  // Image presence — if we built it, confirm `docker images` sees it.
  if (!opts.skipBuild) {
    const dirName =
      cwd
        .replace(/[\\/]+$/, "")
        .split(/[\\/]/)
        .pop() ?? "local";
    const imageName = `sandcastle:${
      dirName.toLowerCase().replace(/[^a-z0-9_.-]/g, "-") || "local"
    }`;
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
  if (!schema.includes("ANTHROPIC_API_KEY=")) fail(".env.schema missing ANTHROPIC_API_KEY");
  if (!schema.includes("GH_TOKEN=")) fail(".env.schema missing GH_TOKEN");
  ok(".env.schema declares ANTHROPIC_API_KEY + GH_TOKEN");

  // Inline secret shape check.
  const secretRe = /(sk-ant-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|lin_api_[A-Za-z0-9]{20,})/;
  if (secretRe.test(schema)) {
    fail(".env.schema appears to contain a real secret value — refactor to use op:// references");
  }
  ok(".env.schema contains no inline secrets");

  const dockerfile = readFileSync(join(cwd, ".sandcastle", "Dockerfile"), "utf8");
  if (!dockerfile.includes("varlock run --env-file"))
    fail("Dockerfile not patched with varlock shim");
  if (!dockerfile.includes("/home/agent/.local/bin/claude.real"))
    fail("Dockerfile shim not in expected layout");
  ok("Dockerfile patched with varlock + claude shim");

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
