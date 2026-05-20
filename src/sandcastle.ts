import { run } from "@ai-hero/sandcastle";
import { Effect, Redacted } from "effect";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";

/**
 * VA-454: when sandcastle throws, its `Error.message` is opaque
 * (`claude-code exited with code 1:` with no body — the colon is
 * literal, the stderr text goes only to the log file). To stop
 * operators from having to hunt `.sandcastle/logs/` for the real
 * cause on every failure, we read the tail of the most-recently
 * modified log file in the project's `.sandcastle/logs/` directory
 * and append it to the error message.
 *
 * Tail is read by capping the byte window (cheap on huge logs) and
 * then trimming to the last `maxLines`. A missing directory or a
 * read error degrades silently — the error path must not be the
 * source of a NEW error.
 */
const SANDCASTLE_LOG_TAIL_LINES = 20;
const SANDCASTLE_LOG_TAIL_MAX_BYTES = 16 * 1024;

export function readLatestSandcastleLogTail(
  cwd: string,
  maxLines: number = SANDCASTLE_LOG_TAIL_LINES,
): string | null {
  try {
    const dir = join(cwd, ".sandcastle", "logs");
    const entries = readdirSync(dir);
    let newestPath: string | null = null;
    let newestMtime = -Infinity;
    for (const name of entries) {
      if (!name.endsWith(".log")) continue;
      const path = join(dir, name);
      const mtime = statSync(path).mtimeMs;
      if (mtime > newestMtime) {
        newestMtime = mtime;
        newestPath = path;
      }
    }
    if (!newestPath) return null;
    const size = statSync(newestPath).size;
    const offset = Math.max(0, size - SANDCASTLE_LOG_TAIL_MAX_BYTES);
    const buf = readFileSync(newestPath);
    // Trim trailing newline BEFORE splitting so a `…line 200\n` file
    // doesn't yield an empty final element that eats one slot in the
    // `slice(-maxLines)` window.
    const tail = buf.subarray(offset).toString("utf8").replace(/\n+$/, "");
    const lines = tail.split("\n");
    return lines.slice(-maxLines).join("\n");
  } catch {
    return null;
  }
}

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
    catch: (err) => {
      const base = err instanceof Error ? err.message : String(err);
      // VA-454: append the tail of the most-recent `.sandcastle/logs/`
      // file so the operator sees the real cause (e.g. "Invalid API
      // key · Fix external API key") on the same line as the
      // INFRA_ERROR — instead of having to scroll back to the run-
      // start banner for the log path and open it.
      const tail = readLatestSandcastleLogTail(
        args.cwd ?? process.cwd(),
      );
      return {
        message: tail ? `${base}\n${tail}` : base,
      };
    },
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
