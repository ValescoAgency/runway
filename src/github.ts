import { Data, Effect, Schedule } from "effect";
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

// VA-357: a hung `gh` or `git` subprocess becomes a typed timeout.
// Step 3 (VA-358) is where we add scoped subprocess cleanup; here the
// Effect's fiber gets interrupted but the underlying child may still
// be running. We accept that limitation for Step 2.
export class GithubTimeout extends Data.TaggedError("GithubTimeout")<{
  readonly call: string;
  readonly afterMs: number;
  readonly message: string;
}> {}

export type GithubError =
  | GhCliMissing
  | PushFailed
  | PrCreateFailed
  | GithubTimeout;

// VA-357: same jittered exponential shape as the Linear policy.
export const githubRetrySchedule = Schedule.exponential("1 second").pipe(
  Schedule.compose(Schedule.recurs(5)),
  Schedule.jittered,
);

/**
 * VA-357: timeout + optional retry policy for a GitHub call. Unlike
 * Linear (where all methods are idempotent reads or idempotent
 * updates), GitHub differs by method:
 *
 * - `push` is idempotent (re-pushing the same SHA is a no-op) ⇒ retry
 *   on timeout.
 * - `gh pr create` is NOT idempotent — a retry after a partial failure
 *   can create a duplicate PR. Just bound it with a timeout, no
 *   retries.
 *
 * The caller picks the policy by passing a `retryOn` predicate (or
 * omitting it for timeout-only).
 */
export const applyGithubPolicy = <A>(
  effect: Effect.Effect<A, GithubError>,
  opts: {
    call: string;
    timeoutMs: number;
    retryOn?: (err: GithubError) => boolean;
  },
): Effect.Effect<A, GithubError> => {
  const withTimeout = effect.pipe(
    Effect.timeoutFail({
      duration: `${opts.timeoutMs} millis`,
      onTimeout: () =>
        new GithubTimeout({
          call: opts.call,
          afterMs: opts.timeoutMs,
          message: `${opts.call} timed out after ${opts.timeoutMs}ms`,
        }),
    }),
  );
  if (!opts.retryOn) return withTimeout;
  return withTimeout.pipe(
    Effect.retry({
      schedule: githubRetrySchedule,
      while: opts.retryOn,
    }),
  );
};

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
      return applyGithubPolicy(
        Effect.tryPromise({
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
                err instanceof Error
                  ? err.message
                  : `push failed: ${String(err)}`,
            });
          },
        }),
        {
          call: `pushBranch(${branch})`,
          // `git push` can be slow for large branches on slow networks.
          timeoutMs: 60_000,
          // Push is idempotent; retry on timeout only. We don't retry
          // PushFailed because a real failure (auth, conflict) won't
          // resolve itself.
          retryOn: (err) => err._tag === "GithubTimeout",
        },
      );
    },

    openPullRequest({ repoPath, branch, base, issue, body }) {
      return applyGithubPolicy(
        Effect.tryPromise({
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
        }),
        {
          call: `openPullRequest(${branch})`,
          timeoutMs: 30_000,
          // No retry: gh pr create is NOT idempotent — a partial
          // success on the previous attempt could leave a PR behind,
          // and a retry would create a duplicate.
        },
      );
    },
  };
}
