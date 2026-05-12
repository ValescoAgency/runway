import { Data, Effect } from "effect";
import { runExecaScoped } from "./subprocess.js";

/**
 * VA-358: thin typed error for `detectBaseBranch`. We don't model
 * every git failure mode — the orchestrator just wants to know "did
 * we get a branch name back?" If not, surface a single error so the
 * caller can fail fast with a helpful message. As a `Data.TaggedError`
 * it's an Error instance, so vitest's `.rejects.toThrow(/regex/)`
 * works the same as before this refactor.
 */
export class BaseBranchDetectionFailed extends Data.TaggedError(
  "BaseBranchDetectionFailed",
)<{
  readonly message: string;
}> {}

/**
 * Resolve the default branch name of the cwd repo. Tries
 * `git symbolic-ref` against `origin/HEAD` first (fast, works on any
 * clone where the symbolic ref has been set), then falls back to
 * `git remote show origin` (slower, hits the network but works on
 * fresh clones that never had `origin/HEAD` set locally).
 *
 * VA-358: now an Effect so the orchestrator program can stay in
 * Effect-land end-to-end. Subprocess kills propagate via
 * `runExecaScoped` if the orchestrator fiber is interrupted.
 */
export const detectBaseBranch = (
  repoPath: string,
): Effect.Effect<string, BaseBranchDetectionFailed> =>
  Effect.gen(function* () {
    // Fast path: local symbolic ref. Returns e.g. `origin/main`.
    const symbolic = yield* runExecaScoped(
      "git",
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      { cwd: repoPath, reject: false },
      (err) =>
        new BaseBranchDetectionFailed({
          message: err instanceof Error ? err.message : String(err),
        }),
    ).pipe(Effect.either);

    if (symbolic._tag === "Right" && symbolic.right.exitCode === 0) {
      // execa's `stdout` type is a union (encoding-dependent). We don't
      // change `encoding`, so it's `string` at runtime — narrow here
      // rather than fighting the generic types upstream.
      const raw = symbolic.right.stdout;
      const out = typeof raw === "string" ? raw : "";
      const name = out.trim().replace(/^origin\//, "");
      if (name) return name;
    }

    // Slow path: ask the remote. Output line: `  HEAD branch: master`.
    const remoteShow = yield* runExecaScoped(
      "git",
      ["remote", "show", "origin"],
      { cwd: repoPath },
      (err) =>
        new BaseBranchDetectionFailed({
          message: err instanceof Error ? err.message : String(err),
        }),
    ).pipe(Effect.either);

    if (remoteShow._tag === "Right") {
      const raw = remoteShow.right.stdout;
      const out = typeof raw === "string" ? raw : "";
      const match = out.match(/^\s*HEAD branch:\s*(\S+)\s*$/m);
      if (match?.[1]) return match[1];
    }

    return yield* Effect.fail(
      new BaseBranchDetectionFailed({
        message:
          `Could not detect the default branch of ${repoPath}. ` +
          `Set RUNWAY_BASE_BRANCH explicitly, or run ` +
          `\`git remote set-head origin --auto\` to populate origin/HEAD.`,
      }),
    );
  });

/**
 * Capture `git diff base...branch` as a string for the review
 * prompt. Truncated to 60_000 chars to keep the reviewer's context
 * budget under control — larger diffs almost always mean the issue
 * was scoped too wide and will benefit from human review anyway.
 */
export const captureDiff = (
  repoPath: string,
  base: string,
  branch: string,
): Effect.Effect<string, { readonly message: string }, never> =>
  runExecaScoped(
    "git",
    ["diff", `${base}...${branch}`],
    { cwd: repoPath },
    (err) => ({
      message: err instanceof Error ? err.message : String(err),
    }),
  ).pipe(
    Effect.map((res) => {
      const raw = res.stdout;
      const out = typeof raw === "string" ? raw : "";
      return out.length > 60_000 ? `${out.slice(0, 60_000)}\n…(truncated)` : out;
    }),
  );

/**
 * Capture `git log --oneline base..branch` for the review prompt and
 * for the implement loop's per-iteration summary. Empty string when
 * the branch has no commits beyond base.
 */
export const captureCommitLog = (
  repoPath: string,
  base: string,
  branch: string,
): Effect.Effect<string, { readonly message: string }, never> =>
  runExecaScoped(
    "git",
    ["log", "--oneline", `${base}..${branch}`],
    { cwd: repoPath },
    (err) => ({
      message: err instanceof Error ? err.message : String(err),
    }),
  ).pipe(
    Effect.map((res) => {
      const raw = res.stdout;
      return typeof raw === "string" ? raw : "";
    }),
  );

/**
 * VA-358: Whether the agent branch has any commits beyond `base`.
 * Used by failure-routing to distinguish "agent crashed mid-run,
 * after producing real work" (→ HITL) from "agent crashed during
 * startup, no work done" (→ revert to readyStatus). Runs with
 * `reject: false` so a missing branch / non-zero exit comes back as
 * an empty stdout (NaN > 0 → false) rather than an Effect failure;
 * the Effect only fails if execa itself throws (e.g., git binary
 * missing), and callers typically swallow that too.
 */
export const hasCommits = (
  repoPath: string,
  base: string,
  branch: string,
): Effect.Effect<boolean, { readonly message: string }, never> =>
  runExecaScoped(
    "git",
    ["rev-list", "--count", `${base}..${branch}`],
    { cwd: repoPath, reject: false },
    (err) => ({
      message: err instanceof Error ? err.message : String(err),
    }),
  ).pipe(
    Effect.map((res) => {
      const raw = res.stdout;
      const out = typeof raw === "string" ? raw : "";
      return Number.parseInt(out.trim(), 10) > 0;
    }),
  );

/**
 * VA-366: prune an agent/<issue> branch from a prior failed attempt
 * so the next worktree creation forks from current `base` HEAD
 * instead of reusing a stale tip.
 *
 * Logic:
 *   1. If the branch doesn't exist → no-op.
 *   2. If it has commits ahead of `base` (`hasCommits` returns true)
 *      → preserve. Agent did real work; resetting would discard it.
 *   3. Otherwise (branch present, no commits ahead) → `git branch -D`.
 *      `-D` (not `-d`) because the branch tip equals or trails base
 *      after the failed attempt, and `-d`'s merge check can refuse
 *      otherwise-equivalent tips.
 *
 * Best-effort: this is a *retry hygiene* operation, not a correctness
 * guarantee. If git fails, we log and continue — sandcastle's
 * worktree creation will still work; the agent just sees the stale
 * branch state that motivated this fix.
 */
export const pruneStaleAgentBranch = (
  repoPath: string,
  base: string,
  branch: string,
): Effect.Effect<void, { readonly message: string }, never> =>
  Effect.gen(function* () {
    // 1. Existence check.
    const exists = yield* runExecaScoped(
      "git",
      ["rev-parse", "--verify", `refs/heads/${branch}`],
      { cwd: repoPath, reject: false },
      (err) => ({
        message: err instanceof Error ? err.message : String(err),
      }),
    ).pipe(
      Effect.map((res) => res.exitCode === 0),
      Effect.catchAll(() => Effect.succeed(false)),
    );
    if (!exists) return;

    // 2. Preserve if the branch carries real work.
    const hasWork = yield* hasCommits(repoPath, base, branch).pipe(
      // If we can't tell, prefer the safe option — keep the branch.
      Effect.catchAll(() => Effect.succeed(true)),
    );
    if (hasWork) return;

    // 3. Stale → delete so the next worktree creation forks from base HEAD.
    yield* runExecaScoped(
      "git",
      ["branch", "-D", branch],
      { cwd: repoPath, reject: false },
      (err) => ({
        message: err instanceof Error ? err.message : String(err),
      }),
    ).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
  });
