import { Schema } from "effect";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * VA-352: per-repo + per-run write-path policy for the impl agent.
 *
 * Defaults are conservative — secrets and sandbox-internals are always
 * denied. Repos that need agents to touch CI workflows (the common
 * case) opt in by creating `.runway/policy.yml` with `allowedPaths`,
 * or by passing `--allow-paths=` for a single invocation.
 *
 * The policy is reflected back to the agent in the rendered prompt
 * (`prompts/implement.md`'s "Working style" denylist sentence) so the
 * sentence the agent sees matches what runway will enforce at review
 * time. Enforcement itself (refusing to push a PR that touches a
 * denied path) lives in the reviewer pass — out of scope for this
 * change; the goal here is that the agent gets a correct denylist
 * and surfaces `IMPL: BLOCKED` when an AC requires a denied path.
 */

export const DEFAULT_FORBIDDEN_PATHS = [
  ".github/workflows/**",
  ".env*",
  "*.pem",
  "*.key",
  "pnpm-lock.yaml",
  ".sandcastle/**",
] as const;

const PolicyFileSchema = Schema.Struct({
  allowedPaths: Schema.optional(Schema.Array(Schema.String)),
  forbiddenPaths: Schema.optional(Schema.Array(Schema.String)),
});

export type PolicyFile = typeof PolicyFileSchema.Type;

const decodePolicyFile = Schema.decodeUnknownSync(PolicyFileSchema);

export interface Policy {
  /** Globs the agent must not write to. */
  readonly forbiddenPaths: readonly string[];
  /**
   * Provenance string for `runway doctor` / debug logging, e.g.
   * `"defaults"`, `".runway/policy.yml"`, or
   * `".runway/policy.yml + --allow-paths"`.
   */
  readonly source: string;
}

export interface LoadPolicyOptions {
  /**
   * Extra paths the operator grants for this invocation only, via
   * `runway run --allow-paths=glob,glob`. Removes them from the
   * effective denylist regardless of file config.
   */
  readonly allowPathsOverride?: readonly string[];
}

const POLICY_RELATIVE_PATH = join(".runway", "policy.yml");

/**
 * Resolve the effective policy for `cwd`. Reads `.runway/policy.yml`
 * when present, layers it on top of the conservative defaults, then
 * applies any `--allow-paths` CLI override.
 */
export function loadPolicy(
  cwd: string,
  opts: LoadPolicyOptions = {},
): Policy {
  const sources: string[] = [];
  let forbidden = new Set<string>(DEFAULT_FORBIDDEN_PATHS);

  const policyPath = join(cwd, POLICY_RELATIVE_PATH);
  if (existsSync(policyPath)) {
    sources.push(POLICY_RELATIVE_PATH);
    const raw = readFileSync(policyPath, "utf8");
    const parsed = decodePolicyFile(parseYaml(raw) ?? {});
    if (parsed.forbiddenPaths) {
      forbidden = new Set(parsed.forbiddenPaths);
    }
    for (const allow of parsed.allowedPaths ?? []) forbidden.delete(allow);
  } else {
    sources.push("defaults");
  }

  if (opts.allowPathsOverride?.length) {
    for (const allow of opts.allowPathsOverride) forbidden.delete(allow);
    sources.push("--allow-paths");
  }

  return {
    forbiddenPaths: [...forbidden],
    source: sources.join(" + "),
  };
}

