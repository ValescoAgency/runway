import { Data, Effect } from "effect";
import { execa } from "execa";
import type { RunwayIssue } from "./linear.js";

// VA-356: typed error ADT for the GitHub gateway. `GhCliMissing` is
// its own branch so the orchestrator (and `runway doctor`) can show
// an install hint instead of an opaque ENOENT. Push and PR failures
// are split because retry semantics differ — re-pushing the same
// branch is idempotent, re-running `gh pr create` after a partial
// failure can create duplicate PRs.
export class GhCliMissing extends Data.TaggedError("GhCliMissing")<{
  readonly message: string;
}> {}

export class PushFailed extends Data.TaggedError("PushFailed")<{
  readonly branch: string;
  readonly stderr: string;
  readonly message: string;
}> {}

export class PrCreateFailed extends Data.TaggedError("PrCreateFailed")<{
  readonly branch: string;
  readonly stderr: string;
  readonly message: string;
}> {}

export type GithubError = GhCliMissing | PushFailed | PrCreateFailed;

function isCommandMissing(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { code?: string };
  if (e.code === "ENOENT") return true;
  return /\bcommand not found\b|: not found/i.test(e.message);
}

function execaStderr(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const s = (err as { stderr?: unknown }).stderr;
    return typeof s === "string" ? s : "";
  }
  return "";
}

export interface GithubGateway {
  /** Push a branch to origin. */
  pushBranch(repoPath: string, branch: string): Effect.Effect<void, GithubError>;
  /** Open a PR against `base` for the given branch. Returns the PR URL. */
  openPullRequest(args: {
    repoPath: string;
    branch: string;
    base: string;
    issue: RunwayIssue;
    body: string;
  }): Effect.Effect<string, GithubError>;
}

/**
 * `gh` CLI-backed gateway. Runway runs on a host with `gh` authenticated
 * (via `GH_TOKEN` or the user's keychain login); we don't reimplement
 * REST calls when `gh` is already there and handles the auth dance.
 */
export function createGithubGateway(): GithubGateway {
  return {
    pushBranch(repoPath, branch) {
      return Effect.tryPromise({
        try: async () => {
          await execa("git", ["push", "-u", "origin", branch], {
            cwd: repoPath,
            stdio: "inherit",
          });
        },
        catch: (err) => {
          if (isCommandMissing(err)) {
            return new GhCliMissing({
              message: `git not found on PATH: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
          return new PushFailed({
            branch,
            stderr: execaStderr(err),
            message:
              err instanceof Error ? err.message : `push failed: ${String(err)}`,
          });
        },
      });
    },

    openPullRequest({ repoPath, branch, base, issue, body }) {
      return Effect.tryPromise({
        try: async () => {
          const title = `${issue.identifier}: ${issue.title}`;
          const { stdout } = await execa(
            "gh",
            [
              "pr",
              "create",
              "--base",
              base,
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
          return stdout.trim().split("\n").at(-1) ?? "";
        },
        catch: (err) => {
          if (isCommandMissing(err)) {
            return new GhCliMissing({
              message: `gh CLI not found on PATH — install https://cli.github.com (${err instanceof Error ? err.message : String(err)})`,
            });
          }
          return new PrCreateFailed({
            branch,
            stderr: execaStderr(err),
            message:
              err instanceof Error
                ? err.message
                : `gh pr create failed: ${String(err)}`,
          });
        },
      });
    },
  };
}
