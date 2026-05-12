import { Effect } from "effect";
import { execa, type Options, type Result, type ResultPromise } from "execa";

/**
 * VA-358: scoped subprocess runner. Spawns a child via `execa`, awaits
 * its result, and — critically — sends SIGKILL on Effect interruption
 * (Ctrl-C, parent fiber failure, timeout, etc.). Without this, a hung
 * `git push`, stalled `gh pr create`, or in-flight sandcastle agent
 * would survive process exit as an orphan.
 *
 * `classifyError` translates the raw thrown value (an `ExecaError`,
 * usually) into the caller's typed error ADT — this is the same hook
 * we used in VA-356's `Effect.tryPromise({try, catch})`, kept here so
 * the gateway methods can preserve their existing `GhCliMissing` /
 * `PushFailed` / `PrCreateFailed` discrimination.
 */
export const runExecaScoped = <E>(
  bin: string,
  args: readonly string[],
  opts: Options,
  classifyError: (err: unknown) => E,
): Effect.Effect<Result, E> =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      execa(bin, args as string[], opts) as ResultPromise,
    ),
    (proc) =>
      Effect.tryPromise({
        try: () => proc as Promise<Result>,
        catch: classifyError,
      }),
    (proc) =>
      Effect.sync(() => {
        // SIGKILL the child if it's still running when the Effect's
        // fiber is interrupted, errors, or times out. `exitCode` is
        // null until the child has settled.
        //
        // Defensive: execa's `ResultPromise` carries `.kill / .exitCode /
        // .killed`, but vitest mocks frequently return a bare `Promise`
        // (no kill handle). Skip the kill in that case — there's no
        // child to clean up.
        const killable = proc as {
          exitCode?: number | null;
          killed?: boolean;
          kill?: (signal: string) => boolean;
        };
        if (
          typeof killable.kill === "function" &&
          killable.exitCode === null &&
          !killable.killed
        ) {
          try {
            killable.kill("SIGKILL");
          } catch {
            // Race: child may have exited between the check and the
            // kill. Best-effort cleanup; nothing more to do.
          }
        }
      }),
  );
