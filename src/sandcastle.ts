import { run } from "@ai-hero/sandcastle";
import { Effect, Redacted } from "effect";
import type { Config } from "./config.js";

/**
 * VA-358: thin Effect wrapper around `sandcastle.run`. The agent run
 * happens inside Docker — sandcastle doesn't (yet) expose a kill
 * handle that we can pipe through `Effect.acquireRelease`, so an
 * interrupt during a long agent pass abandons the Promise but doesn't
 * tear down the container. Step 3's acceptance documents this as a
 * sandcastle-side limitation; for git / gh subprocesses (the common
 * orphan source today) we DO get proper SIGKILL on interrupt via
 * `runExecaScoped`.
 */
export const runSandcastle = (
  args: Parameters<typeof run>[0],
): Effect.Effect<
  Awaited<ReturnType<typeof run>>,
  { readonly message: string },
  never
> =>
  Effect.tryPromise({
    try: () => run(args),
    catch: (err) => ({
      message: err instanceof Error ? err.message : String(err),
    }),
  });

/**
 * Env vars to inject into every sandcastle container. Today this is
 * just OP_SERVICE_ACCOUNT_TOKEN (when present) so the in-container
 * varlock shim can authenticate with 1Password and resolve
 * ANTHROPIC_API_KEY / GH_TOKEN at agent run time. See
 * docs/secrets-with-varlock.md for the full flow.
 */
export function dockerEnv(config: Config): Record<string, string> {
  const env: Record<string, string> = {};
  if (config.opServiceAccountToken) {
    env.OP_SERVICE_ACCOUNT_TOKEN = Redacted.value(config.opServiceAccountToken);
  }
  return env;
}

/**
 * Pulls the agent's combined output out of a sandcastle `RunResult`
 * so verdict parsers can regex over real newlines. Sandcastle's
 * `stdout` is the canonical source — falling through to
 * `JSON.stringify` (the old behavior) replaced real newlines with
 * `\n` escapes and broke `^…$/m` line anchoring (the cause of VA-353
 * tonight). The iterations/output fallbacks remain for back-compat
 * with older shapes and inline test fixtures.
 */
export function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const r = result as {
      stdout?: string;
      iterations?: Array<{ output?: string; text?: string }>;
      output?: string;
    };
    if (typeof r.stdout === "string" && r.stdout.length > 0) return r.stdout;
    if (r.iterations?.length) {
      return r.iterations
        .map((i) => i.output ?? i.text ?? "")
        .filter(Boolean)
        .join("\n");
    }
    if (typeof r.output === "string") return r.output;
    return JSON.stringify(result);
  }
  return String(result);
}

export type SandcastleRunResult = Awaited<ReturnType<typeof run>>;
