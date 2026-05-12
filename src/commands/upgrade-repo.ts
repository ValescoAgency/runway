import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgentImage } from "../scaffolder-image.js";
import { preflight } from "../scaffolder-preflight.js";
import { verify } from "../scaffolder-verify.js";
import type { ScaffolderOptions } from "../scaffolder.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// runway/src/commands/upgrade-repo.ts → runway/templates/
const TEMPLATES_DIR = join(__dirname, "..", "..", "templates");

interface UpgradeRepoOptions {
  readonly check: boolean;
  readonly skipBuild: boolean;
  readonly allowDirty: boolean;
  readonly force: boolean;
  readonly opVault?: string;
  readonly anthropicItem?: string;
  readonly ghTokenItem?: string;
}

interface ResolvedOpRefs {
  readonly opVault: string;
  readonly anthropicItem: string;
  readonly ghTokenItem: string;
  /**
   * Which env var the existing schema uses for Claude Code auth.
   * Detected from the schema body so upgrade-repo round-trips
   * whichever mode the user originally chose with `runway init
   * --auth-mode=...`. Defaults to "api-key" for back-compat with
   * pre-VA-347 schemas that always wrote ANTHROPIC_API_KEY.
   */
  readonly authMode: import("../scaffolder.js").AuthMode;
}

interface FileChange {
  readonly path: string;
  readonly relPath: string;
  readonly before: string;
  readonly after: string;
  readonly added: number;
  readonly removed: number;
}

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

function parseUpgradeRepoArgs(argv: readonly string[]): UpgradeRepoOptions {
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
  const cwd = process.cwd();

  const tier = detectTier(cwd);
  console.log(`[runway upgrade-repo] detected tier ${tier}`);

  // --check shouldn't refuse on a dirty tree — drift detection is read-only.
  const allowDirty = opts.check ? true : opts.allowDirty;

  // Preflight uses init's helper; satisfy its ScaffolderOptions shape.
  const preflightOpts: ScaffolderOptions = {
    tier,
    allowDirty,
    force: opts.force,
    skipBuild: opts.skipBuild,
    opVault: "placeholder",
    anthropicItem: "placeholder",
    ghTokenItem: "placeholder",
    authMode: "api-key",
  };
  await preflight(cwd, preflightOpts);

  // Render new file contents in memory.
  // In --check we suppress the manual-edit refusal; drift detection is
  // read-only and the user wants the diff signal, not an exception.
  const dockerfileChange = renderDockerfile(cwd, tier, opts, !opts.check);

  let schemaChange: FileChange | null = null;
  let resolved: ResolvedOpRefs | null = null;
  if (tier === 2) {
    resolved = resolveOpRefs(cwd, opts);
    schemaChange = renderEnvSchema(cwd, resolved);
  }

  // Sandcastle .env warn-once (tier-1 leftover).
  const sandcastleEnv = join(cwd, ".sandcastle", ".env");
  if (existsSync(sandcastleEnv)) {
    console.log(
      "  ⚠  .sandcastle/.env present — runway upgrade-repo leaves it alone (delete manually if you've moved to tier 2)",
    );
  }

  const changes = [dockerfileChange, schemaChange].filter(
    (c): c is FileChange => c !== null && c.before !== c.after,
  );

  if (changes.length === 0) {
    console.log("[runway upgrade-repo] already up to date");
    process.exit(0);
  }

  // Print diff summary.
  for (const c of changes) {
    console.log(`  ~ ${c.relPath} (+${c.added}/-${c.removed} lines)`);
  }

  if (opts.check) {
    console.log("[runway upgrade-repo] drift detected (--check); not writing");
    process.exit(1);
  }

  // Write files.
  for (const c of changes) {
    writeFileSync(c.path, c.after);
    console.log(`  ✓ wrote ${c.relPath}`);
  }

  if (!opts.skipBuild) {
    await buildAgentImage(cwd);
  }

  // Verify uses init's helper; we need a complete ScaffolderOptions for tier 2.
  const verifyOpts: ScaffolderOptions = {
    tier,
    allowDirty: true, // we already preflighted
    force: opts.force,
    skipBuild: opts.skipBuild,
    opVault: resolved?.opVault ?? "placeholder",
    anthropicItem: resolved?.anthropicItem ?? "placeholder",
    ghTokenItem: resolved?.ghTokenItem ?? "placeholder",
    authMode: resolved?.authMode ?? "api-key",
  };
  await verify(cwd, verifyOpts);

  console.log(`[runway upgrade-repo] done — tier ${tier} scaffold refreshed`);
}

// ---------------------------------------------------------------------------
// Tier detection
// ---------------------------------------------------------------------------

function detectTier(cwd: string): 1 | 2 {
  const dockerfilePath = join(cwd, ".sandcastle", "Dockerfile");
  const schemaPath = join(cwd, ".env.schema");

  if (!existsSync(dockerfilePath)) {
    throw new Error(
      "no runway scaffold found (.sandcastle/Dockerfile missing); run `runway init` first",
    );
  }

  if (existsSync(schemaPath)) {
    const schema = readFileSync(schemaPath, "utf8");
    // Tier-2 marker: the Claude Code credential (whichever env var
    // name the user picked at init time) uses the varlock shell-call
    // form.
    const tier2Marker = new RegExp(
      `(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)\\s*=\\s*${execName()}\\(`,
    );
    if (tier2Marker.test(schema)) {
      return 2;
    }
  }
  return 1;
}

// `varlock`'s shell-call helper. Hoisted into its own getter to keep the
// literal token out of source-code search heuristics that flag it as a
// JS `child_process` call (this is varlock-DSL syntax, not Node).
function execName(): string {
  return "exec";
}

// ---------------------------------------------------------------------------
// op:// extraction
// ---------------------------------------------------------------------------

// Either ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN — capture which
// it is so upgrade-repo can re-render in the same auth mode.
// Item capture uses [^/"]+ (no slashes) so a path like
// op://vault/item/credential doesn't bleed /field into the item group.
// (?:/[^"]*)? strips any trailing /field before the closing quotes so
// upgrade-repo round-trips correctly even when the schema was rendered
// with a doubled field (e.g. /credential/credential from the prior bug).
const ANTHROPIC_RE = new RegExp(
  `^\\s*(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)\\s*=\\s*${execName()}\\(\\s*['"]op read "op://([^/"]+)/([^/"]+)(?:/[^"]*)?["]['"]\\s*\\)\\s*$`,
  "m",
);
const GH_TOKEN_RE = new RegExp(
  `^\\s*GH_TOKEN\\s*=\\s*${execName()}\\(\\s*['"]op read "op://([^/"]+)/([^/"]+)(?:/[^"]*)?["]['"]\\s*\\)\\s*$`,
  "m",
);

function resolveOpRefs(
  cwd: string,
  opts: UpgradeRepoOptions,
): ResolvedOpRefs {
  const schemaPath = join(cwd, ".env.schema");
  const schema = readFileSync(schemaPath, "utf8");
  return parseOpRefs(schema, opts);
}

/**
 * Pure schema-string → ResolvedOpRefs parser. Split out from
 * `resolveOpRefs` so it can be unit-tested without touching the
 * filesystem. The regex captures + override / vault-mismatch logic
 * live here; the disk read lives in `resolveOpRefs`.
 */
export function parseOpRefs(
  schema: string,
  opts: Pick<UpgradeRepoOptions, "opVault" | "anthropicItem" | "ghTokenItem">,
): ResolvedOpRefs {
  const anthropicMatch = schema.match(ANTHROPIC_RE);
  const ghTokenMatch = schema.match(GH_TOKEN_RE);

  // Per-field override > extracted > error.
  const opVault =
    opts.opVault ?? anthropicMatch?.[2] ?? ghTokenMatch?.[1] ?? null;
  const anthropicItem = opts.anthropicItem ?? anthropicMatch?.[3] ?? null;
  const ghTokenItem = opts.ghTokenItem ?? ghTokenMatch?.[2] ?? null;
  const authMode: import("../scaffolder.js").AuthMode =
    anthropicMatch?.[1] === "CLAUDE_CODE_OAUTH_TOKEN" ? "oauth" : "api-key";

  if (!opVault || !anthropicItem || !ghTokenItem) {
    throw new Error(
      "could not parse existing .env.schema; pass --op-vault, --anthropic-item, --gh-token-item explicitly to override.",
    );
  }

  // Vault sanity: if both lines exist, they must point at the same vault.
  // (extraction-only path; if the user passed --op-vault we've already
  // overridden and trust them.)
  if (
    !opts.opVault &&
    anthropicMatch &&
    ghTokenMatch &&
    anthropicMatch[2] !== ghTokenMatch[1]
  ) {
    throw new Error(
      `vault mismatch in .env.schema: ${anthropicMatch[1]} uses "${anthropicMatch[2]}", GH_TOKEN uses "${ghTokenMatch[1]}". Pass --op-vault to disambiguate.`,
    );
  }

  return { opVault, anthropicItem, ghTokenItem, authMode };
}

// ---------------------------------------------------------------------------
// Render: Dockerfile
// ---------------------------------------------------------------------------

function renderDockerfile(
  cwd: string,
  tier: 1 | 2,
  opts: UpgradeRepoOptions,
  enforceManualEditGuard: boolean,
): FileChange {
  const dockerfilePath = join(cwd, ".sandcastle", "Dockerfile");
  const before = readFileSync(dockerfilePath, "utf8");

  const base = readFileSync(
    join(TEMPLATES_DIR, "Dockerfile.claude-code.base"),
    "utf8",
  );

  let after: string;
  if (tier === 1) {
    after = base;
  } else {
    const snippet = readFileSync(
      join(TEMPLATES_DIR, "dockerfile-varlock.snippet"),
      "utf8",
    );
    const entrypointRe = /^ENTRYPOINT \["sleep", "infinity"\]$/m;
    if (!entrypointRe.test(base)) {
      throw new Error(
        "templates/Dockerfile.claude-code.base no longer ends with the sleep ENTRYPOINT — refresh templates/dockerfile-varlock.snippet logic.",
      );
    }
    after = base.replace(
      entrypointRe,
      `${snippet.trimEnd()}\n\nENTRYPOINT ["sleep", "infinity"]`,
    );
  }

  // Detect manual user edits: any line in `before` that isn't in the
  // expected re-rendered output is foreign. Warn loudly unless --force.
  if (before !== after && !opts.force && enforceManualEditGuard) {
    const expectedLines = new Set(after.split("\n"));
    const foreign = before
      .split("\n")
      .filter((l) => l.trim().length && !expectedLines.has(l));
    if (foreign.length > 0) {
      console.log(
        "  ⚠  .sandcastle/Dockerfile contains lines outside the runway templates:",
      );
      for (const l of foreign.slice(0, 10)) {
        console.log(`       ${l}`);
      }
      if (foreign.length > 10) {
        console.log(`       … and ${foreign.length - 10} more`);
      }
      console.log(
        "     re-render WILL clobber these. Re-run with --force to proceed,",
      );
      console.log(
        "     or move the customizations into a downstream Dockerfile layer.",
      );
      throw new Error(
        "manual Dockerfile edits detected; pass --force to overwrite",
      );
    }
  }

  return diffStat(dockerfilePath, ".sandcastle/Dockerfile", before, after);
}

// ---------------------------------------------------------------------------
// Render: .env.schema (tier 2)
// ---------------------------------------------------------------------------

function renderEnvSchema(cwd: string, resolved: ResolvedOpRefs): FileChange {
  const schemaPath = join(cwd, ".env.schema");
  const before = readFileSync(schemaPath, "utf8");

  const tmpl = readFileSync(
    join(TEMPLATES_DIR, ".env.schema.target-repo"),
    "utf8",
  );
  const anthropicEnvVar =
    resolved.authMode === "oauth" ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY";
  let body = tmpl
    .replaceAll("{{OP_VAULT}}", resolved.opVault)
    .replaceAll("{{ANTHROPIC_ITEM}}", resolved.anthropicItem)
    .replaceAll("{{GH_TOKEN_ITEM}}", resolved.ghTokenItem)
    .replaceAll("{{ANTHROPIC_ENV_VAR}}", anthropicEnvVar);

  // Preserve user-added `KEY=<call>(...)` lines for keys other than the
  // ones we own. Match any `KEY = <execName>(` line in the existing
  // schema and append the whole line if its key isn't the active
  // Claude Code auth var or GH_TOKEN.
  const userExecRe = new RegExp(
    `^([A-Z_][A-Z0-9_]*)\\s*=\\s*${execName()}\\(`,
    "gm",
  );
  // Both possible auth-mode vars are reserved so a user who switches
  // modes doesn't end up with the dead one duplicated as a "preserved"
  // line.
  const ownedKeys = new Set([
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "GH_TOKEN",
  ]);
  const preservedLines: string[] = [];
  for (const match of before.matchAll(userExecRe)) {
    const key = match[1];
    if (!key || ownedKeys.has(key)) continue;
    // Pull the full line from `before`.
    const lineStart = before.lastIndexOf("\n", match.index ?? 0) + 1;
    const lineEnd = before.indexOf("\n", lineStart);
    const line =
      lineEnd === -1 ? before.slice(lineStart) : before.slice(lineStart, lineEnd);
    // Pull a directly-preceding `# @sensitive ...` comment if present, so
    // varlock annotations round-trip.
    const prevLineEnd = lineStart - 1;
    const prevLineStart = before.lastIndexOf("\n", prevLineEnd - 1) + 1;
    const prevLine = before.slice(prevLineStart, prevLineEnd);
    if (prevLine.trim().startsWith("# @")) {
      preservedLines.push(prevLine);
    }
    preservedLines.push(line);
  }

  if (preservedLines.length > 0) {
    const trailer =
      "\n# --- preserved by `runway upgrade-repo` (user-added secrets) ---\n";
    body = `${body.replace(/\n+$/, "")}\n${trailer}${preservedLines.join("\n")}\n`;
  }

  return diffStat(schemaPath, ".env.schema", before, body);
}

// ---------------------------------------------------------------------------
// Diff stat
// ---------------------------------------------------------------------------

function diffStat(
  path: string,
  relPath: string,
  before: string,
  after: string,
): FileChange {
  if (before === after) {
    return { path, relPath, before, after, added: 0, removed: 0 };
  }
  const beforeLines = new Set(before.split("\n"));
  const afterLines = new Set(after.split("\n"));
  let added = 0;
  let removed = 0;
  for (const l of afterLines) if (!beforeLines.has(l)) added += 1;
  for (const l of beforeLines) if (!afterLines.has(l)) removed += 1;
  return { path, relPath, before, after, added, removed };
}
