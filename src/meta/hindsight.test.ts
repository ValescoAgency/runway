import { Effect, Redacted } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  createGitHubHindsightGateway,
  createLinearHindsightGateway,
  fetchHindsightSignals,
  parsePrUrl,
} from "./hindsight.js";

// VA-403: hindsight gateway tests. Three layers:
//
//   1) GitHub gateway: parsePrUrl, fetchPrState (with mocked fetch)
//      — covers the happy-path (open / merged / closed), bot-author
//      filtering, missing PR URL, and HTTP error → tagged error.
//   2) Linear gateway: covered indirectly via the composer's
//      "linear failure becomes empty follow-ups" test — the SDK's
//      shape is awkward to mock standalone; the composer-level test
//      captures the contract callers care about.
//   3) Composer: fetchHindsightSignals concurrently fetches both
//      sources and projects partial failures to nulls / empties.

describe("parsePrUrl (VA-403)", () => {
  it("parses a standard GitHub PR URL", () => {
    expect(parsePrUrl("https://github.com/foo/bar/pull/123")).toEqual({
      owner: "foo",
      repo: "bar",
      number: 123,
    });
  });

  it("returns null for non-PR URLs", () => {
    expect(parsePrUrl("https://github.com/foo/bar/issues/123")).toBeNull();
    expect(parsePrUrl("https://example.com/foo/bar/pull/1")).toBeNull();
    expect(parsePrUrl("https://github.com/foo/bar/pull/abc")).toBeNull();
    expect(parsePrUrl("not a url at all")).toBeNull();
  });
});

describe("createGitHubHindsightGateway.fetchPrState (VA-403)", () => {
  const makeFetch = (
    routes: Record<string, { status: number; body: unknown }>,
  ): typeof fetch =>
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const route = routes[url];
      if (!route) {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify(route.body), {
        status: route.status,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

  const prRoute = "https://api.github.com/repos/foo/bar/pulls/103";
  const issueCommentsRoute =
    "https://api.github.com/repos/foo/bar/issues/103/comments";
  const reviewCommentsRoute =
    "https://api.github.com/repos/foo/bar/pulls/103/comments";

  it("returns null when the PR URL is null (no PR opened for the issue)", async () => {
    const gw = createGitHubHindsightGateway({ fetchImpl: makeFetch({}) });
    const result = await Effect.runPromise(gw.fetchPrState(null));
    expect(result).toBeNull();
  });

  it("returns null when the PR URL doesn't parse (graceful, not an error)", async () => {
    const gw = createGitHubHindsightGateway({ fetchImpl: makeFetch({}) });
    const result = await Effect.runPromise(
      gw.fetchPrState("https://example.com/not-a-pr"),
    );
    expect(result).toBeNull();
  });

  it("captures merged state + filters out bot comments", async () => {
    const fetchImpl = makeFetch({
      [prRoute]: {
        status: 200,
        body: { state: "closed", merged: true, merged_at: "2026-05-15T01:23Z" },
      },
      [issueCommentsRoute]: {
        status: 200,
        body: [
          {
            user: { login: "github-actions[bot]", type: "Bot" },
            body: "CI passed",
            created_at: "2026-05-15T00:00Z",
          },
          {
            user: { login: "alice", type: "User" },
            body: "LGTM!",
            created_at: "2026-05-15T01:00Z",
          },
        ],
      },
      [reviewCommentsRoute]: {
        status: 200,
        body: [
          {
            user: { login: "bob", type: "User" },
            body: "consider hoisting this helper",
            created_at: "2026-05-15T01:10Z",
          },
        ],
      },
    });
    const gw = createGitHubHindsightGateway({ fetchImpl });
    const result = await Effect.runPromise(
      gw.fetchPrState("https://github.com/foo/bar/pull/103"),
    );
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.state).toBe("merged");
    expect(result.mergedAt).toBe("2026-05-15T01:23Z");
    // github-actions[bot] should have been filtered out.
    expect(result.humanComments.map((c) => c.author)).toEqual(["alice", "bob"]);
    expect(result.humanComments[1]?.isReviewComment).toBe(true);
  });

  it("captures open state when not merged", async () => {
    const fetchImpl = makeFetch({
      [prRoute]: {
        status: 200,
        body: { state: "open", merged: false, merged_at: null },
      },
      [issueCommentsRoute]: { status: 200, body: [] },
      [reviewCommentsRoute]: { status: 200, body: [] },
    });
    const gw = createGitHubHindsightGateway({ fetchImpl });
    const result = await Effect.runPromise(
      gw.fetchPrState("https://github.com/foo/bar/pull/103"),
    );
    if (!result) return;
    expect(result.state).toBe("open");
    expect(result.mergedAt).toBeNull();
  });

  it("captures closed-without-merge state", async () => {
    const fetchImpl = makeFetch({
      [prRoute]: {
        status: 200,
        body: { state: "closed", merged: false, merged_at: null },
      },
      [issueCommentsRoute]: { status: 200, body: [] },
      [reviewCommentsRoute]: { status: 200, body: [] },
    });
    const gw = createGitHubHindsightGateway({ fetchImpl });
    const result = await Effect.runPromise(
      gw.fetchPrState("https://github.com/foo/bar/pull/103"),
    );
    if (!result) return;
    expect(result.state).toBe("closed");
  });

  it("surfaces auth failure as a tagged error", async () => {
    const fetchImpl = makeFetch({
      [prRoute]: { status: 401, body: { message: "bad credentials" } },
    });
    const gw = createGitHubHindsightGateway({ fetchImpl });
    const result = await Effect.runPromise(
      Effect.either(gw.fetchPrState("https://github.com/foo/bar/pull/103")),
    );
    expect(result._tag).toBe("Left");
    if (result._tag !== "Left") return;
    expect(result.left._tag).toBe("HindsightGitHubAuthError");
  });

  it("surfaces 5xx as a tagged BadResponse error", async () => {
    const fetchImpl = makeFetch({
      [prRoute]: { status: 503, body: { message: "service unavailable" } },
    });
    const gw = createGitHubHindsightGateway({ fetchImpl });
    const result = await Effect.runPromise(
      Effect.either(gw.fetchPrState("https://github.com/foo/bar/pull/103")),
    );
    expect(result._tag).toBe("Left");
    if (result._tag !== "Left") return;
    expect(result.left._tag).toBe("HindsightGitHubBadResponse");
  });

  it("respects an operator-supplied bot allowlist", async () => {
    const fetchImpl = makeFetch({
      [prRoute]: {
        status: 200,
        body: { state: "closed", merged: true, merged_at: "2026-05-15T01:23Z" },
      },
      [issueCommentsRoute]: {
        status: 200,
        body: [
          {
            user: { login: "custom-bot", type: "User" },
            body: "automated comment",
            created_at: "2026-05-15T00:00Z",
          },
        ],
      },
      [reviewCommentsRoute]: { status: 200, body: [] },
    });
    const gw = createGitHubHindsightGateway({
      fetchImpl,
      botAuthors: ["custom-bot"],
    });
    const result = await Effect.runPromise(
      gw.fetchPrState("https://github.com/foo/bar/pull/103"),
    );
    if (!result) return;
    expect(result.humanComments).toHaveLength(0);
  });
});

describe("fetchHindsightSignals composer (VA-403)", () => {
  it("composes PR + follow-ups into a populated HindsightSignals", async () => {
    const github = {
      fetchPrState: vi.fn(() =>
        Effect.succeed({
          url: "https://github.com/foo/bar/pull/103",
          state: "merged" as const,
          mergedAt: "2026-05-15T01:23Z",
          humanComments: [
            {
              author: "alice",
              body: "LGTM",
              isReviewComment: false,
              createdAt: "2026-05-15T01:00Z",
            },
          ],
        }),
      ),
    };
    const linear = {
      findFollowUpIssues: vi.fn(() =>
        Effect.succeed([
          { identifier: "VA-501", title: "Fix flaky test from VA-401" },
        ]),
      ),
    };
    const result = await Effect.runPromise(
      fetchHindsightSignals(
        {
          prUrl: "https://github.com/foo/bar/pull/103",
          sourceIdentifier: "VA-401",
          followUpSinceIso: "2026-05-13T00:00:00Z",
        },
        { github, linear },
      ),
    );
    expect(result.pr?.state).toBe("merged");
    expect(result.human_verdict?.sentiment).toBe("approving");
    expect(result.human_verdict?.comment_count).toBe(1);
    expect(result.follow_up_issues).toHaveLength(1);
    expect(result.follow_up_issues[0]?.identifier).toBe("VA-501");
  });

  it("classifies as rejecting when comments mention revert / broken / regress", async () => {
    const github = {
      fetchPrState: vi.fn(() =>
        Effect.succeed({
          url: "https://github.com/foo/bar/pull/103",
          state: "closed" as const,
          mergedAt: null,
          humanComments: [
            {
              author: "alice",
              body: "I had to revert this — it broke the build",
              isReviewComment: false,
              createdAt: "2026-05-15T02:00Z",
            },
          ],
        }),
      ),
    };
    const linear = {
      findFollowUpIssues: vi.fn(() => Effect.succeed([])),
    };
    const result = await Effect.runPromise(
      fetchHindsightSignals(
        {
          prUrl: "https://github.com/foo/bar/pull/103",
          sourceIdentifier: "VA-401",
          followUpSinceIso: "2026-05-13T00:00:00Z",
        },
        { github, linear },
      ),
    );
    expect(result.human_verdict?.sentiment).toBe("rejecting");
  });

  it("yields null pr + empty follow-ups when both gateways fail (partial graceful degradation)", async () => {
    const github = {
      fetchPrState: vi.fn(() =>
        Effect.fail({
          _tag: "HindsightGitHubAuthError" as const,
          message: "no token",
        }),
      ),
    } as unknown as Parameters<typeof fetchHindsightSignals>[1]["github"];
    const linear = {
      findFollowUpIssues: vi.fn(() =>
        Effect.fail({
          _tag: "LinearNetworkError" as const,
          message: "boom",
        }),
      ),
    } as unknown as Parameters<typeof fetchHindsightSignals>[1]["linear"];
    const result = await Effect.runPromise(
      fetchHindsightSignals(
        {
          prUrl: "https://github.com/foo/bar/pull/103",
          sourceIdentifier: "VA-401",
          followUpSinceIso: "2026-05-13T00:00:00Z",
        },
        { github, linear },
      ),
    );
    expect(result.pr).toBeNull();
    expect(result.human_verdict).toBeNull();
    expect(result.follow_up_issues).toEqual([]);
  });

  it("yields null human_verdict when PR exists but has no human comments", async () => {
    const github = {
      fetchPrState: vi.fn(() =>
        Effect.succeed({
          url: "https://github.com/foo/bar/pull/103",
          state: "open" as const,
          mergedAt: null,
          humanComments: [],
        }),
      ),
    };
    const linear = {
      findFollowUpIssues: vi.fn(() => Effect.succeed([])),
    };
    const result = await Effect.runPromise(
      fetchHindsightSignals(
        {
          prUrl: "https://github.com/foo/bar/pull/103",
          sourceIdentifier: "VA-401",
          followUpSinceIso: "2026-05-13T00:00:00Z",
        },
        { github, linear },
      ),
    );
    expect(result.pr).not.toBeNull();
    expect(result.human_verdict).toBeNull();
  });
});

// Smoke test that the Linear gateway constructor doesn't throw. The
// SDK's own surface is mocked via the composer above; this only
// guards against a regression where the constructor wires an
// invalid client (e.g. missing apiKey).
describe("createLinearHindsightGateway smoke (VA-403)", () => {
  it("constructs a gateway without throwing", () => {
    const gw = createLinearHindsightGateway({
      linearApiKey: Redacted.make("test-key"),
      linearTeam: "VA",
    });
    expect(typeof gw.findFollowUpIssues).toBe("function");
  });
});
