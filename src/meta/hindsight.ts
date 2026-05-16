import { LinearClient } from "@linear/sdk";
import { Data, Effect, Redacted } from "effect";
import { applyLinearPolicy, type LinearError } from "../linear.js";
import type {
  HindsightFollowUpIssue,
  HindsightHumanVerdict,
  HindsightPr,
  HindsightSignals,
} from "./templates.js";

/**
 * VA-403: hindsight gateway. The IRA's Run Review v1.1.0 grades a
 * run against what the world said about it after the fact —
 * specifically:
 *
 *   1. did the PR merge / close-without-merge / stay open?
 *   2. did a human comment on the review threads (and what was the
 *      gist — approving, neutral, rejecting)?
 *   3. did anyone file follow-up Linear issues that reference the
 *      source identifier in the 48h window after the drain?
 *
 * Each source is fetched independently so partial hindsight (e.g.
 * GitHub token missing, but Linear works) still produces a
 * partially-populated `HindsightSignals` rather than failing the
 * whole review. The runner constructs the gateway with whatever
 * tokens are available; gateways with no token return null for that
 * sub-section.
 *
 * The "summary" the IRA emits in its Run Review is its own work —
 * we feed it the raw comments / outcomes in the user prompt and let
 * it judge sentiment. The gateway here only captures the raw
 * signals; the IRA does the interpretation.
 */

// ---------------------------------------------------------------------------
// Error ADT — independent per source so a failure in one doesn't
// poison the whole context load
// ---------------------------------------------------------------------------

export class HindsightGitHubNetworkError extends Data.TaggedError(
  "HindsightGitHubNetworkError",
)<{ readonly url: string; readonly message: string }> {}

export class HindsightGitHubAuthError extends Data.TaggedError(
  "HindsightGitHubAuthError",
)<{ readonly message: string }> {}

export class HindsightGitHubBadResponse extends Data.TaggedError(
  "HindsightGitHubBadResponse",
)<{ readonly status: number; readonly url: string; readonly message: string }> {}

export type HindsightError =
  | HindsightGitHubNetworkError
  | HindsightGitHubAuthError
  | HindsightGitHubBadResponse;

// ---------------------------------------------------------------------------
// Captured — what the gateway returns to the context loader
// ---------------------------------------------------------------------------

/**
 * A single human comment on a PR's review threads. `isReviewComment`
 * is true for review-thread inline comments, false for top-level PR
 * comments — both are "human said something on the PR" but the IRA
 * may weigh review-thread comments more (they're tied to specific
 * lines).
 */
export interface CapturedHumanComment {
  readonly author: string;
  readonly body: string;
  readonly isReviewComment: boolean;
  readonly createdAt: string;
}

/**
 * Captured PR state. `humanComments` is the raw stream the IRA
 * summarises into `HindsightHumanVerdict.summary`. `humanCommentCount`
 * is the count after bot-author filtering.
 */
export interface CapturedPrState {
  readonly url: string;
  readonly state: HindsightPr["state"];
  readonly mergedAt: string | null;
  readonly humanComments: readonly CapturedHumanComment[];
}

// ---------------------------------------------------------------------------
// GitHub gateway — PR state + human comments
// ---------------------------------------------------------------------------

export interface GitHubHindsightGateway {
  /**
   * Fetch the PR's state + the human comments on its review threads.
   * Returns `null` when the PR URL can't be parsed (e.g. issue had
   * no PR opened — the IRA grades on absence-of-PR as a signal).
   */
  fetchPrState(
    prUrl: string | null,
  ): Effect.Effect<CapturedPrState | null, HindsightError>;
}

export interface GitHubHindsightConfig {
  /**
   * Optional GitHub token. Without it, GitHub's REST API rate-limits
   * to 60 reqs/hr unauthenticated and won't return private-repo
   * data. With it, 5000/hr and full visibility. The runner reads
   * `GITHUB_TOKEN` from env when set; absent token is OK for
   * public-repo runs.
   */
  readonly token?: string;
  /**
   * Authors whose comments are filtered out of `humanComments` —
   * runway's own bot identity, GitHub Actions, dependabot, etc. The
   * comparison is case-insensitive on `login`. The runner provides
   * a sensible default; tests override.
   */
  readonly botAuthors?: readonly string[];
  /**
   * Optional fetch override for tests. Defaults to global `fetch`.
   */
  readonly fetchImpl?: typeof fetch;
}

export const DEFAULT_BOT_AUTHORS: readonly string[] = [
  "github-actions[bot]",
  "dependabot[bot]",
  "renovate[bot]",
  "claude",
  "claude-code[bot]",
  "runway-bot",
];

interface PrUrlParts {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

/**
 * Parse a GitHub PR URL into owner/repo/number. Returns null when
 * the URL doesn't match the expected `https://github.com/<owner>/<repo>/pull/<n>`
 * shape — the gateway treats this as "no PR" rather than erroring,
 * so a malformed `pr_url` column doesn't crash the IRA pass.
 */
export function parsePrUrl(url: string): PrUrlParts | null {
  const m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (!m) return null;
  const num = Number(m[3]);
  if (!Number.isInteger(num) || num <= 0) return null;
  return { owner: m[1] ?? "", repo: m[2] ?? "", number: num };
}

export function createGitHubHindsightGateway(
  config: GitHubHindsightConfig = {},
): GitHubHindsightGateway {
  const fetchImpl = config.fetchImpl ?? fetch;
  const botAuthors = new Set(
    (config.botAuthors ?? DEFAULT_BOT_AUTHORS).map((s) => s.toLowerCase()),
  );

  const headers = (): Record<string, string> => {
    const h: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (config.token) h.Authorization = `Bearer ${config.token}`;
    return h;
  };

  const ghJson = <T>(url: string): Effect.Effect<T, HindsightError> =>
    Effect.tryPromise({
      try: async () => {
        const res = await fetchImpl(url, { headers: headers() });
        if (res.status === 401 || res.status === 403) {
          throw new HindsightGitHubAuthError({
            message: `GitHub ${res.status} ${res.statusText} for ${url}`,
          });
        }
        if (!res.ok) {
          throw new HindsightGitHubBadResponse({
            status: res.status,
            url,
            message: `GitHub ${res.status} ${res.statusText}`,
          });
        }
        return (await res.json()) as T;
      },
      catch: (err) => {
        if (
          err instanceof HindsightGitHubAuthError ||
          err instanceof HindsightGitHubBadResponse
        ) {
          return err;
        }
        return new HindsightGitHubNetworkError({
          url,
          message: err instanceof Error ? err.message : String(err),
        });
      },
    });

  return {
    fetchPrState(prUrl) {
      if (!prUrl) return Effect.succeed(null);
      const parts = parsePrUrl(prUrl);
      if (!parts) return Effect.succeed(null);
      return Effect.gen(function* () {
        const base = `https://api.github.com/repos/${parts.owner}/${parts.repo}/pulls/${parts.number}`;
        const pr = yield* ghJson<{
          state?: string;
          merged?: boolean;
          merged_at?: string | null;
        }>(base);
        const state: HindsightPr["state"] = pr.merged
          ? "merged"
          : pr.state === "open"
            ? "open"
            : "closed";

        // Fetch top-level issue comments + review-thread comments in
        // parallel. Issue-comments endpoint returns the PR's "general
        // discussion" (since GH treats PRs as issues for comments);
        // review-comments endpoint returns the inline diff comments.
        const [issueComments, reviewComments] = yield* Effect.all(
          [
            ghJson<
              ReadonlyArray<{
                user?: { login?: string; type?: string } | null;
                body?: string;
                created_at?: string;
              }>
            >(
              `https://api.github.com/repos/${parts.owner}/${parts.repo}/issues/${parts.number}/comments`,
            ),
            ghJson<
              ReadonlyArray<{
                user?: { login?: string; type?: string } | null;
                body?: string;
                created_at?: string;
              }>
            >(
              `https://api.github.com/repos/${parts.owner}/${parts.repo}/pulls/${parts.number}/comments`,
            ),
          ],
          { concurrency: "unbounded" },
        );

        const projected: CapturedHumanComment[] = [];
        const project = (
          src: typeof issueComments,
          isReview: boolean,
        ): void => {
          for (const c of src) {
            const login = c.user?.login;
            if (!login) continue;
            // Bot-author filter: skip the runway bot, GH Actions,
            // dependabot — anyone known to comment automatically. The
            // human-vs-bot distinction is the whole point of "human
            // verdict" so we exclude noisy automated chatter.
            if (botAuthors.has(login.toLowerCase())) continue;
            if (c.user?.type === "Bot") continue;
            const body = (c.body ?? "").trim();
            if (body.length === 0) continue;
            projected.push({
              author: login,
              body,
              isReviewComment: isReview,
              createdAt: c.created_at ?? "",
            });
          }
        };
        project(issueComments, false);
        project(reviewComments, true);

        return {
          url: prUrl,
          state,
          mergedAt: pr.merged_at ?? null,
          humanComments: projected,
        } satisfies CapturedPrState;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Linear follow-up gateway — issues filed in the past N hours that
// reference the source identifier
// ---------------------------------------------------------------------------

export interface LinearHindsightGateway {
  /**
   * Find Linear issues created since `sinceIso` whose body or title
   * references `sourceIdentifier`. The IRA reads these as "did the
   * run cause downstream pain we should grade against?"
   *
   * "References" = the identifier appears in the issue's title,
   * description, or labels. Filtering happens server-side via the
   * Linear search API; an empty result is the common case (well-
   * scoped runs don't generate follow-ups).
   */
  findFollowUpIssues(args: {
    readonly sourceIdentifier: string;
    readonly sinceIso: string;
  }): Effect.Effect<readonly HindsightFollowUpIssue[], LinearError>;
}

export interface LinearHindsightConfig {
  readonly linearApiKey: Redacted.Redacted<string>;
  readonly linearTeam: string;
}

export function createLinearHindsightGateway(
  config: LinearHindsightConfig,
): LinearHindsightGateway {
  const client = new LinearClient({
    apiKey: Redacted.value(config.linearApiKey),
  });
  return {
    findFollowUpIssues(args) {
      return applyLinearPolicy(
        Effect.tryPromise({
          try: async () => {
            // Filter on the Linear team so cross-workspace noise stays
            // out. Two queries (title-contains, description-contains)
            // unioned client-side because Linear's filter language
            // doesn't OR the two text columns natively.
            const [byTitle, byDescription] = await Promise.all([
              client.issues({
                filter: {
                  team: { key: { eq: config.linearTeam } },
                  createdAt: { gte: args.sinceIso },
                  title: { contains: args.sourceIdentifier },
                },
                first: 50,
              }),
              client.issues({
                filter: {
                  team: { key: { eq: config.linearTeam } },
                  createdAt: { gte: args.sinceIso },
                  description: { contains: args.sourceIdentifier },
                },
                first: 50,
              }),
            ]);
            const seen = new Set<string>();
            const out: HindsightFollowUpIssue[] = [];
            for (const node of [...byTitle.nodes, ...byDescription.nodes]) {
              if (seen.has(node.identifier)) continue;
              // Skip self-references — the source issue itself is
              // not a follow-up.
              if (node.identifier === args.sourceIdentifier) continue;
              seen.add(node.identifier);
              out.push({ identifier: node.identifier, title: node.title });
            }
            return out;
          },
          catch: (err) =>
            ({
              _tag: "LinearNetworkError" as const,
              message: err instanceof Error ? err.message : String(err),
            }) as unknown as LinearError,
        }),
        { call: "linearHindsight.findFollowUpIssues" },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Composition — fetch all sources concurrently into the typed shape
// the v1.1.0 RunReview schema expects
// ---------------------------------------------------------------------------

export interface FetchHindsightArgs {
  readonly prUrl: string | null;
  readonly sourceIdentifier: string;
  /** Cutoff for the follow-up window — issues created at-or-after this. */
  readonly followUpSinceIso: string;
}

/**
 * VA-403: top-level composition. Fetches PR state + Linear follow-ups
 * concurrently, projecting failures to nulls so a partially-broken
 * gateway still yields a usable `HindsightSignals` shape. The IRA
 * treats a null sub-section as "no signal here" — distinct from an
 * empty array (a populated sub-section with zero results).
 */
export const fetchHindsightSignals = (
  args: FetchHindsightArgs,
  gateways: {
    readonly github: GitHubHindsightGateway;
    readonly linear: LinearHindsightGateway;
  },
): Effect.Effect<HindsightSignals, never> =>
  Effect.gen(function* () {
    const [prResult, followUpsResult] = yield* Effect.all(
      [
        gateways.github.fetchPrState(args.prUrl).pipe(Effect.either),
        gateways.linear
          .findFollowUpIssues({
            sourceIdentifier: args.sourceIdentifier,
            sinceIso: args.followUpSinceIso,
          })
          .pipe(Effect.either),
      ],
      { concurrency: "unbounded" },
    );

    const prState =
      prResult._tag === "Right" ? prResult.right : null;
    const followUps: HindsightFollowUpIssue[] =
      followUpsResult._tag === "Right" ? [...followUpsResult.right] : [];

    return {
      pr: prState
        ? {
            url: prState.url,
            state: prState.state,
            merged_at: prState.mergedAt,
          }
        : null,
      // Coarse `human_verdict` summary computed orchestrator-side from
      // the raw comments — keeps a stable shape even when the IRA
      // chooses to cite specific comments in its `summary` field.
      // The IRA can override / refine in its own emitted JSON.
      human_verdict: prState && prState.humanComments.length > 0
        ? summariseHumanVerdict(prState.humanComments)
        : null,
      follow_up_issues: followUps,
    };
  });

/**
 * VA-403: a deterministic first-pass sentiment classification over the
 * captured human comments — keyword-driven, bounded, no LLM. The IRA
 * can refine in its emitted Review JSON (it sees the raw comment
 * bodies in the prompt) but a stable orchestrator-side default means
 * the dashboard can render `human_verdict.sentiment` even before any
 * Run Review has been written.
 *
 * Heuristic: any comment containing rejecting keywords ("revert",
 * "broken", "regress", "rollback", "reverted") flips to rejecting;
 * otherwise approving keywords (LGTM, approve, ship it, looks good)
 * flip to approving; default neutral.
 */
function summariseHumanVerdict(
  comments: readonly CapturedHumanComment[],
): HindsightHumanVerdict {
  const lower = comments.map((c) => c.body.toLowerCase());
  const rejecting = lower.some((t) =>
    /revert|broke|broken|regress|rollback|reverted|do not merge/.test(t),
  );
  const approving =
    !rejecting &&
    lower.some((t) =>
      /\blgtm\b|\bapprove\b|\bapproved\b|ship it|looks good|nice work/.test(t),
    );
  const sentiment: HindsightHumanVerdict["sentiment"] = rejecting
    ? "rejecting"
    : approving
      ? "approving"
      : "neutral";
  const authors = Array.from(new Set(comments.map((c) => c.author))).slice(0, 3);
  const summary = `${comments.length} human comment(s) from ${authors.join(", ")}`;
  return {
    sentiment,
    comment_count: comments.length,
    summary,
  };
}
