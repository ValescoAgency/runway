import {
  type AuthMode,
  scaffold,
  type ScaffolderOptions,
} from "../scaffolder.js";

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
  --anthropic-item=N  Item name in the vault that holds the Claude Code
                      credential (ANTHROPIC_API_KEY or
                      CLAUDE_CODE_OAUTH_TOKEN — see --auth-mode).
                      Required for tier 2.
  --gh-token-item=N   Item name in the vault that holds GH_TOKEN. Required for tier 2.
  --auth-mode=MODE    How Claude Code authenticates inside the
                      container. \`api-key\` (default) writes the
                      ANTHROPIC_API_KEY env var for pay-per-token API
                      keys (sk-ant-api03-…). \`oauth\` writes
                      CLAUDE_CODE_OAUTH_TOKEN for Pro/Max
                      subscription tokens from \`claude setup-token\`
                      (sk-ant-oat01-…). They are NOT interchangeable.
  --allow-dirty       Skip the "working tree clean" preflight check.
  --force             Overwrite an existing .sandcastle/Dockerfile.
  --skip-build        Don't \`docker build\` the agent image. Faster init,
                      slower first \`runway run\` (image builds then).
  --help, -h          Show this help.

NOTE
  No --op-account flag — runway uses 1Password service-account auth
  exclusively (OP_SERVICE_ACCOUNT_TOKEN). The token already encodes
  which 1Password tenant to talk to, so the op:// URI omits the
  account segment: \`op://<vault>/<item>/<field>\` rather than
  \`op://<account>/<vault>/<item>/<field>\`. Runway hard-codes the
  \`credential\` field, which is the canonical field name on
  1Password API_CREDENTIAL items.

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

function parseInitArgs(argv: readonly string[]): ScaffolderOptions {
  let tier: 1 | 2 = 2;
  let opVault: string | undefined;
  let anthropicItem: string | undefined;
  let ghTokenItem: string | undefined;
  let authMode: AuthMode = "api-key";
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
    } else if (arg.startsWith("--auth-mode=")) {
      const v = arg.slice("--auth-mode=".length);
      if (v !== "api-key" && v !== "oauth") {
        throw new Error(
          `--auth-mode must be "api-key" or "oauth", got "${v}"`,
        );
      }
      authMode = v;
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
    authMode,
    allowDirty,
    force,
    skipBuild,
  };
}

export async function initCommand(argv: readonly string[]): Promise<void> {
  const opts = parseInitArgs(argv);
  await scaffold(process.cwd(), opts);
}
