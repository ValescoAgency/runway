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
