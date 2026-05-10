import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

interface UpgradeOptions {
  readonly force: boolean;
  readonly check: boolean;
}

export function printUpgradeUsage(): void {
  console.log(`runway upgrade — update the runway CLI itself

Pulls the latest \`master\` of your local runway clone, reinstalls
dependencies, and re-typechecks. Run from anywhere; the command
locates its own clone via \`import.meta.url\`.

USAGE
  runway upgrade [--force] [--check]

OPTIONS
  --force       Skip the dirty-tree / non-default-branch refusals.
  --check       Print "current vs latest" without actually pulling.
  --help, -h    Show this help.

WHAT THIS COMMAND DOES
  1. Resolve the runway clone root from the running script's path.
  2. Refuse if the clone is dirty or on a non-master branch (--force overrides).
  3. \`git fetch --tags\` and \`git pull --ff-only\` against origin/master.
  4. \`pnpm install\` (lockfile may have changed).
  5. \`pnpm typecheck\` as a final sanity check (warns, does not fail).
`);
}

function parseUpgradeArgs(argv: readonly string[]): UpgradeOptions {
  let force = false;
  let check = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      printUpgradeUsage();
      process.exit(0);
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--check") {
      check = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { force, check };
}

/**
 * Resolve the runway clone root by walking up from this file. Compiled
 * or run via tsx, this file lives at `<root>/src/commands/upgrade.ts`,
 * so the root is two `dirname` hops up.
 *
 * Sanity-check: the resolved root's package.json must declare
 * `"name": "@valescoagency/runway"`. Anything else means the binary
 * is being executed from an unexpected layout (e.g. published npm
 * tarball) and self-update doesn't apply.
 */
function resolveRunwayRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = dirname(dirname(here));
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) {
    throw new Error(
      `[runway upgrade] could not locate package.json at expected root: ${root}`,
    );
  }
  let pkg: { name?: string; version?: string };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch (err) {
    throw new Error(
      `[runway upgrade] failed to parse ${pkgPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (pkg.name !== "@valescoagency/runway") {
    throw new Error(
      `[runway upgrade] resolved root ${root} is not the runway clone (package.json name="${pkg.name}"). ` +
        "self-update only works from a git clone of ValescoAgency/runway.",
    );
  }
  return root;
}

function readVersion(root: string): string {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return typeof pkg.version === "string" ? pkg.version : "unknown";
}

export async function upgradeCommand(argv: readonly string[]): Promise<void> {
  const opts = parseUpgradeArgs(argv);
  const root = resolveRunwayRoot();

  // Detect npm-installed vs git-clone. An npm install has no .git/ at
  // the package root; a git clone does. The two flavors have completely
  // different upgrade paths.
  const isGitClone = existsSync(join(root, ".git"));
  if (!isGitClone) {
    const current = readVersion(root);
    console.log(`[runway upgrade] running from an npm install at ${root}`);
    console.log(`[runway upgrade] current: ${current}`);
    console.log(
      "[runway upgrade] self-update via the same package manager you used to install:",
    );
    console.log("    pnpm install -g @valescoagency/runway@latest");
    console.log("    npm install -g @valescoagency/runway@latest");
    console.log("    yarn global add @valescoagency/runway@latest");
    console.log(
      "[runway upgrade] (runway can't reliably self-replace its own binary; pick one and run it manually)",
    );
    return;
  }

  console.log(`[runway upgrade] runway clone: ${root}`);

  // --check: fetch and diff HEAD vs origin/master, then exit.
  if (opts.check) {
    await runFetch(root);
    const localSha = (
      await execa("git", ["rev-parse", "HEAD"], { cwd: root })
    ).stdout.trim();
    const remoteSha = (
      await execa("git", ["rev-parse", "origin/master"], { cwd: root })
    ).stdout.trim();
    const current = readVersion(root);
    console.log(`[runway upgrade] current: ${current} (${localSha.slice(0, 7)})`);
    console.log(
      `[runway upgrade] origin/master: ${remoteSha.slice(0, 7)}`,
    );
    if (localSha === remoteSha) {
      console.log("[runway upgrade] already up to date");
    } else {
      console.log(
        "[runway upgrade] update available — run `runway upgrade` to apply",
      );
    }
    return;
  }

  // Refuse on dirty tree.
  const { stdout: porcelain } = await execa(
    "git",
    ["status", "--porcelain"],
    { cwd: root },
  );
  if (porcelain.trim().length && !opts.force) {
    throw new Error(
      "runway clone has uncommitted changes — commit/stash first, or pass --force",
    );
  }

  // Refuse on non-master branch.
  const { stdout: branch } = await execa(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    { cwd: root },
  );
  if (branch.trim() !== "master" && !opts.force) {
    throw new Error(
      `runway clone is on branch "${branch.trim()}" (expected "master") — switch to master, or pass --force`,
    );
  }

  const before = readVersion(root);
  console.log(`[runway upgrade] current: ${before}`);

  await runFetch(root);

  // Fast-forward pull.
  try {
    await execa("git", ["pull", "--ff-only", "origin", "master"], {
      cwd: root,
      stdio: "inherit",
    });
  } catch {
    throw new Error(
      "git pull --ff-only failed (likely non-fast-forward). " +
        "Resolve manually in the runway clone, then re-run `runway upgrade`.",
    );
  }

  // pnpm install — lockfile may have changed.
  try {
    await execa("pnpm", ["install"], { cwd: root, stdio: "inherit" });
  } catch {
    throw new Error(
      "pnpm install failed — git pull already succeeded, so the clone is on the new ref. " +
        "Run `pnpm install` manually in " +
        root +
        " to recover.",
    );
  }

  const after = readVersion(root);
  if (before === after) {
    console.log("[runway upgrade] already up to date");
  } else {
    console.log(`[runway upgrade] upgraded: ${before} → ${after}`);
  }

  // Final typecheck — warn but don't fail.
  try {
    await execa("pnpm", ["typecheck"], { cwd: root, stdio: "inherit" });
    console.log("[runway upgrade] typecheck OK");
  } catch {
    console.log(
      "[runway upgrade] ⚠  pnpm typecheck reported errors — clone is on the new ref but may need attention",
    );
  }
}

async function runFetch(root: string): Promise<void> {
  try {
    await execa("git", ["fetch", "--tags", "origin"], {
      cwd: root,
      stdio: "inherit",
    });
  } catch {
    throw new Error(
      "git fetch failed — check network connectivity and that `origin` is reachable",
    );
  }
}
