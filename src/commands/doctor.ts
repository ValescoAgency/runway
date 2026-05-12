import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AuthMode,
  DIAGNOSTICS,
  type DoctorContext,
  type DoctorOptions,
  type RepoState,
  type Tier,
  runDiagnostics,
} from "../diagnostics/index.js";
import { renderJson, renderText } from "../diagnostics/render.js";

// ---------------------------------------------------------------------------
// Required sections — failures in any of these set the exit code to 1.
// "Repo state" is informational only (dirty tree, no scaffold) so its
// failures don't affect the exit code.
// ---------------------------------------------------------------------------

const REQUIRED_SECTIONS = new Set<string>([
  "Host tooling",
  "Environment",
  "Docker image",
  "Linear configuration",
]);

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export function printDoctorUsage(): void {
  console.log(`runway doctor — read-only preflight diagnostic

Reports on host tooling, environment, repo state, and the agent docker
image. Never modifies anything. Use this when something stopped working
and you want a sanity report.

USAGE
  cd /path/to/your/repo   # (or runway's own clone)
  runway doctor [--tier=1|2] [--detailed] [--json] [--check=NAME ...]

OPTIONS
  --tier=N        Force tier 1 or 2 checks. Default: auto-detect from
                  .sandcastle/Dockerfile + .env.schema in cwd.
  --detailed      Print version numbers, paths, and full error output.
                  Default mode is terse (just ✓/✗/⚠).
  --json          Machine-readable output for CI / scripted health checks.
  --check=NAME    Run only diagnostics with the given name (repeatable).
                  Use --check=help to list available names.
  --help, -h      Show this help.

SECTIONS REPORTED
  1. Host tooling   git, node ≥22, docker (daemon), gh (auth);
                    tier 2 also checks varlock + op CLI.
  2. Environment    LINEAR_API_KEY (set/unset; never printed);
                    tier 2 also checks OP_SERVICE_ACCOUNT_TOKEN.
  3. Repo state     git repo? clean tree? branch? scaffold detected?
  4. Docker image   sandcastle:<sanitized-cwd> exists; user/group match.
  5. Linear config  team, workflow states, HITL label on the team.

EXIT CODES
  0   All required checks pass (warnings allowed).
  1   At least one ✗ in tooling, environment, image, or Linear checks.
      Repo-state issues (no init, dirty tree) are warnings only.
`);
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseDoctorArgs(argv: readonly string[]): DoctorOptions {
  let tierOverride: Tier | undefined;
  let detailed = false;
  let json = false;
  const checks: string[] = [];

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      printDoctorUsage();
      process.exit(0);
    } else if (arg === "--tier=1") {
      tierOverride = 1;
    } else if (arg === "--tier=2") {
      tierOverride = 2;
    } else if (arg === "--detailed") {
      detailed = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg.startsWith("--check=")) {
      const name = arg.slice("--check=".length).trim();
      if (name.length === 0) {
        throw new Error("--check requires a name (e.g. --check=node)");
      }
      checks.push(name);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return {
    tierOverride,
    detailed,
    json,
    checks: checks.length > 0 ? checks : undefined,
  };
}

/**
 * Validate that every `--check=NAME` matches a registered diagnostic.
 * Unknown names fail fast with the available list so the user sees
 * what to type instead.
 */
function validateCheckNames(checks: readonly string[] | undefined): void {
  if (!checks?.length) return;
  if (checks.includes("help")) {
    const available = DIAGNOSTICS.map((d) => `  ${d.name}  (${d.section})`).join(
      "\n",
    );
    console.log(`Available --check names:\n${available}`);
    process.exit(0);
  }
  const known = new Set(DIAGNOSTICS.map((d) => d.name));
  const unknown = checks.filter((n) => !known.has(n));
  if (unknown.length > 0) {
    throw new Error(
      `unknown --check name(s): ${unknown.join(", ")}. ` +
        `Available: ${[...known].sort().join(", ")} (or --check=help for a grouped list)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function doctorCommand(argv: readonly string[]): Promise<void> {
  const opts = parseDoctorArgs(argv);
  validateCheckNames(opts.checks);

  const cwd = process.cwd();
  const repo = detectRepoState(cwd);
  const tier: Tier | null = opts.tierOverride ?? repo.tier;
  const tierForChecks: Tier = tier ?? 2;
  const initialised = tier !== null;

  const ctx: DoctorContext = {
    cwd,
    tier: tierForChecks,
    repo,
    options: opts,
  };

  const sections = await runDiagnostics(ctx);

  const failed = sections.some(
    (s) =>
      s.ran &&
      REQUIRED_SECTIONS.has(s.title) &&
      [...s.checks.values()].some((c) => c.status === "fail"),
  );

  if (opts.json) {
    renderJson(sections, tier, !failed);
  } else {
    renderText(sections, tier, initialised, opts.detailed);
  }

  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Repo / tier detection — produces the DoctorContext, not itself a
// diagnostic.
// ---------------------------------------------------------------------------

function detectRepoState(cwd: string): RepoState {
  const hasDockerfile = existsSync(join(cwd, ".sandcastle", "Dockerfile"));
  const hasSchema = existsSync(join(cwd, ".env.schema"));

  let tier: Tier | null = null;
  let authMode: AuthMode | null = null;
  let hasConflictingAuthVars = false;
  if (hasSchema) {
    try {
      const schema = readFileSync(join(cwd, ".env.schema"), "utf8");
      const hasApiKey = /ANTHROPIC_API_KEY\s*=\s*exec\(/.test(schema);
      const hasOauth = /CLAUDE_CODE_OAUTH_TOKEN\s*=\s*exec\(/.test(schema);
      if (hasApiKey && hasOauth) {
        tier = 2;
        hasConflictingAuthVars = true;
      } else if (hasApiKey) {
        tier = 2;
        authMode = "api-key";
      } else if (hasOauth) {
        tier = 2;
        authMode = "oauth";
      } else if (hasDockerfile) {
        tier = 1;
      }
    } catch {
      // unreadable schema — treat as un-initialised
    }
  } else if (hasDockerfile) {
    tier = 1;
  }

  return { tier, hasDockerfile, hasSchema, authMode, hasConflictingAuthVars };
}

