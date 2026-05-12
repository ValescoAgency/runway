import { type RepoUpgradeOptions, upgradeRepo } from "../repo-upgrade.js";

export function printUpgradeRepoUsage(): void {
  console.log(`runway upgrade-repo — refresh a target repo's runway scaffold

Re-renders \`.sandcastle/Dockerfile\` (and tier-2 \`.env.schema\`) from the
current vendored templates, preserving user-set values like the op:// vault
and item names. Use after a runway version bump that changed the Dockerfile
or template shape.

USAGE
  cd /path/to/your/target/repo
  runway upgrade-repo [--check] [--skip-build] [--allow-dirty] [--force]
                      [--op-vault=...] [--anthropic-item=...] [--gh-token-item=...]

OPTIONS
  --check             Dry-run. Compute the diff but do not write. Exits 0 if
                      already up to date, 1 if drift exists. Useful in CI.
  --skip-build        Don't \`docker build\` the agent image after rendering.
  --allow-dirty       Skip the "working tree clean" preflight check.
  --force             Overwrite even when the existing Dockerfile contains
                      lines outside the runway templates (manual edits).
  --op-vault=NAME     Override the 1Password vault. By default, upgrade-repo
                      extracts this from the existing .env.schema.
  --anthropic-item=N  Override the Claude Code credential item name
                      (i.e. the ANTHROPIC_API_KEY or
                      CLAUDE_CODE_OAUTH_TOKEN 1Password item).
  --gh-token-item=N   Override the GH_TOKEN item name.
  --help, -h          Show this help.

WHAT THIS COMMAND DOES
  1. Preflight: same checks as \`runway init\` (docker, gh, varlock, op, git).
  2. Detect tier from existing artefacts:
       - .env.schema present with op:// references → tier 2
       - .sandcastle/Dockerfile present, no .env.schema → tier 1
       - neither → error: run \`runway init\` first
  3. Tier 2: extract op://<vault>/<item> from the existing .env.schema so
     vault/item names round-trip. Override via flags if extraction fails.
  4. Re-render .sandcastle/Dockerfile from the vendored templates.
  5. Tier 2: re-render .env.schema, preserving user-added shell-call lines
     for keys other than ANTHROPIC_API_KEY and GH_TOKEN.
  6. Diff before writing. If unchanged → "already up to date". Otherwise
     write the new files and print a +N/-M summary per file.
  7. \`docker build\` the agent image (skip with --skip-build).
  8. Verify pass (same checks as \`runway init\`).

WHAT IT DOES NOT DO
  - Prompt for op:// values. They round-trip from the existing schema.
  - Touch \`.sandcastle/.env\` (only present in tier-1-style setups). It is
    left alone with a one-time warning.
  - Modify any non-template Dockerfile lines without --force.
`);
}

function parseUpgradeRepoArgs(argv: readonly string[]): RepoUpgradeOptions {
  let check = false;
  let skipBuild = false;
  let allowDirty = false;
  let force = false;
  let opVault: string | undefined;
  let anthropicItem: string | undefined;
  let ghTokenItem: string | undefined;

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      printUpgradeRepoUsage();
      process.exit(0);
    } else if (arg === "--check") {
      check = true;
    } else if (arg === "--skip-build") {
      skipBuild = true;
    } else if (arg === "--allow-dirty") {
      allowDirty = true;
    } else if (arg === "--force") {
      force = true;
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

  return {
    check,
    skipBuild,
    allowDirty,
    force,
    opVault,
    anthropicItem,
    ghTokenItem,
  };
}

export async function upgradeRepoCommand(
  argv: readonly string[],
): Promise<void> {
  const opts = parseUpgradeRepoArgs(argv);
  await upgradeRepo(process.cwd(), opts);
}
