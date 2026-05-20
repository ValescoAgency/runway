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

// VA-461: read failures (gh pr view / git merge-tree). Kept distinct
// from PushFailed / PrCreateFailed because the recovery is different
// — a read failure on the shepherd's poll is recoverable (try again
// next tick); a push or pr-create failure interrupts the workflow.
export class GithubReadFailed extends Data.TaggedError("GithubReadFailed")<{
  readonly call: string;
  readonly stderr: string;
  readonly message: string;
}> {}

export type GithubError =
  | GhCliMissing
  | PushFailed
  | PrCreateFailed
  | GithubTimeout
  | GithubReadFailed;

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

/**
 * VA-461: GitHub's `mergeable_state` enum, narrowed to the strings
 * runway actually reasons about. `dirty` and `behind` are the two
 * the shepherd acts on; the rest are surfaced verbatim so dashboards
 * can render them but the loop treats them as quiet.
 */
export type MergeableState =
  | "clean"
  | "dirty"
  | "behind"
  | "blocked"
  | "unstable"
  | "draft"
  | "unknown";

export interface PullRequestState {
  readonly number: number;
  readonly mergeableState: MergeableState;
  readonly merged: boolean;
  readonly headSha: string;
  readonly headRefName: string;
  readonly baseRefName: string;
}

/**
 * VA-463: a single comment on a PR — either a top-level discussion
 * comment, a review-thread inline comment, or a review summary
 * comment. The gateway flattens all three sources into one stream
 * so the shepherd's reviewer watcher can reason about chronological
 * order without juggling endpoints.
 */
export interface PrComment {
  /** Stable, unique within the repo for the comment's source. */
  readonly id: number;
  /** GitHub login of the comment's author. Empty string for system / app comments with no user. */
  readonly authorLogin: string;
  /** Raw markdown body as posted. */
  readonly body: string;
  /** Unix timestamp in seconds when the comment was posted. */
  readonly createdAtUnixSeconds: number;
  /** Which endpoint surfaced this comment — useful when the watcher needs to round-trip a reply. */
  readonly source: "issue" | "review" | "review-summary";
}

/**
 * VA-462: a single check run from
 * `GET /repos/:owner/:repo/commits/:sha/check-runs`. We narrow the
 * GitHub-returned conclusion enum to the values runway actually
 * reasons about; anything else falls through to `null` (incomplete).
 */
export interface CheckRun {
  readonly id: number;
  readonly name: string;
  readonly status: "queued" | "in_progress" | "completed";
  readonly conclusion:
    | "success"
    | "failure"
    | "cancelled"
    | "timed_out"
    | "neutral"
    | "skipped"
    | "action_required"
    | "stale"
    | "startup_failure"
    | null;
  /** Workflow run ID — set when status=completed for Actions checks; null for other check providers. */
  readonly runId: number | null;
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
  /**
   * VA-461: fetch the current state of an open PR (mergeability +
   * merged flag + head SHA + ref names). Used by the shepherd's
   * mergeability watcher and merge-check.
   */
  getPullRequest(args: {
    repoPath: string;
    prNumber: number;
  }): Effect.Effect<PullRequestState, GithubError>;
  /**
   * VA-461: list the files that would conflict if `branch` were
   * rebased onto `origin/<baseBranch>`. Performed locally via
   * `git merge-tree --name-only` (GitHub's API doesn't expose this).
   * Returns an empty list when the rebase would be clean (e.g.,
   * `mergeable_state=behind` — a fast-forward, no conflicts).
   */
  getConflictFiles(args: {
    repoPath: string;
    baseBranch: string;
    branch: string;
  }): Effect.Effect<readonly string[], GithubError>;
  /**
   * VA-462: list check runs for a specific commit SHA. Used by the
   * CI failure watcher to spot `conclusion: failure` on the PR's
   * head SHA. Returns an empty list when the SHA has no check runs
   * yet (e.g., right after a force-push, before CI started).
   */
  getCheckRuns(args: {
    repoPath: string;
    sha: string;
  }): Effect.Effect<readonly CheckRun[], GithubError>;
  /**
   * VA-462: list required-status-check context names from branch
   * protection. Returns `null` when the protection rule isn't
   * accessible (no admin scope, or the branch isn't protected) — the
   * watcher then conservatively treats every check as required so a
   * silent misconfiguration can't make CI failures invisible.
   */
  getRequiredChecks(args: {
    repoPath: string;
    baseBranch: string;
  }): Effect.Effect<readonly string[] | null, GithubError>;
  /**
   * VA-462: fetch the trailing `lines` of a workflow run's failed-
   * step log. Used to populate the re-impl prompt with the agent
   * context. Returns the empty string when no logs are available
   * (cancelled / startup_failure / non-Actions check providers).
   */
  getCheckRunLogTail(args: {
    repoPath: string;
    runId: number;
    lines: number;
  }): Effect.Effect<string, GithubError>;
  /**
   * VA-463: fetch every comment on the PR — top-level issue
   * comments, review-thread inline comments, and review summary
   * comments — flattened and sorted by `createdAtUnixSeconds`
   * ascending. The shepherd's reviewer watcher partitions by author
   * to decide whether to parse a `REVIEW:` marker or treat the body
   * as a verbatim human comment.
   */
  getPullRequestComments(args: {
    repoPath: string;
    prNumber: number;
  }): Effect.Effect<readonly PrComment[], GithubError>;
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

    getPullRequest({ repoPath, prNumber }) {
      return applyGithubPolicy(
        Effect.tryPromise({
          try: async () => {
            const { stdout } = await execa(
              "gh",
              [
                "pr",
                "view",
                String(prNumber),
                "--json",
                "number,mergeable,mergeStateStatus,merged,headRefOid,headRefName,baseRefName",
              ],
              { cwd: repoPath },
            );
            const parsed = JSON.parse(stdout) as {
              number: number;
              mergeable: string;
              mergeStateStatus: string;
              merged: boolean;
              headRefOid: string;
              headRefName: string;
              baseRefName: string;
            };
            // `mergeStateStatus` is the v4 enum runway maps to its
            // own `MergeableState`. gh returns it ALL_CAPS; runway
            // canonicalises to lowercase. Anything we don't
            // recognise becomes `unknown` rather than throwing — the
            // shepherd loop treats unknown as quiet, which is the
            // safe fallback.
            const mergeableState = canonicaliseMergeableState(
              parsed.mergeStateStatus,
            );
            return {
              number: parsed.number,
              mergeableState,
              merged: parsed.merged,
              headSha: parsed.headRefOid,
              headRefName: parsed.headRefName,
              baseRefName: parsed.baseRefName,
            };
          },
          catch: (err) => {
            if (isCommandMissing(err)) {
              return new GhCliMissing({
                message: `gh CLI not found on PATH (${err instanceof Error ? err.message : String(err)})`,
              });
            }
            return new GithubReadFailed({
              call: `getPullRequest(${prNumber})`,
              stderr: execaStderr(err),
              message:
                err instanceof Error
                  ? err.message
                  : `gh pr view failed: ${String(err)}`,
            });
          },
        }),
        {
          call: `getPullRequest(${prNumber})`,
          timeoutMs: 15_000,
          retryOn: (err) => err._tag === "GithubTimeout",
        },
      );
    },

    getCheckRuns({ repoPath, sha }) {
      return applyGithubPolicy(
        Effect.tryPromise({
          try: async () => {
            const { stdout } = await execa(
              "gh",
              [
                "api",
                `repos/{owner}/{repo}/commits/${sha}/check-runs`,
                "--paginate",
                "--jq",
                ".check_runs[] | {id, name, status, conclusion, run_id: (.details_url | capture(\"/runs/(?<id>[0-9]+)\") | .id | tonumber? // null)}",
              ],
              { cwd: repoPath },
            );
            // `--jq` with the streaming form returns one JSON object
            // per line. Empty stdout → no check runs yet.
            const lines = stdout.split("\n").filter((s) => s.trim().length > 0);
            return lines.map((line): CheckRun => {
              const o = JSON.parse(line) as {
                id: number;
                name: string;
                status: string;
                conclusion: string | null;
                run_id: number | null;
              };
              return {
                id: o.id,
                name: o.name,
                status: canonicaliseCheckStatus(o.status),
                conclusion: canonicaliseCheckConclusion(o.conclusion),
                runId: typeof o.run_id === "number" ? o.run_id : null,
              };
            });
          },
          catch: (err) => {
            if (isCommandMissing(err)) {
              return new GhCliMissing({
                message: `gh CLI not found on PATH (${err instanceof Error ? err.message : String(err)})`,
              });
            }
            return new GithubReadFailed({
              call: `getCheckRuns(${sha})`,
              stderr: execaStderr(err),
              message:
                err instanceof Error
                  ? err.message
                  : `gh api check-runs failed: ${String(err)}`,
            });
          },
        }),
        {
          call: `getCheckRuns(${sha})`,
          timeoutMs: 15_000,
          retryOn: (err) => err._tag === "GithubTimeout",
        },
      );
    },

    getRequiredChecks({ repoPath, baseBranch }) {
      return applyGithubPolicy(
        Effect.tryPromise({
          try: async () => {
            try {
              const { stdout } = await execa(
                "gh",
                [
                  "api",
                  `repos/{owner}/{repo}/branches/${baseBranch}/protection/required_status_checks`,
                  "--jq",
                  ".contexts // []",
                ],
                { cwd: repoPath },
              );
              const trimmed = stdout.trim();
              if (!trimmed) return null;
              const parsed = JSON.parse(trimmed) as string[];
              return parsed;
            } catch (err) {
              // 404 (branch not protected) and 403 (no admin) are
              // both expected — fall back to "filter unknown" by
              // returning null. The watcher treats null as
              // "conservatively require all checks" so a missing
              // protection rule can't silently hide failures.
              const stderr = execaStderr(err);
              if (
                stderr.includes("404") ||
                stderr.includes("403") ||
                stderr.includes("Branch not protected")
              ) {
                return null;
              }
              throw err;
            }
          },
          catch: (err) => {
            if (isCommandMissing(err)) {
              return new GhCliMissing({
                message: `gh CLI not found on PATH (${err instanceof Error ? err.message : String(err)})`,
              });
            }
            return new GithubReadFailed({
              call: `getRequiredChecks(${baseBranch})`,
              stderr: execaStderr(err),
              message:
                err instanceof Error
                  ? err.message
                  : `gh api branch-protection failed: ${String(err)}`,
            });
          },
        }),
        {
          call: `getRequiredChecks(${baseBranch})`,
          timeoutMs: 15_000,
          retryOn: (err) => err._tag === "GithubTimeout",
        },
      );
    },

    getCheckRunLogTail({ repoPath, runId, lines }) {
      return applyGithubPolicy(
        Effect.tryPromise({
          try: async () => {
            try {
              // `gh run view <id> --log-failed` is the supported way
              // to fetch only the failed-step logs of an Actions run.
              // Non-Actions checks have no runId and don't reach this
              // path; the gateway caller maps `runId === null` to an
              // empty tail upstream.
              const { stdout } = await execa(
                "gh",
                ["run", "view", String(runId), "--log-failed"],
                { cwd: repoPath },
              );
              const all = stdout.split("\n");
              if (all.length <= lines) return stdout;
              return all.slice(-lines).join("\n");
            } catch (err) {
              const stderr = execaStderr(err);
              // 404 (run gone) or "no logs" → empty tail rather than
              // throwing; the agent gets the check name only.
              if (
                stderr.includes("404") ||
                stderr.includes("no logs") ||
                stderr.includes("expired")
              ) {
                return "";
              }
              throw err;
            }
          },
          catch: (err) => {
            if (isCommandMissing(err)) {
              return new GhCliMissing({
                message: `gh CLI not found on PATH (${err instanceof Error ? err.message : String(err)})`,
              });
            }
            return new GithubReadFailed({
              call: `getCheckRunLogTail(${runId})`,
              stderr: execaStderr(err),
              message:
                err instanceof Error
                  ? err.message
                  : `gh run view failed: ${String(err)}`,
            });
          },
        }),
        {
          call: `getCheckRunLogTail(${runId})`,
          timeoutMs: 30_000,
          retryOn: (err) => err._tag === "GithubTimeout",
        },
      );
    },

    getPullRequestComments({ repoPath, prNumber }) {
      return applyGithubPolicy(
        Effect.tryPromise({
          try: async () => {
            // Three endpoints, three flavors of comment. We fetch
            // them in parallel and merge by createdAt — keeping
            // source labels so the watcher knows where each one
            // came from if it ever needs to round-trip a reply.
            const fetchJson = async (path: string, jq: string) => {
              const { stdout } = await execa(
                "gh",
                ["api", path, "--paginate", "--jq", jq],
                { cwd: repoPath },
              );
              const lines = stdout
                .split("\n")
                .filter((s) => s.trim().length > 0);
              return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
            };
            const projection =
              ".[] | {id, body, login: (.user.login // \"\"), created_at}";
            const [issueComments, reviewComments, reviewSummaries] =
              await Promise.all([
                fetchJson(
                  `repos/{owner}/{repo}/issues/${prNumber}/comments`,
                  projection,
                ),
                fetchJson(
                  `repos/{owner}/{repo}/pulls/${prNumber}/comments`,
                  projection,
                ),
                // Review summaries omit empty bodies (a review can be
                // submitted with no top-level body — only inline
                // comments). The `select(.body != "")` filter drops
                // those so they don't show up as ghost entries.
                fetchJson(
                  `repos/{owner}/{repo}/pulls/${prNumber}/reviews`,
                  ".[] | select(.body != \"\" and .body != null) | {id, body, login: (.user.login // \"\"), submitted_at}",
                ),
              ]);
            const norm = (
              o: Record<string, unknown>,
              source: PrComment["source"],
              tsField: "created_at" | "submitted_at",
            ): PrComment => ({
              id: Number(o.id ?? 0),
              authorLogin: String(o.login ?? ""),
              body: String(o.body ?? ""),
              createdAtUnixSeconds: Math.floor(
                new Date(String(o[tsField] ?? 0)).getTime() / 1000,
              ),
              source,
            });
            const merged: PrComment[] = [
              ...issueComments.map((c) => norm(c, "issue", "created_at")),
              ...reviewComments.map((c) => norm(c, "review", "created_at")),
              ...reviewSummaries.map((c) =>
                norm(c, "review-summary", "submitted_at"),
              ),
            ];
            merged.sort(
              (a, b) => a.createdAtUnixSeconds - b.createdAtUnixSeconds,
            );
            return merged;
          },
          catch: (err) => {
            if (isCommandMissing(err)) {
              return new GhCliMissing({
                message: `gh CLI not found on PATH (${err instanceof Error ? err.message : String(err)})`,
              });
            }
            return new GithubReadFailed({
              call: `getPullRequestComments(${prNumber})`,
              stderr: execaStderr(err),
              message:
                err instanceof Error
                  ? err.message
                  : `gh api comments failed: ${String(err)}`,
            });
          },
        }),
        {
          call: `getPullRequestComments(${prNumber})`,
          timeoutMs: 30_000,
          retryOn: (err) => err._tag === "GithubTimeout",
        },
      );
    },

    getConflictFiles({ repoPath, baseBranch, branch }) {
      return applyGithubPolicy(
        Effect.tryPromise({
          try: async () => {
            // Step 1: refresh origin/<base> so the merge-tree below
            // reasons about the latest remote state, not whatever
            // the cwd happened to have fetched last.
            await execa("git", ["fetch", "origin", baseBranch], {
              cwd: repoPath,
            });
            // Step 2: simulate the merge. `git merge-tree --name-only`
            // (git >= 2.38) prints only the conflicted paths, one per
            // line, on stdout. Exit code is non-zero when there ARE
            // conflicts, so we read stdout regardless of status.
            const result = await execa(
              "git",
              [
                "merge-tree",
                "--name-only",
                "--no-messages",
                `origin/${baseBranch}`,
                branch,
              ],
              { cwd: repoPath, reject: false },
            );
            const files = result.stdout
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean);
            return files;
          },
          catch: (err) => {
            if (isCommandMissing(err)) {
              return new GhCliMissing({
                message: `git not found on PATH (${err instanceof Error ? err.message : String(err)})`,
              });
            }
            return new GithubReadFailed({
              call: `getConflictFiles(${branch}→${baseBranch})`,
              stderr: execaStderr(err),
              message:
                err instanceof Error
                  ? err.message
                  : `git merge-tree failed: ${String(err)}`,
            });
          },
        }),
        {
          call: `getConflictFiles(${branch})`,
          timeoutMs: 30_000,
          retryOn: (err) => err._tag === "GithubTimeout",
        },
      );
    },
  };
}

function canonicaliseCheckStatus(raw: string): CheckRun["status"] {
  switch (raw.toLowerCase()) {
    case "queued":
      return "queued";
    case "in_progress":
      return "in_progress";
    case "completed":
      return "completed";
    default:
      // Unknown status — treat as queued so the watcher waits for a
      // final conclusion rather than acting on intermediate state.
      return "queued";
  }
}

function canonicaliseCheckConclusion(
  raw: string | null,
): CheckRun["conclusion"] {
  if (raw === null) return null;
  switch (raw.toLowerCase()) {
    case "success":
    case "failure":
    case "cancelled":
    case "timed_out":
    case "neutral":
    case "skipped":
    case "action_required":
    case "stale":
    case "startup_failure":
      return raw.toLowerCase() as CheckRun["conclusion"];
    default:
      return null;
  }
}

function canonicaliseMergeableState(raw: string): MergeableState {
  switch (raw.toLowerCase()) {
    case "clean":
      return "clean";
    case "dirty":
      return "dirty";
    case "behind":
      return "behind";
    case "blocked":
      return "blocked";
    case "unstable":
      return "unstable";
    case "draft":
      return "draft";
    default:
      return "unknown";
  }
}
