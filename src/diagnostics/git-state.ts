import { execa } from "execa";
import type { CheckResult, Diagnostic, DoctorContext } from "./index.js";

/**
 * Multi-result adapter: `git rev-parse --git-dir` gates `git status`
 * and `git rev-parse --abbrev-ref HEAD`. Splitting these into
 * separate adapters would re-shell `git rev-parse --git-dir` per
 * sub-check or thread shared state through the registry — the
 * coupling is real (you can't check working-tree cleanliness in a
 * directory that isn't a git repo), so they live as one adapter
 * that emits 1-3 CheckResults.
 */
export const gitStateDiagnostic: Diagnostic = {
  name: "git-state",
  section: "Repo state",
  tier: "both",
  async run(ctx: DoctorContext): Promise<readonly CheckResult[]> {
    const { cwd } = ctx;
    const results: CheckResult[] = [];

    let isGitRepo = false;
    try {
      await execa("git", ["rev-parse", "--git-dir"], { cwd });
      isGitRepo = true;
      results.push({ status: "ok", label: "git repo" });
    } catch {
      results.push({
        status: "warn",
        label: "git repo",
        detail: "not inside a git repo",
      });
    }

    if (!isGitRepo) return results;

    // Working tree clean? (info-only)
    try {
      const { stdout } = await execa("git", ["status", "--porcelain"], { cwd });
      const s = (stdout as string).trim();
      if (s.length === 0) {
        results.push({ status: "ok", label: "working tree clean" });
      } else {
        results.push({
          status: "warn",
          label: "working tree clean",
          detail: `${s.split("\n").length} change(s) — info only`,
        });
      }
    } catch {
      results.push({
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
      results.push({
        status: "ok",
        label: "branch",
        detail: (stdout as string).trim() || "(detached)",
      });
    } catch {
      results.push({
        status: "warn",
        label: "branch",
        detail: "no commits yet",
      });
    }

    return results;
  },
};
