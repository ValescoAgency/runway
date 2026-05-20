import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import type { GithubGateway } from "./github.js";
import type { RunwayIssue } from "./linear.js";
import {
  parsePrNumber,
  runShepherdPass,
  type Subscription,
} from "./shepherd.js";

// VA-460 — shepherd-phase scaffolding tests. The subscriptions are
// stubbed via the `subscriptions` dep so we drive each outcome kind
// without hitting GitHub. Poll interval is forced to 0s so the loop
// runs to completion in milliseconds.

const ISSUE: RunwayIssue = {
  id: "issue-uuid",
  identifier: "VA-460",
  title: "shepherd test fixture",
  description: "",
  labels: [],
};

const PR_URL = "https://github.com/ValescoAgency/runway/pull/123";

function makeConfig(): Config {
  // Tests only read shepherdPollIntervalSeconds; everything else is
  // present-but-unused. Cast keeps the test fixture minimal.
  return {
    shepherdEnabled: true,
    shepherdPollIntervalSeconds: 0,
  } as unknown as Config;
}

function makeGithub(): GithubGateway {
  return {
    pushBranch: vi.fn(),
    openPullRequest: vi.fn(),
  } as unknown as GithubGateway;
}

const QUIET: Subscription = () => Effect.succeed({ kind: "quiet" });

function hitlSub(reason: string): Subscription {
  return () => Effect.succeed({ kind: "hitl", reason });
}

describe("parsePrNumber", () => {
  it("extracts the number from a canonical PR URL", () => {
    expect(parsePrNumber("https://github.com/owner/repo/pull/42")).toBe(42);
  });

  it("ignores trailing slashes / query / fragment", () => {
    expect(parsePrNumber("https://github.com/owner/repo/pull/42/")).toBe(42);
    expect(parsePrNumber("https://github.com/owner/repo/pull/42?foo=1")).toBe(
      42,
    );
    expect(parsePrNumber("https://github.com/owner/repo/pull/42#diff")).toBe(
      42,
    );
  });

  it("throws on a URL that isn't a PR link", () => {
    expect(() => parsePrNumber("https://example.com/")).toThrow(/cannot parse/);
  });
});

describe("runShepherdPass — VA-460 scaffolding", () => {
  it("returns { kind: 'merged' } when the merge check fires", async () => {
    const isMerged = vi
      .fn()
      .mockReturnValueOnce(Effect.succeed(false))
      .mockReturnValueOnce(Effect.succeed(true));

    const outcome = await Effect.runPromise(
      runShepherdPass(
        ISSUE,
        {
          config: makeConfig(),
          cwd: "/tmp/repo",
          baseBranch: "main",
          github: makeGithub(),
          isMerged,
          subscriptions: [QUIET],
          pollIntervalSeconds: 0,
          maxIterations: 3,
        },
        "agent/va-460",
        PR_URL,
      ),
    );

    expect(outcome).toEqual({ kind: "merged" });
    expect(isMerged).toHaveBeenCalledTimes(2);
  });

  it("returns { kind: 'ready' } after the iteration cap when subscriptions stay quiet", async () => {
    const isMerged = vi.fn().mockReturnValue(Effect.succeed(false));

    const outcome = await Effect.runPromise(
      runShepherdPass(
        ISSUE,
        {
          config: makeConfig(),
          cwd: "/tmp/repo",
          baseBranch: "main",
          github: makeGithub(),
          isMerged,
          subscriptions: [QUIET, QUIET, QUIET],
          pollIntervalSeconds: 0,
          maxIterations: 3,
        },
        "agent/va-460",
        PR_URL,
      ),
    );

    expect(outcome.kind).toBe("ready");
    if (outcome.kind === "ready") {
      expect(outcome.reason).toMatch(/3 polls/);
    }
    expect(isMerged).toHaveBeenCalledTimes(3);
  });

  it("returns { kind: 'hitl' } and exits immediately when any subscription emits hitl", async () => {
    const isMerged = vi.fn().mockReturnValue(Effect.succeed(false));
    const trippingSub = hitlSub("Reviewer flagged NEEDS-DISCUSSION");
    const trippingSubSpy = vi.fn(trippingSub);
    const lateSub = vi.fn(QUIET);

    const outcome = await Effect.runPromise(
      runShepherdPass(
        ISSUE,
        {
          config: makeConfig(),
          cwd: "/tmp/repo",
          baseBranch: "main",
          github: makeGithub(),
          isMerged,
          subscriptions: [trippingSubSpy, lateSub],
          pollIntervalSeconds: 0,
          maxIterations: 3,
        },
        "agent/va-460",
        PR_URL,
      ),
    );

    expect(outcome).toEqual({
      kind: "hitl",
      reason: "Reviewer flagged NEEDS-DISCUSSION",
    });
    // Only one merge check + one subscription poll before exit.
    expect(isMerged).toHaveBeenCalledTimes(1);
    expect(trippingSubSpy).toHaveBeenCalledTimes(1);
    // Late subscription never polled because the tripping one short-circuited.
    expect(lateSub).not.toHaveBeenCalled();
  });

  it("defaults: empty subscriptions + no-op merge check exits ready after maxIterations", async () => {
    const outcome = await Effect.runPromise(
      runShepherdPass(
        ISSUE,
        {
          config: makeConfig(),
          cwd: "/tmp/repo",
          baseBranch: "main",
          github: makeGithub(),
          pollIntervalSeconds: 0,
          maxIterations: 2,
        },
        "agent/va-460",
        PR_URL,
      ),
    );

    expect(outcome.kind).toBe("ready");
  });
});
