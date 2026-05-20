import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import type { GithubGateway, PullRequestState } from "./github.js";
import type { RunwayIssue } from "./linear.js";

// VA-461: mock the sandcastle SDK so the integration test below can
// drive `runShepherdPass` through the production `defaultInvokeRebaseAgent`
// path without booting Docker. Hoisted by vitest. Tests that don't
// exercise this path (the watcher unit tests further down) inject
// their own `invokeRebaseAgent` stub and never reach the mock.
const sandcastleRunMock = vi.fn();
vi.mock("@ai-hero/sandcastle", () => ({
  run: sandcastleRunMock,
  claudeCode: vi.fn(() => ({ kind: "claudeCode" })),
}));
vi.mock("@ai-hero/sandcastle/sandboxes/docker", () => ({
  docker: vi.fn(() => ({ kind: "docker" })),
}));

const {
  makeIsMerged,
  makeMergeabilityWatcher,
  parsePrNumber,
  parseRebaseVerdict,
  runShepherdPass,
} = await import("./shepherd.js");
type Subscription = Parameters<typeof runShepherdPass>[1] extends {
  subscriptions?: ReadonlyArray<infer S>;
}
  ? S
  : never;

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

function makeGithub(
  overrides: Partial<GithubGateway> = {},
): GithubGateway {
  return {
    pushBranch: vi.fn(),
    openPullRequest: vi.fn(),
    getPullRequest: vi.fn(),
    getConflictFiles: vi.fn(),
    ...overrides,
  } as unknown as GithubGateway;
}

function makePr(over: Partial<PullRequestState> = {}): PullRequestState {
  return {
    number: 123,
    mergeableState: "clean",
    merged: false,
    headSha: "abc1234",
    headRefName: "agent/va-460",
    baseRefName: "main",
    ...over,
  };
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

// ---------------------------------------------------------------------------
// VA-461 — mergeability watcher
// ---------------------------------------------------------------------------

describe("makeIsMerged (VA-461)", () => {
  it("returns true when getPullRequest reports merged", async () => {
    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(Effect.succeed(makePr({ merged: true }))),
    });
    const isMerged = makeIsMerged(github);
    const result = await Effect.runPromise(
      isMerged({
        issue: ISSUE,
        branch: "agent/va-461",
        prUrl: PR_URL,
        prNumber: 123,
        cwd: "/tmp/repo",
        baseBranch: "main",
        config: makeConfig(),
        github,
        iteration: 1,
      }),
    );
    expect(result).toBe(true);
  });

  it("returns false when the PR is still open", async () => {
    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(Effect.succeed(makePr({ merged: false }))),
    });
    const isMerged = makeIsMerged(github);
    const result = await Effect.runPromise(
      isMerged({
        issue: ISSUE,
        branch: "agent/va-461",
        prUrl: PR_URL,
        prNumber: 123,
        cwd: "/tmp/repo",
        baseBranch: "main",
        config: makeConfig(),
        github,
        iteration: 1,
      }),
    );
    expect(result).toBe(false);
  });
});

describe("parseRebaseVerdict (VA-461)", () => {
  it("recognises IMPL: DONE", () => {
    expect(parseRebaseVerdict("...stuff...\nIMPL: DONE")).toEqual({
      kind: "done",
    });
  });

  it("recognises IMPL: BLOCKED + extracts conflict files from the canonical reason", () => {
    const result = parseRebaseVerdict(
      "IMPL: BLOCKED — Mergeability: conflict in src/a.ts, src/b.ts required human resolution",
    );
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.conflictFiles).toEqual(["src/a.ts", "src/b.ts"]);
      expect(result.reason).toMatch(/Mergeability/);
    }
  });

  it("blocks when no IMPL marker is present (defensive default)", () => {
    expect(parseRebaseVerdict("rambling agent output").kind).toBe("blocked");
  });
});

describe("makeMergeabilityWatcher (VA-461)", () => {
  const ctx = {
    issue: ISSUE,
    branch: "agent/va-461",
    prUrl: PR_URL,
    prNumber: 123,
    cwd: "/tmp/repo",
    baseBranch: "main",
    config: makeConfig(),
    iteration: 1,
  };

  it("returns quiet when mergeable_state is clean", async () => {
    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(Effect.succeed(makePr({ mergeableState: "clean" }))),
    });
    const watcher = makeMergeabilityWatcher({
      github,
      config: makeConfig(),
    });
    const signal = await Effect.runPromise(
      watcher({ ...ctx, github }),
    );
    expect(signal.kind).toBe("quiet");
  });

  it("returns quiet on unknown (GH still computing)", async () => {
    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(Effect.succeed(makePr({ mergeableState: "unknown" }))),
    });
    const watcher = makeMergeabilityWatcher({
      github,
      config: makeConfig(),
    });
    const signal = await Effect.runPromise(
      watcher({ ...ctx, github }),
    );
    expect(signal.kind).toBe("quiet");
  });

  it("returns fix on dirty; action invokes rebase agent against the impl branch and returns fixed on DONE", async () => {
    const invokeRebaseAgent = vi
      .fn()
      .mockReturnValue(Effect.succeed({ kind: "done" as const }));
    const getConflictFiles = vi
      .fn()
      .mockReturnValue(Effect.succeed(["src/a.ts", "src/b.ts"]));
    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(Effect.succeed(makePr({ mergeableState: "dirty" }))),
      getConflictFiles,
    });
    const watcher = makeMergeabilityWatcher({
      github,
      config: makeConfig(),
      invokeRebaseAgent,
    });
    const signal = await Effect.runPromise(
      watcher({ ...ctx, github }),
    );
    expect(signal.kind).toBe("fix");
    if (signal.kind !== "fix") return;
    expect(signal.description).toMatch(/Rebase agent\/va-461 onto origin\/main/);

    const outcome = await Effect.runPromise(signal.action);
    expect(outcome).toEqual({
      kind: "fixed",
      detail: "Rebased agent/va-461 onto origin/main",
    });
    expect(invokeRebaseAgent).toHaveBeenCalledOnce();
    expect(invokeRebaseAgent.mock.calls[0]![0]).toMatchObject({
      branch: "agent/va-461",
      baseBranch: "main",
      mergeableState: "dirty",
      conflictFiles: ["src/a.ts", "src/b.ts"],
    });
  });

  it("returns fix on behind; pre-detected conflict files may be empty (clean fast-forward)", async () => {
    const invokeRebaseAgent = vi
      .fn()
      .mockReturnValue(Effect.succeed({ kind: "done" as const }));
    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(Effect.succeed(makePr({ mergeableState: "behind" }))),
      getConflictFiles: vi.fn().mockReturnValue(Effect.succeed([])),
    });
    const watcher = makeMergeabilityWatcher({
      github,
      config: makeConfig(),
      invokeRebaseAgent,
    });
    const signal = await Effect.runPromise(
      watcher({ ...ctx, github }),
    );
    expect(signal.kind).toBe("fix");
    if (signal.kind !== "fix") return;
    expect(signal.description).toMatch(/mergeable_state=behind/);
    const outcome = await Effect.runPromise(signal.action);
    expect(outcome.kind).toBe("fixed");
  });

  it("routes to hitl when the rebase agent returns BLOCKED, with the conflicted files in the reason", async () => {
    const invokeRebaseAgent = vi.fn().mockReturnValue(
      Effect.succeed({
        kind: "blocked" as const,
        reason: "Mergeability: conflict in src/orchestrator.ts required human resolution",
        conflictFiles: ["src/orchestrator.ts"],
      }),
    );
    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(Effect.succeed(makePr({ mergeableState: "dirty" }))),
      getConflictFiles: vi
        .fn()
        .mockReturnValue(Effect.succeed(["src/orchestrator.ts"])),
    });
    const watcher = makeMergeabilityWatcher({
      github,
      config: makeConfig(),
      invokeRebaseAgent,
    });
    const signal = await Effect.runPromise(
      watcher({ ...ctx, github }),
    );
    expect(signal.kind).toBe("fix");
    if (signal.kind !== "fix") return;
    const outcome = await Effect.runPromise(signal.action);
    expect(outcome).toEqual({
      kind: "hitl",
      reason: "Mergeability: conflict in src/orchestrator.ts required human resolution",
    });
  });

  it("returns quiet when the PR has already merged (defensive)", async () => {
    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(Effect.succeed(makePr({ merged: true }))),
    });
    const watcher = makeMergeabilityWatcher({
      github,
      config: makeConfig(),
    });
    const signal = await Effect.runPromise(
      watcher({ ...ctx, github }),
    );
    expect(signal.kind).toBe("quiet");
  });
});

// VA-461 AC: the rendered prompt must instruct `--force-with-lease`,
// never bare `--force`. The prompt is read from disk, so this lives
// as a snapshot-shape test in src/prompts.test.ts — see
// "renderShepherdRebasePrompt" cases there.

// ---------------------------------------------------------------------------
// VA-461 integration: full runShepherdPass loop drives sandcastle with
// the right branchStrategy + prompt content
// ---------------------------------------------------------------------------

describe("runShepherdPass — VA-461 integration", () => {
  it("on dirty: drives sandcastle with branchStrategy={type:branch,branch} and a force-with-lease prompt", async () => {
    sandcastleRunMock.mockReset();
    sandcastleRunMock.mockResolvedValueOnce({ stdout: "IMPL: DONE" });

    // Iteration 1 calls getPullRequest twice (isMerged check, then
    // watcher poll); iteration 2's isMerged sees the merged state and
    // exits the loop. Two mockReturnValueOnce for iteration 1, then
    // mockReturnValue for all subsequent ticks.
    const dirtyPr = makePr({ mergeableState: "dirty", merged: false });
    const getPullRequest = vi
      .fn()
      .mockReturnValueOnce(Effect.succeed(dirtyPr))
      .mockReturnValueOnce(Effect.succeed(dirtyPr))
      .mockReturnValue(Effect.succeed(makePr({ merged: true })));
    const getConflictFiles = vi
      .fn()
      .mockReturnValue(Effect.succeed(["src/foo.ts", "src/bar.ts"]));
    const github = makeGithub({ getPullRequest, getConflictFiles });

    const outcome = await Effect.runPromise(
      runShepherdPass(
        ISSUE,
        {
          config: makeConfig(),
          cwd: "/tmp/repo",
          baseBranch: "main",
          github,
          isMerged: makeIsMerged(github),
          // Production wiring — no invokeRebaseAgent override, so the
          // fix action calls defaultInvokeRebaseAgent → runSandcastle
          // → the mocked `run` above.
          subscriptions: [
            makeMergeabilityWatcher({ github, config: makeConfig() }),
          ],
          pollIntervalSeconds: 0,
          maxIterations: 3,
        },
        "agent/va-460",
        PR_URL,
      ),
    );

    expect(outcome.kind).toBe("merged");
    expect(sandcastleRunMock).toHaveBeenCalledOnce();
    const args = sandcastleRunMock.mock.calls[0]![0];
    // Linear AC: branchStrategy is { type: "branch", branch }, NEVER
    // { type: "head" } (VA-456's regression contract).
    expect(args.branchStrategy).toEqual({
      type: "branch",
      branch: "agent/va-460",
    });
    expect(args.maxIterations).toBe(1);
    expect(args.name).toMatch(/shepherd-rebase-VA-460/);
    // The prompt instructs --force-with-lease and lists the pre-detected
    // conflict files. Bare --force MUST NOT appear (regression guard
    // — the prompt-level test in prompts.test.ts also pins this).
    expect(args.prompt).toMatch(/--force-with-lease/);
    expect(args.prompt).not.toMatch(/--force(?!\b|-)/);
    expect(args.prompt).toContain("src/foo.ts");
    expect(args.prompt).toContain("src/bar.ts");
    expect(args.prompt).toContain("origin/main");
    expect(args.prompt).toContain("`dirty`");
  });

  it("on dirty + agent BLOCKED: loop routes to hitl with the canonical mergeability reason", async () => {
    sandcastleRunMock.mockReset();
    sandcastleRunMock.mockResolvedValueOnce({
      stdout:
        "IMPL: BLOCKED — Mergeability: conflict in src/orchestrator.ts required human resolution",
    });

    const getPullRequest = vi
      .fn()
      .mockReturnValue(
        Effect.succeed(makePr({ mergeableState: "dirty", merged: false })),
      );
    const getConflictFiles = vi
      .fn()
      .mockReturnValue(Effect.succeed(["src/orchestrator.ts"]));
    const github = makeGithub({ getPullRequest, getConflictFiles });

    const outcome = await Effect.runPromise(
      runShepherdPass(
        ISSUE,
        {
          config: makeConfig(),
          cwd: "/tmp/repo",
          baseBranch: "main",
          github,
          isMerged: makeIsMerged(github),
          subscriptions: [
            makeMergeabilityWatcher({ github, config: makeConfig() }),
          ],
          pollIntervalSeconds: 0,
          maxIterations: 3,
        },
        "agent/va-460",
        PR_URL,
      ),
    );

    expect(outcome).toEqual({
      kind: "hitl",
      reason:
        "Mergeability: conflict in src/orchestrator.ts required human resolution",
    });
  });
});
