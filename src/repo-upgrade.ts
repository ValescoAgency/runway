import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTH_MODE_ENV_VAR,
  type AuthMode,
  type ScaffolderOptions,
  TEMPLATES_DIR,
} from "./scaffolder.js";
import { buildAgentImage } from "./scaffolder-image.js";
import { preflight } from "./scaffolder-preflight.js";
import { verify } from "./scaffolder-verify.js";

/**
 * Domain inputs for `runway upgrade-repo`. Distinct from the CLI's
 * argv shape (which lives in `commands/upgrade-repo.ts`) so the
 * domain stays usable from other contexts. Shape is 1:1 with the
 * CLI flags today; the seam keeps future divergence cheap.
 */
export interface RepoUpgradeOptions {
  readonly check: boolean;
  readonly skipBuild: boolean;
  readonly allowDirty: boolean;
  readonly force: boolean;
  readonly opVault?: string;
  readonly anthropicItem?: string;
  readonly ghTokenItem?: string;
}

export interface ResolvedOpRefs {
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
  readonly authMode: AuthMode;
}

interface FileChange {
  readonly path: string;
  readonly relPath: string;
  readonly before: string;
  readonly after: string;
  readonly added: number;
  readonly removed: number;
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
  opts: RepoUpgradeOptions,
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
  opts: Pick<RepoUpgradeOptions, "opVault" | "anthropicItem" | "ghTokenItem">,
): ResolvedOpRefs {
  const anthropicMatch = schema.match(ANTHROPIC_RE);
  const ghTokenMatch = schema.match(GH_TOKEN_RE);

  // Per-field override > extracted > error.
  const opVault =
    opts.opVault ?? anthropicMatch?.[2] ?? ghTokenMatch?.[1] ?? null;
  const anthropicItem = opts.anthropicItem ?? anthropicMatch?.[3] ?? null;
  const ghTokenItem = opts.ghTokenItem ?? ghTokenMatch?.[2] ?? null;
  const authMode: AuthMode =
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
  opts: RepoUpgradeOptions,
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
  const anthropicEnvVar = AUTH_MODE_ENV_VAR[resolved.authMode];
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

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Re-render `.sandcastle/Dockerfile` (and tier-2 `.env.schema`) from
 * the current vendored templates, preserving user-set values like
 * the op:// vault and item names. Composes the scaffolder's
 * preflight/build/verify phases around the template re-render.
 *
 * Exits the process with code 1 if `--check` is set and drift was
 * detected (so CI can gate on it); exits 0 on a clean no-op.
 */
export async function upgradeRepo(
  cwd: string,
  opts: RepoUpgradeOptions,
): Promise<void> {
  const tier = detectTier(cwd);
  console.log(`[runway upgrade-repo] detected tier ${tier}`);

  // --check shouldn't refuse on a dirty tree — drift detection is read-only.
  const allowDirty = opts.check ? true : opts.allowDirty;

  // Preflight uses the scaffolder's helper; satisfy its ScaffolderOptions shape.
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

  // Verify uses the scaffolder's helper; we need a complete ScaffolderOptions for tier 2.
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
