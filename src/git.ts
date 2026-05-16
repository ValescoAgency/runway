import { Data, Effect, Option } from "effect";
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
 * VA-421: Whether a branch ref exists on `origin`. Used by
 * `fetchReady` to distinguish "an agent branch has been pushed (real
 * work in flight, leave alone)" from "Linear auto-transitioned an
 * issue to In-Progress without any work actually starting (drain
 * it)". `git ls-remote --heads origin <branch>` is the cheapest
 * authoritative check — one round-trip, no clone needed, SSH
 * multiplexing usually caches the connection.
 *
 * Non-zero exit (network error, no remote configured, auth failure)
 * surfaces as an Effect failure so the caller can route it through
 * the usual error path rather than silently falling back to "doesn't
 * exist" — operator should fix the env, not have runway quietly
 * misclassify candidates.
 */
export const remoteRefExists = (
  repoPath: string,
  branch: string,
): Effect.Effect<boolean, { readonly message: string }, never> =>
  runExecaScoped(
    "git",
    ["ls-remote", "--heads", "origin", branch],
    { cwd: repoPath },
    (err) => ({
      message: err instanceof Error ? err.message : String(err),
    }),
  ).pipe(
    Effect.map((res) => {
      const raw = res.stdout;
      const out = typeof raw === "string" ? raw : "";
      return out.trim().length > 0;
    }),
  );

/**
 * VA-358: Whether the agent branch has any commits beyond `base`.
 * After VA-423 the failure-router no longer consults this predicate
 * (every failure flips to `ready-for-human` regardless), but
 * `pruneStaleAgentBranch` still uses it to decide whether a leftover
 * `agent/<id>` ref carries real work worth resetting vs. an empty
 * placeholder safe to delete. Runs with `reject: false` so a missing
 * branch / non-zero exit comes back as an empty stdout (NaN > 0 →
 * false) rather than an Effect failure; the Effect only fails if
 * execa itself throws (e.g., git binary missing), and callers
 * typically swallow that too.
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
/**
 * VA-419 / VA-424: outcome of a rebase-onto-base attempt at finalize time.
 *
 *   ok       — exit 0 (no-op or clean replay); the agent branch ref
 *              now points at the rebased commits and is safe to push.
 *   conflict — exit non-zero AND `git diff --name-only --diff-filter=U`
 *              reported unmerged files. A real merge conflict.
 *   failure  — exit non-zero with no unmerged files. Something other
 *              than a merge conflict broke the rebase (dirty host
 *              worktree, signing hook, lock contention, etc.); we
 *              capture stderr/stdout for the HITL diagnostic.
 *
 * Either non-ok outcome runs `git rebase --abort` before returning so
 * the working tree is restored.
 */
export type RebaseResult =
  | { readonly kind: "ok" }
  | { readonly kind: "conflict"; readonly conflictedFiles: readonly string[] }
  | {
      readonly kind: "failure";
      readonly stderr: string;
      readonly stdout: string;
    };

/**
 * VA-419: fetch the latest `origin/<baseBranch>` and rebase the agent
 * branch onto it. Closes the upstream-conflict-after-approval gap —
 * without this step, a PR opened off `agent/<id>` after another PR
 * merged to base mid-drain can land in `CONFLICTING` state on
 * creation.
 *
 * Layout: this runs in the host repo (`repoPath`), not in a sandcastle
 * worktree. The agent branch is a local ref; `git rebase <upstream>
 * <branch>` checks it out before replaying commits. Host cwd HEAD is
 * left wherever the rebase put it (typically on the agent branch on
 * success, or restored by `--abort` on conflict) — finalize's push
 * only cares about the ref, not the working-tree HEAD.
 *
 * The fetch step may fail (network blip, gh auth expired). We let
 * that error bubble — finalize routes it through the existing
 * processIssue failure path.
 *
 * VA-424: a non-zero rebase exit is no longer collapsed to "conflict".
 * We probe `git diff --name-only --diff-filter=U` and split: unmerged
 * files present → real merge conflict; empty → non-conflict failure
 * (dirty host worktree, signing hook, etc.). The two cases need
 * different HITL diagnostics, so we surface them separately.
 */
export const rebaseOntoBase = (
  repoPath: string,
  baseBranch: string,
  branch: string,
): Effect.Effect<RebaseResult, { readonly message: string }, never> =>
  Effect.gen(function* () {
    yield* runExecaScoped(
      "git",
      ["fetch", "origin", baseBranch],
      { cwd: repoPath },
      (err) => ({
        message: err instanceof Error ? err.message : String(err),
      }),
    );

    const rebase = yield* runExecaScoped(
      "git",
      ["rebase", `origin/${baseBranch}`, branch],
      { cwd: repoPath, reject: false },
      (err) => ({
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    if (rebase.exitCode === 0) {
      return { kind: "ok" } as const;
    }

    // Collect the unmerged file list before aborting — `--diff-filter=U`
    // matches only files git left in conflict state. Empty list means
    // the rebase failed for a non-conflict reason.
    const conflictedFiles = yield* runExecaScoped(
      "git",
      ["diff", "--name-only", "--diff-filter=U"],
      { cwd: repoPath, reject: false },
      (err) => ({
        message: err instanceof Error ? err.message : String(err),
      }),
    ).pipe(
      Effect.map((res) => {
        const raw = res.stdout;
        const out = typeof raw === "string" ? raw : "";
        return out
          .split("\n")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      }),
      Effect.catchAll(() => Effect.succeed([] as string[])),
    );

    yield* runExecaScoped(
      "git",
      ["rebase", "--abort"],
      { cwd: repoPath, reject: false },
      (err) => ({
        message: err instanceof Error ? err.message : String(err),
      }),
    ).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

    if (conflictedFiles.length > 0) {
      return { kind: "conflict", conflictedFiles } as const;
    }

    const rawStderr = (rebase as { stderr?: unknown }).stderr;
    const stderr = typeof rawStderr === "string" ? rawStderr : "";
    const rawStdout = rebase.stdout;
    const stdout = typeof rawStdout === "string" ? rawStdout : "";
    return { kind: "failure", stderr, stdout } as const;
  });

/**
 * VA-417: typed failure when neither `origin/<base>` nor local `<base>`
 * resolves to a SHA in the local refs database. The orchestrator dies
 * the drain on this — the alternative (silently skip the reset) would
 * re-trigger the no-op-on-retry pattern this fix exists to close.
 */
export class AgentBranchResetTargetUnreachable extends Data.TaggedError(
  "AgentBranchResetTargetUnreachable",
)<{
  readonly message: string;
  readonly base: string;
}> {}

/**
 * VA-366 + VA-417: ensure an `agent/<issue>` branch starts from a
 * known-good base before sandcastle's worktree creation reuses it.
 *
 * Logic:
 *   1. Branch doesn't exist → no-op (first-attempt case).
 *   2. Branch exists, zero commits ahead of `base` → VA-366: delete
 *      so the next worktree creation forks from current base HEAD
 *      instead of an old base tip.
 *   3. Branch exists with commits ahead of `base` → VA-417: those
 *      commits come from a prior attempt that review rejected
 *      (`fetchReady` filters out open PRs / non-Todo states, so any
 *      surviving commits here are from a HITL'd retry). Detach any
 *      worktree still attached to the branch, then reset the ref to
 *      `origin/<base>` (or local `<base>` as fallback) so the impl
 *      agent doesn't treat the rejected diff as authoritative.
 *
 * Steps 1 + 2 stay best-effort — git failures inside them log and
 * continue (the existing VA-366 contract). Step 3's reset-target
 * resolution surfaces a typed `AgentBranchResetTargetUnreachable`;
 * the orchestrator dies on it so the operator fixes the env rather
 * than re-trigger the no-op pattern.
 */
export const pruneStaleAgentBranch = (
  repoPath: string,
  base: string,
  branch: string,
): Effect.Effect<void, AgentBranchResetTargetUnreachable, never> =>
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

    // 2. Ahead-count. `Effect.option` distinguishes "definitively zero
    // / non-zero" from "couldn't determine"; in the latter case we
    // bail to avoid acting destructively on uncertain state.
    const hasWorkOpt = yield* hasCommits(repoPath, base, branch).pipe(
      Effect.option,
    );
    if (Option.isNone(hasWorkOpt)) return;

    if (!hasWorkOpt.value) {
      // VA-366: branch is at-or-behind base — delete so sandcastle's
      // next worktree creation forks from current base HEAD.
      yield* runExecaScoped(
        "git",
        ["branch", "-D", branch],
        { cwd: repoPath, reject: false },
        (err) => ({
          message: err instanceof Error ? err.message : String(err),
        }),
      ).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
      return;
    }

    // 3. VA-417: commits ahead of base come from a HITL-rejected
    // prior attempt. Resolve the reset target first so we fail loudly
    // (typed) before touching any worktree state.
    const target = yield* resolveResetTarget(repoPath, base);

    // 3a. Detach any worktree still attached to this branch — its
    // working tree would otherwise diverge from the new ref and
    // sandcastle would reuse it dirty (ADR 0003 reuse-with-warning).
    yield* removeAttachedWorktree(repoPath, branch);

    // 3b. Move the ref. `update-ref` (rather than `branch -f`) works
    // regardless of whether step 3a actually succeeded in detaching
    // every worktree; sandcastle's collision check still has to pass
    // before any agent code runs.
    yield* runExecaScoped(
      "git",
      ["update-ref", `refs/heads/${branch}`, target],
      { cwd: repoPath, reject: false },
      (err) => ({
        message: err instanceof Error ? err.message : String(err),
      }),
    ).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
  });

/**
 * VA-417: resolve the SHA we'll point the agent branch at. Try
 * `origin/<base>` first (canonical source for HITL-retry resets);
 * fall back to local `<base>` so a fresh / offline clone with no
 * configured remote can still recover. Surface a typed error if
 * neither resolves — silent skipping would re-trigger the no-op
 * pattern.
 */
const resolveResetTarget = (
  repoPath: string,
  base: string,
): Effect.Effect<string, AgentBranchResetTargetUnreachable, never> =>
  Effect.gen(function* () {
    const originRef = `refs/remotes/origin/${base}`;
    const originReachable = yield* runExecaScoped(
      "git",
      ["rev-parse", "--verify", originRef],
      { cwd: repoPath, reject: false },
      (err) => ({
        message: err instanceof Error ? err.message : String(err),
      }),
    ).pipe(
      Effect.map((res) => res.exitCode === 0),
      Effect.catchAll(() => Effect.succeed(false)),
    );
    if (originReachable) return originRef;

    const localRef = `refs/heads/${base}`;
    const localReachable = yield* runExecaScoped(
      "git",
      ["rev-parse", "--verify", localRef],
      { cwd: repoPath, reject: false },
      (err) => ({
        message: err instanceof Error ? err.message : String(err),
      }),
    ).pipe(
      Effect.map((res) => res.exitCode === 0),
      Effect.catchAll(() => Effect.succeed(false)),
    );
    if (localReachable) return localRef;

    return yield* Effect.fail(
      new AgentBranchResetTargetUnreachable({
        base,
        message:
          `Cannot reset stale agent branch: neither ${originRef} nor ` +
          `${localRef} resolves in ${repoPath}. Run ` +
          `\`git fetch origin ${base}\` (or set RUNWAY_BASE_BRANCH to ` +
          `a branch that exists locally) and re-run.`,
      }),
    );
  });

/**
 * VA-417: if a worktree is checked out on `branch`, remove it so the
 * branch ref can move freely. Best-effort — sandcastle's `pruneStale`
 * runs later and will collide on a stale managed worktree, so the
 * worst case here is "we tried, git refused, sandcastle warns".
 */
const removeAttachedWorktree = (
  repoPath: string,
  branch: string,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const list = yield* runExecaScoped(
      "git",
      ["worktree", "list", "--porcelain"],
      { cwd: repoPath, reject: false },
      (err) => ({
        message: err instanceof Error ? err.message : String(err),
      }),
    ).pipe(
      Effect.map((res) => (typeof res.stdout === "string" ? res.stdout : "")),
      Effect.catchAll(() => Effect.succeed("")),
    );

    const path = parseWorktreePathForBranch(list, branch);
    if (!path) return;

    yield* runExecaScoped(
      "git",
      ["worktree", "remove", "--force", path],
      { cwd: repoPath, reject: false },
      (err) => ({
        message: err instanceof Error ? err.message : String(err),
      }),
    ).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
  });

/**
 * Parse `git worktree list --porcelain` output. Each entry is a
 * `worktree <path>` line followed by metadata (`HEAD`, `branch
 * refs/heads/<name>`, …) terminated by a blank line. Return the path
 * of the first entry whose branch matches `branch`, or null.
 */
function parseWorktreePathForBranch(
  porcelain: string,
  branch: string,
): string | null {
  const refPrefix = "branch refs/heads/";
  let currentPath: string | null = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length).trim();
    } else if (line.startsWith(refPrefix)) {
      const name = line.slice(refPrefix.length).trim();
      if (name === branch && currentPath) return currentPath;
    } else if (line.trim() === "") {
      currentPath = null;
    }
  }
  return null;
}
