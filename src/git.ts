import { execa } from "execa";

/**
 * Resolve the default branch name of the cwd repo. Tries
 * `git symbolic-ref` against `origin/HEAD` first (fast, works on any
 * clone where the symbolic ref has been set), then falls back to
 * `git remote show origin` (slower, hits the network but works on
 * fresh clones that never had `origin/HEAD` set locally).
 *
 * Throws if neither path resolves a branch name — better to fail
 * fast at orchestrator startup than to crash mid-diff with a stale
 * "ambiguous argument" git error.
 */
export async function detectBaseBranch(repoPath: string): Promise<string> {
  // Fast path: local symbolic ref. Returns e.g. `origin/main` or `origin/master`.
  try {
    const { stdout, exitCode } = await execa(
      "git",
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      { cwd: repoPath, reject: false },
    );
    if (exitCode === 0) {
      const name = stdout.trim().replace(/^origin\//, "");
      if (name) return name;
    }
  } catch {
    // fall through to remote-show fallback
  }

  // Slow path: ask the remote. Output line looks like `  HEAD branch: master`.
  try {
    const { stdout } = await execa("git", ["remote", "show", "origin"], {
      cwd: repoPath,
    });
    const match = stdout.match(/^\s*HEAD branch:\s*(\S+)\s*$/m);
    if (match?.[1]) return match[1];
  } catch {
    // fall through to error
  }

  throw new Error(
    `Could not detect the default branch of ${repoPath}. ` +
      `Set RUNWAY_BASE_BRANCH explicitly, or run ` +
      `\`git remote set-head origin --auto\` to populate origin/HEAD.`,
  );
}
