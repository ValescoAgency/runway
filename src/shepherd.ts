import { Duration, Effect } from "effect";
import type { Config } from "./config.js";
import type { GithubError, GithubGateway } from "./github.js";
import type { RunwayIssue } from "./linear.js";

/**
 * VA-460: shepherd-phase scaffolding. The shepherd loop runs after
 * `finalize` returns an open PR and drives it toward merge by reacting
 * to three subscriptions (mergeability / CI / reviewer feedback) — see
 * VA-461..463 for the wired implementations. This file is the seam;
 * subscriptions default to no-op stubs and the feature gate
 * (`config.shepherdEnabled`) is `false` for the first ship.
 */

export interface ShepherdContext {
  readonly issue: RunwayIssue;
  readonly branch: string;
  readonly prUrl: string;
  /** Parsed from `prUrl` once at loop start; subscriptions consume it. */
  readonly prNumber: number;
  readonly cwd: string;
  readonly baseBranch: string;
  readonly config: Config;
  readonly github: GithubGateway;
  /** 1-indexed; bumps after each subscription returns a non-quiet signal. */
  readonly iteration: number;
}

/**
 * What a subscription reports for a single poll.
 *
 *   quiet — nothing to act on this poll.
 *   hitl  — non-actionable; route to HITL with reason. Loop exits.
 *
 * VA-461..463 will extend this with `{ kind: "fix"; action }` so a
 * subscription can drive a sandcastle re-impl as its resolution. The
 * scaffolding deliberately stops at the two trivial cases.
 */
export type SubscriptionSignal =
  | { readonly kind: "quiet" }
  | { readonly kind: "hitl"; readonly reason: string };

export type Subscription = (
  ctx: ShepherdContext,
) => Effect.Effect<SubscriptionSignal, GithubError | { readonly message: string }>;

/**
 * Separate first-class check from A/B/C: did the PR merge between
 * polls? Default returns `false`; VA-461 plugs in `gh pr view` /
 * `pulls/:n` so the loop can exit `merged` instead of hitting the
 * iteration cap.
 */
export type MergeCheck = (
  ctx: ShepherdContext,
) => Effect.Effect<boolean, GithubError | { readonly message: string }>;

export interface ShepherdDeps {
  readonly config: Config;
  readonly cwd: string;
  readonly baseBranch: string;
  readonly github: GithubGateway;
  /** No-op default; VA-461 wires the real merge poll. */
  readonly isMerged?: MergeCheck;
  /** Empty default; VA-461/462/463 fill in mergeability/ci/reviewer. */
  readonly subscriptions?: readonly Subscription[];
  /** Override for tests; production reads `config.shepherdPollIntervalSeconds`. */
  readonly pollIntervalSeconds?: number;
  /** Override for tests; production hardcodes 3 (becomes config in VA-464). */
  readonly maxIterations?: number;
}

export type ShepherdOutcome =
  | { readonly kind: "merged" }
  | { readonly kind: "ready"; readonly reason: string }
  | { readonly kind: "hitl"; readonly reason: string };

/**
 * VA-464 follow-up will read this from `config.shepherdMaxIterations`.
 * Hardcoded here so the scaffolding ships without a half-finished
 * config knob — the feature gate keeps the loop from running in
 * production until VA-461..463 land anyway.
 */
const DEFAULT_MAX_ITERATIONS = 3;

const DEFAULT_NO_OP_MERGE_CHECK: MergeCheck = () => Effect.succeed(false);

/**
 * Parse the PR number from a GitHub PR URL
 * (`https://github.com/<owner>/<repo>/pull/<n>`). Throws when the URL
 * doesn't match — finalize only hands us GitHub PR URLs, so a parse
 * failure is a precondition violation, not a runtime branch worth
 * handling gracefully.
 */
export function parsePrNumber(prUrl: string): number {
  const m = prUrl.match(/\/pull\/(\d+)(?:[/?#]|$)/);
  if (!m) {
    throw new Error(`shepherd: cannot parse PR number from ${prUrl}`);
  }
  return Number.parseInt(m[1]!, 10);
}

export const runShepherdPass = (
  issue: RunwayIssue,
  deps: ShepherdDeps,
  branch: string,
  prUrl: string,
): Effect.Effect<
  ShepherdOutcome,
  GithubError | { readonly message: string }
> =>
  Effect.gen(function* () {
    const prNumber = parsePrNumber(prUrl);
    const isMerged = deps.isMerged ?? DEFAULT_NO_OP_MERGE_CHECK;
    const subscriptions = deps.subscriptions ?? [];
    const maxIterations = deps.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const pollSeconds =
      deps.pollIntervalSeconds ?? deps.config.shepherdPollIntervalSeconds;

    yield* Effect.logInfo(
      `${issue.identifier}: shepherd.start pr=${prUrl} branch=${branch} ` +
        `maxIterations=${maxIterations} pollSeconds=${pollSeconds}`,
    );

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      const ctx: ShepherdContext = {
        issue,
        branch,
        prUrl,
        prNumber,
        cwd: deps.cwd,
        baseBranch: deps.baseBranch,
        config: deps.config,
        github: deps.github,
        iteration,
      };

      const merged = yield* isMerged(ctx);
      if (merged) {
        yield* Effect.logInfo(
          `${issue.identifier}: shepherd.merged pr=${prUrl} iteration=${iteration}`,
        );
        return { kind: "merged" } as const;
      }

      // First non-quiet signal wins — A/B/C are checked in declaration
      // order, so callers control precedence by ordering the array.
      for (const sub of subscriptions) {
        const signal = yield* sub(ctx);
        if (signal.kind === "hitl") {
          yield* Effect.logInfo(
            `${issue.identifier}: shepherd.hitl iteration=${iteration} reason=${signal.reason}`,
          );
          return { kind: "hitl", reason: signal.reason } as const;
        }
      }

      // Sleep between polls — but not after the final iteration,
      // since the loop is about to exit `ready` anyway.
      if (iteration < maxIterations) {
        yield* Effect.sleep(Duration.seconds(pollSeconds));
      }
    }

    const reason =
      `shepherd completed ${maxIterations} poll${maxIterations === 1 ? "" : "s"} ` +
      `with no merge and no actionable signals — PR ready for human merge`;
    yield* Effect.logInfo(`${issue.identifier}: shepherd.ready ${reason}`);
    return { kind: "ready", reason } as const;
  }).pipe(Effect.withSpan("shepherd"));
