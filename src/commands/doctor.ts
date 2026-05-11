import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { detectBaseBranch } from "../git.js";
import { loadPolicy } from "../policy.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Status = "ok" | "fail" | "warn" | "skip";

interface CheckResult {
  readonly status: Status;
  /** One-line summary, suitable for `✓ <label>` rendering. */
  readonly label: string;
  /** Optional detail (version string, path, error message). Shown with --detailed. */
  readonly detail?: string;
}

interface SectionResult {
  readonly title: string;
  readonly checks: ReadonlyMap<string, CheckResult>;
  /** True if this section ran. Skipped sections don't contribute to exit code. */
  readonly ran: boolean;
}

type Tier = 1 | 2;

interface DoctorOptions {
  readonly tierOverride?: Tier;
  readonly detailed: boolean;
  readonly json: boolean;
}

type AuthMode = "api-key" | "oauth";

interface RepoState {
  readonly tier: Tier | null;
  readonly hasDockerfile: boolean;
  readonly hasSchema: boolean;
  /**
   * For tier-2 scaffolds, which Claude Code auth env var the
   * `.env.schema` declares. `null` for tier 1 or when both/neither
   * shapes are present (misconfiguration — surfaced as a fail).
   */
  readonly authMode: AuthMode | null;
  /** True when the schema declares both auth env vars at once. */
  readonly hasConflictingAuthVars: boolean;
}

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
  runway doctor [--tier=1|2] [--detailed] [--json]

OPTIONS
  --tier=N        Force tier 1 or 2 checks. Default: auto-detect from
                  .sandcastle/Dockerfile + .env.schema in cwd.
  --detailed      Print version numbers, paths, and full error output.
                  Default mode is terse (just ✓/✗/⚠).
  --json          Machine-readable output for CI / scripted health checks.
  --help, -h      Show this help.

SECTIONS REPORTED
  1. Host tooling   git, node ≥22, docker (daemon), gh (auth);
                    tier 2 also checks varlock + op CLI.
  2. Environment    LINEAR_API_KEY (set/unset; never printed);
                    tier 2 also checks OP_SERVICE_ACCOUNT_TOKEN.
  3. Repo state     git repo? clean tree? branch? scaffold detected?
  4. Docker image   sandcastle:<sanitized-cwd> exists; user/group match.

EXIT CODES
  0   All required checks pass (warnings allowed).
  1   At least one ✗ in tooling, environment, or image checks.
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
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return { tierOverride, detailed, json };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function doctorCommand(argv: readonly string[]): Promise<void> {
  const opts = parseDoctorArgs(argv);
  const cwd = process.cwd();

  const repo = detectRepoState(cwd);
  const tier: Tier | null = opts.tierOverride ?? repo.tier;

  // If no scaffold AND no override → still run host-tooling, but skip the rest.
  // We pick tier 2 as the "default check posture" for tooling so varlock/op
  // are reported (Valesco's standard), unless the user explicitly says tier 1.
  const tierForToolingChecks: Tier = tier ?? 2;
  const initialised = tier !== null;

  const sections: SectionResult[] = [];

  sections.push(await checkHostTooling(tierForToolingChecks));

  if (initialised || opts.tierOverride !== undefined) {
    sections.push(await checkEnvironment(tierForToolingChecks, cwd, repo));
    sections.push(await checkRepoState(cwd, repo));
    sections.push(await checkDockerImage(cwd));
  } else {
    // Push placeholder skipped sections so JSON output stays well-shaped.
    sections.push(skippedSection("Environment"));
    sections.push(skippedSection("Repo state"));
    sections.push(skippedSection("Docker image"));
  }

  // Render
  if (opts.json) {
    renderJson(sections, tier, initialised);
  } else {
    renderText(sections, tier, initialised, opts.detailed);
  }

  // Exit code: required-check failures = 1.
  // Sections 1, 2, 4 are "required"; section 3 (repo state) is informational.
  const requiredSections = [sections[0], sections[1], sections[3]] as const;
  const failed = requiredSections.some(
    (s) => s?.ran && [...s.checks.values()].some((c) => c.status === "fail"),
  );
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Repo / tier detection
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

// ---------------------------------------------------------------------------
// Section: Host tooling
// ---------------------------------------------------------------------------

async function checkHostTooling(tier: Tier): Promise<SectionResult> {
  const checks = new Map<string, CheckResult>();

  checks.set("git", await checkBinaryVersion("git", ["--version"]));

  const nodeVersion = process.versions.node;
  const nodeMajor = Number.parseInt(nodeVersion.split(".")[0] ?? "0", 10);
  checks.set(
    "node",
    nodeMajor >= 22
      ? { status: "ok", label: "node", detail: `v${nodeVersion}` }
      : {
          status: "fail",
          label: "node",
          detail: `v${nodeVersion} — node ≥ 22 required`,
        },
  );

  checks.set("docker", await checkDockerDaemon());
  checks.set("gh", await checkGhAuth());

  if (tier === 2) {
    checks.set("varlock", await checkBinaryVersion("varlock", ["--version"]));
    checks.set("op", await checkBinaryVersion("op", ["--version"]));
  }

  return { title: "Host tooling", checks, ran: true };
}

async function checkBinaryVersion(
  bin: string,
  args: readonly string[],
): Promise<CheckResult> {
  try {
    const { stdout, stderr } = await execa(bin, args, { reject: false });
    const out = (stdout || stderr || "").split("\n")[0]?.trim() ?? "";
    return { status: "ok", label: bin, detail: out || "(installed)" };
  } catch {
    return {
      status: "fail",
      label: bin,
      detail: `${bin} not on PATH`,
    };
  }
}

async function checkDockerDaemon(): Promise<CheckResult> {
  try {
    await execa("docker", ["--version"], { reject: true });
  } catch {
    return {
      status: "fail",
      label: "docker",
      detail: "docker not on PATH (Docker Desktop or Podman)",
    };
  }
  try {
    await execa("docker", ["info"], { reject: true });
    return { status: "ok", label: "docker", detail: "daemon up" };
  } catch (err) {
    return {
      status: "fail",
      label: "docker",
      detail: `daemon not running — ${errMsg(err)}`,
    };
  }
}

async function checkGhAuth(): Promise<CheckResult> {
  try {
    await execa("gh", ["--version"], { reject: true });
  } catch {
    return {
      status: "fail",
      label: "gh",
      detail: "gh not on PATH",
    };
  }
  try {
    const { stdout, stderr } = await execa("gh", ["auth", "status"], {
      reject: true,
    });
    // First non-empty line of `gh auth status` is the host header.
    const summary = (stdout || stderr || "")
      .split("\n")
      .map((s) => s.trim())
      .find((s) => s.length > 0);
    return {
      status: "ok",
      label: "gh",
      detail: summary ?? "authenticated",
    };
  } catch (err) {
    return {
      status: "fail",
      label: "gh",
      detail: `not authenticated — ${errMsg(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Section: Environment
// ---------------------------------------------------------------------------

async function checkEnvironment(
  tier: Tier,
  cwd: string,
  repo: RepoState,
): Promise<SectionResult> {
  const checks = new Map<string, CheckResult>();

  checks.set("LINEAR_API_KEY", envSet("LINEAR_API_KEY", "fail"));

  // Informational: which Linear scope a `runway run` would use.
  const team = process.env.RUNWAY_LINEAR_TEAM?.trim() || "VA";
  const project = process.env.RUNWAY_LINEAR_PROJECT?.trim();
  checks.set("linear_scope", {
    status: "ok",
    label: "linear scope",
    detail: project
      ? `team ${team} / project ${project}`
      : `team ${team} (team-wide — RUNWAY_LINEAR_PROJECT unset)`,
  });

  // Informational: which base branch a `runway run` would diff against
  // and target with PRs. Detection failure here is a real problem —
  // surface it as a fail so the user knows up front.
  const override = process.env.RUNWAY_BASE_BRANCH?.trim();
  if (override) {
    checks.set("base_branch", {
      status: "ok",
      label: "base branch",
      detail: `${override} (RUNWAY_BASE_BRANCH override)`,
    });
  } else {
    try {
      const detected = await detectBaseBranch(cwd);
      checks.set("base_branch", {
        status: "ok",
        label: "base branch",
        detail: `${detected} (detected from origin/HEAD)`,
      });
    } catch (err) {
      checks.set("base_branch", {
        status: "fail",
        label: "base branch",
        detail: errMsg(err),
      });
    }
  }

  if (tier === 2) {
    // Tier 2: needed by varlock to resolve op:// refs in the container.
    checks.set(
      "OP_SERVICE_ACCOUNT_TOKEN",
      envSet("OP_SERVICE_ACCOUNT_TOKEN", "fail"),
    );

    // Surface which Claude Code auth env var the .env.schema declares.
    // ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN aren't
    // interchangeable; a mismatch between this and what's stored in
    // 1Password yields a generic "Invalid API key" inside the
    // container with no useful diagnostic.
    if (repo.hasConflictingAuthVars) {
      checks.set("auth_mode", {
        status: "fail",
        label: "claude auth mode",
        detail:
          ".env.schema declares both ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN — pick one (they are not interchangeable)",
      });
    } else if (repo.authMode === "oauth") {
      checks.set("auth_mode", {
        status: "ok",
        label: "claude auth mode",
        detail: "oauth (CLAUDE_CODE_OAUTH_TOKEN — Pro/Max subscription)",
      });
    } else if (repo.authMode === "api-key") {
      checks.set("auth_mode", {
        status: "ok",
        label: "claude auth mode",
        detail: "api-key (ANTHROPIC_API_KEY — pay-per-token)",
      });
    } else {
      checks.set("auth_mode", {
        status: "fail",
        label: "claude auth mode",
        detail:
          ".env.schema declares neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN",
      });
    }
  }

  // VA-352: surface the active impl-pass write-path policy so the
  // operator can see whether an agent run can touch CI workflows, etc.
  try {
    const policy = loadPolicy(cwd);
    checks.set("policy", {
      status: "ok",
      label: "impl policy",
      detail: `${policy.source} (${policy.forbiddenPaths.length} forbidden path${policy.forbiddenPaths.length === 1 ? "" : "s"})`,
    });
  } catch (err) {
    checks.set("policy", {
      status: "fail",
      label: "impl policy",
      detail: errMsg(err),
    });
  }

  return { title: "Environment", checks, ran: true };
}

function envSet(name: string, missingStatus: "fail" | "warn"): CheckResult {
  const v = process.env[name];
  if (v && v.trim().length > 0) {
    return { status: "ok", label: name, detail: "set" };
  }
  return {
    status: missingStatus,
    label: name,
    detail: "unset or empty",
  };
}

// ---------------------------------------------------------------------------
// Section: Repo state
// ---------------------------------------------------------------------------

async function checkRepoState(
  cwd: string,
  repo: RepoState,
): Promise<SectionResult> {
  const checks = new Map<string, CheckResult>();

  // Is this a git repo?
  let isGitRepo = false;
  try {
    await execa("git", ["rev-parse", "--git-dir"], { cwd });
    isGitRepo = true;
    checks.set("git_repo", { status: "ok", label: "git repo" });
  } catch {
    checks.set("git_repo", {
      status: "warn",
      label: "git repo",
      detail: "not inside a git repo",
    });
  }

  if (isGitRepo) {
    // Working tree clean? (info-only)
    try {
      const { stdout } = await execa("git", ["status", "--porcelain"], { cwd });
      if (stdout.trim().length === 0) {
        checks.set("clean_tree", { status: "ok", label: "working tree clean" });
      } else {
        const count = stdout.trim().split("\n").length;
        checks.set("clean_tree", {
          status: "warn",
          label: "working tree clean",
          detail: `${count} change(s) — info only`,
        });
      }
    } catch {
      checks.set("clean_tree", {
        status: "warn",
        label: "working tree clean",
        detail: "git status failed",
      });
    }

    // Current branch
    try {
      const { stdout } = await execa(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        { cwd },
      );
      checks.set("branch", {
        status: "ok",
        label: "branch",
        detail: stdout.trim() || "(detached)",
      });
    } catch {
      checks.set("branch", {
        status: "warn",
        label: "branch",
        detail: "no commits yet",
      });
    }
  }

  // Scaffold detection
  if (repo.tier === null) {
    checks.set("scaffold", {
      status: "warn",
      label: "runway scaffold",
      detail:
        "no runway scaffold detected — run `runway init` first " +
        "(only host-tooling diagnostics apply until then)",
    });
  } else {
    checks.set("scaffold", {
      status: "ok",
      label: "runway scaffold",
      detail: `tier ${repo.tier} — Dockerfile=${repo.hasDockerfile} schema=${repo.hasSchema}`,
    });
  }

  return { title: "Repo state", checks, ran: true };
}

// ---------------------------------------------------------------------------
// Section: Docker image
// ---------------------------------------------------------------------------

async function checkDockerImage(cwd: string): Promise<SectionResult> {
  const checks = new Map<string, CheckResult>();
  const imageName = expectedImageName(cwd);

  try {
    const { stdout } = await execa(
      "docker",
      ["image", "inspect", imageName, "--format", "{{.Config.User}}"],
      { reject: true },
    );
    const imageUser = stdout.trim();
    checks.set("image_present", {
      status: "ok",
      label: `image ${imageName}`,
      detail: "present",
    });

    // User mismatch warning per sandcastle's pre-flight diagnostic:
    // image was built for one UID:GID; if the host UID:GID differs the
    // bind-mount permissions will be off.
    const hostUid = process.getuid?.() ?? 1000;
    const hostGid = process.getgid?.() ?? 1000;
    const expected = `${hostUid}:${hostGid}`;
    if (imageUser && imageUser !== expected) {
      checks.set("image_user", {
        status: "warn",
        label: "image user matches host UID:GID",
        detail: `image User=${imageUser}, host=${expected} — rebuild with --build-arg AGENT_UID/AGENT_GID`,
      });
    } else {
      checks.set("image_user", {
        status: "ok",
        label: "image user matches host UID:GID",
        detail: imageUser ? `User=${imageUser}` : `User unset (root); host=${expected}`,
      });
    }
  } catch (err) {
    checks.set("image_present", {
      status: "fail",
      label: `image ${imageName}`,
      detail: `not built — ${errMsg(err)}`,
    });
  }

  return { title: "Docker image", checks, ran: true };
}

/**
 * Sanitize the cwd's basename the same way sandcastle's `defaultImageName`
 * does: lowercase, replace any char outside `[a-z0-9_.-]` with `-`, fall
 * back to "local" if empty. Prefix `sandcastle:`.
 */
function expectedImageName(cwd: string): string {
  const dirName =
    cwd
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? "local";
  const sanitized =
    dirName.toLowerCase().replace(/[^a-z0-9_.-]/g, "-") || "local";
  return `sandcastle:${sanitized}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function skippedSection(title: string): SectionResult {
  return { title, checks: new Map(), ran: false };
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message.split("\n")[0] ?? err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function statusGlyph(s: Status): string {
  switch (s) {
    case "ok":
      return "✓";
    case "fail":
      return "✗";
    case "warn":
      return "⚠";
    case "skip":
      return "·";
  }
}

function renderText(
  sections: readonly SectionResult[],
  tier: Tier | null,
  initialised: boolean,
  detailed: boolean,
): void {
  const tierLabel = tier === null ? "not initialized" : `tier ${tier}`;
  console.log(`runway doctor — ${tierLabel}`);
  console.log("");

  for (const section of sections) {
    console.log(`${section.title}`);
    if (!section.ran) {
      console.log("  · skipped (no runway scaffold detected)");
      console.log("");
      continue;
    }
    for (const check of section.checks.values()) {
      const glyph = statusGlyph(check.status);
      if (detailed && check.detail) {
        console.log(`  ${glyph} ${check.label} — ${check.detail}`);
      } else if (check.status !== "ok" && check.detail) {
        // Always surface non-OK detail even in terse mode.
        console.log(`  ${glyph} ${check.label} — ${check.detail}`);
      } else {
        console.log(`  ${glyph} ${check.label}`);
      }
    }
    console.log("");
  }

  if (!initialised) {
    console.log(
      "Hint: cwd has no runway scaffold. Run `runway init` from a target repo " +
        "to enable the full diagnostic.",
    );
  }
}

function renderJson(
  sections: readonly SectionResult[],
  tier: Tier | null,
  _initialised: boolean,
): void {
  const sectionKey = (title: string): string =>
    title.toLowerCase().replace(/\s+/g, "_");

  const checksByName = (s: SectionResult): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of s.checks.entries()) out[k] = v.status;
    return out;
  };

  // Determine `ok` from required sections (tooling, env, docker image).
  const requiredSections = [sections[0], sections[1], sections[3]] as const;
  const ok = !requiredSections.some(
    (s) => s?.ran && [...s.checks.values()].some((c) => c.status === "fail"),
  );

  const checks: Record<string, Record<string, string> | null> = {};
  for (const s of sections) {
    checks[sectionKey(s.title)] = s.ran ? checksByName(s) : null;
  }

  const payload = {
    ok,
    tier,
    checks,
  };
  console.log(JSON.stringify(payload, null, 2));
}
