import { execa } from "execa";
import type { RunwayIssue } from "./linear.js";

export interface GithubGateway {
  /** Push a branch to origin. Returns nothing on success, throws on failure. */
  pushBranch(repoPath: string, branch: string): Promise<void>;
  /** Open a PR against `main` for the given branch. Returns the PR URL. */
  openPullRequest(args: {
    repoPath: string;
    branch: string;
    issue: RunwayIssue;
    body: string;
  }): Promise<string>;
}

/**
 * `gh` CLI-backed gateway. Runway runs on a host with `gh` authenticated
 * (via `GH_TOKEN` or the user's keychain login); we don't reimplement
 * REST calls when `gh` is already there and handles the auth dance.
 */
export function createGithubGateway(): GithubGateway {
  return {
    async pushBranch(repoPath, branch) {
      await execa("git", ["push", "-u", "origin", branch], {
        cwd: repoPath,
        stdio: "inherit",
      });
    },

    async openPullRequest({ repoPath, branch, issue, body }) {
      const title = `${issue.identifier}: ${issue.title}`;
      const { stdout } = await execa(
        "gh",
        [
          "pr",
          "create",
          "--base",
          "main",
          "--head",
          branch,
          "--title",
          title,
          "--body",
          body,
        ],
        { cwd: repoPath },
      );
      // `gh pr create` prints the URL on the last line.
      const url = stdout.trim().split("\n").at(-1) ?? "";
      return url;
    },
  };
}
