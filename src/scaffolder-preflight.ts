import { execa } from "execa";
import type { ScaffolderOptions } from "./scaffolder.js";

/**
 * Phase 1: host-tooling + repo-state preflight. Fails fast with a
 * `PREFLIGHT FAIL: ...` error so the orchestrator stops before
 * mutating anything on disk. Same checks as `runway doctor`'s
 * host-tooling section, but scoped to what init specifically needs.
 */
export async function preflight(
  cwd: string,
  opts: ScaffolderOptions,
): Promise<void> {
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
