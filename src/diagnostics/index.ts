import { execa } from "execa";

// ---------------------------------------------------------------------------
// Shared types
//
// CheckResult, Status, Tier, RepoState, DoctorOptions, AuthMode — moved here
// from src/commands/doctor.ts so adapter modules can reach them without
// importing from a command file (commands/ depends on diagnostics, not the
// other way around).
// ---------------------------------------------------------------------------

export type Status = "ok" | "fail" | "warn" | "skip";

export interface CheckResult {
  readonly status: Status;
  /** One-line summary, suitable for `✓ <label>` rendering. */
  readonly label: string;
  /** Optional detail (version string, path, error message). Shown with --detailed. */
  readonly detail?: string;
}

export interface SectionResult {
  readonly title: string;
  readonly checks: ReadonlyMap<string, CheckResult>;
  /** True if this section ran. Skipped sections don't contribute to exit code. */
  readonly ran: boolean;
}

export type Tier = 1 | 2;

export type AuthMode = "api-key" | "oauth";

export interface RepoState {
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

export interface DoctorOptions {
  readonly tierOverride?: Tier;
  readonly detailed: boolean;
  readonly json: boolean;
  /**
   * VA-364: `--check <name>` (repeatable). When non-empty, only
   * diagnostics with matching `name` run; everything else is skipped.
   * Unknown names are rejected up-front by `doctorCommand`.
   */
  readonly checks?: readonly string[];
}

/**
 * Everything an adapter needs to run. Built once by `doctorCommand`
 * and passed unchanged to every diagnostic in the registry.
 */
export interface DoctorContext {
  readonly cwd: string;
  /**
   * Effective tier for tooling checks — defaults to 2 when no
   * scaffold is present (so varlock/op still get reported). Distinct
   * from `repo.tier`, which is null when the cwd isn't initialised.
   */
  readonly tier: Tier;
  readonly repo: RepoState;
  readonly options: DoctorOptions;
}

/**
 * VA-364: a single named probe. Most adapters return one CheckResult;
 * coupled probes (docker-image's inspect+probe chain,
 * linear-config's validateLinearConfig() result) return multiple
 * CheckResults because they share an expensive underlying call that
 * shouldn't be re-run per sub-check.
 */
export interface Diagnostic {
  /** Stable kebab-case identifier. Used by `--check`. */
  readonly name: string;
  /** Section title for render grouping. Must match across adapters in the same section. */
  readonly section: string;
  /** Tier eligibility. `"both"` runs in either tier. */
  readonly tier: "tier-1" | "tier-2" | "both";
  run(ctx: DoctorContext): Promise<readonly CheckResult[]>;
}

// ---------------------------------------------------------------------------
// Section ordering — the render layer iterates this in order so the
// output sequence stays identical to the pre-VA-364 layout. New sections
// must be added here AND have at least one Diagnostic with a matching
// `section` field.
// ---------------------------------------------------------------------------

export const SECTION_ORDER: readonly string[] = [
  "Host tooling",
  "Environment",
  "Repo state",
  "Docker image",
  "Linear configuration",
] as const;

// ---------------------------------------------------------------------------
// Registry — populated by adapter imports below.
//
// Order within a section determines the order checks appear in render
// output. Cross-section order is governed by SECTION_ORDER above.
// ---------------------------------------------------------------------------

import { gitDiagnostic } from "./git.js";
import { nodeDiagnostic } from "./node.js";
import { dockerDiagnostic } from "./docker.js";
import { ghDiagnostic } from "./gh.js";
import { varlockDiagnostic } from "./varlock.js";
import { opDiagnostic } from "./op.js";
import { linearApiKeyDiagnostic } from "./linear-api-key.js";
import { linearScopeDiagnostic } from "./linear-scope.js";
import { baseBranchDiagnostic } from "./base-branch.js";
import { opTokenDiagnostic } from "./op-token.js";
import { claudeAuthModeDiagnostic } from "./claude-auth-mode.js";
import { gitSigningDiagnostic } from "./git-signing.js";
import { policyDiagnostic } from "./policy.js";
import { gitStateDiagnostic } from "./git-state.js";
import { runwayScaffoldDiagnostic } from "./runway-scaffold.js";
import { dockerImageDiagnostic } from "./docker-image.js";
import { linearConfigDiagnostic } from "./linear-config.js";

export const DIAGNOSTICS: readonly Diagnostic[] = [
  // Host tooling
  gitDiagnostic,
  nodeDiagnostic,
  dockerDiagnostic,
  ghDiagnostic,
  varlockDiagnostic,
  opDiagnostic,
  // Environment
  linearApiKeyDiagnostic,
  linearScopeDiagnostic,
  baseBranchDiagnostic,
  opTokenDiagnostic,
  claudeAuthModeDiagnostic,
  gitSigningDiagnostic,
  policyDiagnostic,
  // Repo state
  gitStateDiagnostic,
  runwayScaffoldDiagnostic,
  // Docker image
  dockerImageDiagnostic,
  // Linear configuration
  linearConfigDiagnostic,
];

// ---------------------------------------------------------------------------
// Runner — filters the registry by tier + --check, runs each adapter,
// and groups results into SectionResult[] for render compatibility.
// ---------------------------------------------------------------------------

/**
 * Decide whether `d` should run given the current context. Used by
 * `runDiagnostics` and by `doctorCommand` for the exit-code summary.
 */
function shouldRun(d: Diagnostic, ctx: DoctorContext): boolean {
  // --check filter
  if (ctx.options.checks?.length && !ctx.options.checks.includes(d.name)) {
    return false;
  }
  // Tier filter — host-tooling tier-1-only and tier-2-only adapters
  // honour the *effective* tier (ctx.tier), which falls back to 2 when
  // no scaffold is present.
  if (d.tier === "tier-1" && ctx.tier !== 1) return false;
  if (d.tier === "tier-2" && ctx.tier !== 2) return false;
  // No-scaffold gate: when there's no runway scaffold and no explicit
  // --tier override, only run host-tooling diagnostics. The other
  // sections show as skipped (placeholder SectionResult, ran: false).
  const initialised = ctx.repo.tier !== null;
  if (!initialised && ctx.options.tierOverride === undefined && d.section !== "Host tooling") {
    return false;
  }
  return true;
}

/**
 * Run every diagnostic the context allows, in registry order, and
 * group results into the SectionResult[] shape the renderer expects.
 * A section appears in the output if any of its diagnostics ran, OR
 * if SECTION_ORDER lists it (in which case it's a "skipped" section
 * placeholder so JSON output stays well-shaped).
 */
export async function runDiagnostics(
  ctx: DoctorContext,
): Promise<readonly SectionResult[]> {
  const perSection = new Map<string, Map<string, CheckResult>>();
  const sectionRan = new Map<string, boolean>();

  for (const section of SECTION_ORDER) {
    perSection.set(section, new Map());
    sectionRan.set(section, false);
  }

  for (const d of DIAGNOSTICS) {
    if (!shouldRun(d, ctx)) continue;
    sectionRan.set(d.section, true);
    const results = await d.run(ctx);
    // For multi-result adapters (docker-image, linear-config) the
    // results all belong to the same section; keys are the adapter's
    // own labels, which we re-derive into stable keys for the map.
    const bucket = perSection.get(d.section);
    if (!bucket) continue;
    if (results.length === 1) {
      bucket.set(d.name, results[0]!);
    } else {
      // Multi-result adapters use the check's label-derived slug as
      // the map key so JSON output's section-internal naming stays
      // close to the pre-VA-364 shape.
      results.forEach((r, idx) => {
        bucket.set(`${d.name}/${idx}`, r);
      });
    }
  }

  return SECTION_ORDER.map((title) => ({
    title,
    checks: perSection.get(title) ?? new Map(),
    ran: sectionRan.get(title) ?? false,
  }));
}

// ---------------------------------------------------------------------------
// Shared adapter helpers
// ---------------------------------------------------------------------------

/**
 * Probe a binary's `--version` output. Used by `git`, `node`, `varlock`,
 * `op` host-tooling adapters. `reject: false` so a non-zero exit (binary
 * present but reports its version on stderr or returns a code) doesn't
 * throw — we only fall through to "not on PATH" when execa itself can't
 * spawn the process.
 */
export async function checkBinaryVersion(
  bin: string,
  args: readonly string[],
): Promise<CheckResult> {
  try {
    const { stdout, stderr } = await execa(bin, args, { reject: false });
    const out = (stdout || stderr || "").toString().split("\n")[0]?.trim() ?? "";
    return { status: "ok", label: bin, detail: out || "(installed)" };
  } catch {
    return {
      status: "fail",
      label: bin,
      detail: `${bin} not on PATH`,
    };
  }
}

/**
 * Trim an error's message to its first line — adapters surface this
 * in `detail` so a long stack trace doesn't blow up the doctor output.
 */
export function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message.split("\n")[0] ?? err.message;
  return String(err);
}

/**
 * Build a `{ status: "ok", label, detail }` result for env-var
 * presence checks. `missingStatus` lets the caller decide whether a
 * missing var is a hard fail or just a warn.
 */
export function envSet(
  name: string,
  missingStatus: "fail" | "warn",
): CheckResult {
  const value = process.env[name]?.trim();
  if (value && value.length > 0) {
    return { status: "ok", label: name, detail: "set" };
  }
  return {
    status: missingStatus,
    label: name,
    detail: "unset",
  };
}
