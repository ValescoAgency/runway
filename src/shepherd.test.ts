import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import type {
  CheckRun,
  GithubGateway,
  PrComment,
  PullRequestState,
} from "./github.js";
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
  makeCiWatcher,
  makeIsMerged,
  makeMergeabilityWatcher,
  makeReviewerWatcher,
  parseCiFixVerdict,
  parsePrNumber,
  parsePrReviewVerdict,
  parseRebaseVerdict,
  parseReviewerResponseVerdict,
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
          maxQuietPolls: 3,
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
          maxQuietPolls: 3,
        },
        "agent/va-460",
        PR_URL,
      ),
    );

    expect(outcome.kind).toBe("ready");
    if (outcome.kind === "ready") {
      expect(outcome.reason).toMatch(/3 consecutive polls/);
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
          maxQuietPolls: 3,
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
          maxQuietPolls: 2,
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

// VA-477: `makeMergeabilityWatcher` unit tests relocated to
// `src/planner-mergeability.test.ts` along with the watcher body
// itself. shepherd.ts keeps a re-export for the orchestrator's
// inline-shepherd wiring, but the canonical home is now planner-side.

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
          maxQuietPolls: 3,
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
          maxQuietPolls: 3,
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

// ---------------------------------------------------------------------------
// VA-462 — CI failure watcher
// ---------------------------------------------------------------------------

function makeCheckRun(over: Partial<CheckRun> = {}): CheckRun {
  return {
    id: 1,
    name: "test",
    status: "completed",
    conclusion: "failure",
    runId: 1001,
    ...over,
  };
}

describe("parseCiFixVerdict (VA-462)", () => {
  it("recognises IMPL: DONE", () => {
    expect(parseCiFixVerdict("IMPL: DONE")).toEqual({ kind: "done" });
  });
  it("recognises IMPL: BLOCKED and surfaces the reason", () => {
    const r = parseCiFixVerdict("IMPL: BLOCKED — test isolation broken");
    expect(r.kind).toBe("blocked");
    if (r.kind === "blocked") expect(r.reason).toMatch(/test isolation/);
  });
  it("blocks when no marker fires (defensive default)", () => {
    expect(parseCiFixVerdict("rambling output").kind).toBe("blocked");
  });
});

describe("makeCiWatcher (VA-462)", () => {
  const ctx = {
    issue: ISSUE,
    branch: "agent/va-462",
    prUrl: PR_URL,
    prNumber: 123,
    cwd: "/tmp/repo",
    baseBranch: "main",
    config: makeConfig(),
    iteration: 1,
  };

  it("(a) one required check fails → fix signal; re-impl prompt receives the log tail and the check name", async () => {
    const invokeCiFixAgent = vi
      .fn()
      .mockReturnValue(Effect.succeed({ kind: "done" as const }));
    const logTail = "FAIL test/foo.test.ts\nExpected 1 to equal 2";
    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(Effect.succeed(makePr({ merged: false }))),
      getCheckRuns: vi
        .fn()
        .mockReturnValue(
          Effect.succeed([makeCheckRun({ name: "pnpm test", runId: 42 })]),
        ),
      // Branch protection lists `pnpm test` as required; the watcher
      // should fire because the failing check name matches.
      getRequiredChecks: vi
        .fn()
        .mockReturnValue(Effect.succeed(["pnpm test", "pnpm typecheck"])),
      getCheckRunLogTail: vi.fn().mockReturnValue(Effect.succeed(logTail)),
    });
    const watcher = makeCiWatcher({ github, config: makeConfig(), invokeCiFixAgent });
    const signal = await Effect.runPromise(watcher({ ...ctx, github }));
    expect(signal.kind).toBe("fix");
    if (signal.kind !== "fix") return;
    expect(signal.description).toMatch(/`pnpm test`/);

    const outcome = await Effect.runPromise(signal.action);
    expect(outcome.kind).toBe("fixed");
    expect(invokeCiFixAgent).toHaveBeenCalledOnce();
    expect(invokeCiFixAgent.mock.calls[0]![0]).toMatchObject({
      branch: "agent/va-462",
      checkName: "pnpm test",
      logTail,
    });
  });

  it("(b) optional check fails → no action, no budget cost (quiet)", async () => {
    const invokeCiFixAgent = vi.fn();
    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(Effect.succeed(makePr({ merged: false }))),
      getCheckRuns: vi
        .fn()
        .mockReturnValue(
          Effect.succeed([makeCheckRun({ name: "optional-lint" })]),
        ),
      // Required list does NOT include `optional-lint`.
      getRequiredChecks: vi
        .fn()
        .mockReturnValue(Effect.succeed(["pnpm test"])),
      getCheckRunLogTail: vi.fn(),
    });
    const watcher = makeCiWatcher({ github, config: makeConfig(), invokeCiFixAgent });
    const signal = await Effect.runPromise(watcher({ ...ctx, github }));
    expect(signal.kind).toBe("quiet");
    expect(invokeCiFixAgent).not.toHaveBeenCalled();
  });

  it("(c) same required check fails 3× consecutively (across SHAs) → hitl with canonical reason", async () => {
    const invokeCiFixAgent = vi
      .fn()
      .mockReturnValue(Effect.succeed({ kind: "done" as const }));
    // Each tick advances the head SHA but the check name + log tail
    // stay identical (same errorHash). The watcher should fire `fix`
    // for ticks 1 and 2, then escalate to `hitl` on tick 3.
    const logTail = "AssertionError: expected foo to equal bar\n  at line 42";
    const getPullRequest = vi
      .fn()
      .mockReturnValueOnce(
        Effect.succeed(makePr({ headSha: "sha1", merged: false })),
      )
      .mockReturnValueOnce(
        Effect.succeed(makePr({ headSha: "sha2", merged: false })),
      )
      .mockReturnValueOnce(
        Effect.succeed(makePr({ headSha: "sha3", merged: false })),
      );
    const github = makeGithub({
      getPullRequest,
      getCheckRuns: vi.fn().mockReturnValue(
        Effect.succeed([makeCheckRun({ name: "pnpm test", runId: 99 })]),
      ),
      getRequiredChecks: vi
        .fn()
        .mockReturnValue(Effect.succeed(["pnpm test"])),
      getCheckRunLogTail: vi.fn().mockReturnValue(Effect.succeed(logTail)),
    });
    const watcher = makeCiWatcher({ github, config: makeConfig(), invokeCiFixAgent });

    // Tick 1: fresh window → fix.
    const t1 = await Effect.runPromise(watcher({ ...ctx, github }));
    expect(t1.kind).toBe("fix");
    // Tick 2: same error, new SHA → count=2 → still fix.
    const t2 = await Effect.runPromise(
      watcher({ ...ctx, github, iteration: 2 }),
    );
    expect(t2.kind).toBe("fix");
    // Tick 3: same error, new SHA → count=3 (== maxConsecutive) → hitl.
    const t3 = await Effect.runPromise(
      watcher({ ...ctx, github, iteration: 3 }),
    );
    expect(t3.kind).toBe("hitl");
    if (t3.kind !== "hitl") return;
    expect(t3.reason).toBe(
      "Repeated CI failure in `pnpm test`: at line 42",
    );
  });

  it("identical failure on the same SHA (no new commit) → quiet (don't re-fire stale)", async () => {
    const invokeCiFixAgent = vi
      .fn()
      .mockReturnValue(Effect.succeed({ kind: "done" as const }));
    const logTail = "FAIL same-error";
    const github = makeGithub({
      // Same SHA on both ticks — the agent's force-push didn't land
      // a new commit, or CI is still on the old commit.
      getPullRequest: vi
        .fn()
        .mockReturnValue(
          Effect.succeed(makePr({ headSha: "stuck-sha", merged: false })),
        ),
      getCheckRuns: vi
        .fn()
        .mockReturnValue(Effect.succeed([makeCheckRun({ name: "test" })])),
      getRequiredChecks: vi.fn().mockReturnValue(Effect.succeed(["test"])),
      getCheckRunLogTail: vi.fn().mockReturnValue(Effect.succeed(logTail)),
    });
    const watcher = makeCiWatcher({ github, config: makeConfig(), invokeCiFixAgent });

    // Tick 1: fresh window → fix.
    const t1 = await Effect.runPromise(watcher({ ...ctx, github }));
    expect(t1.kind).toBe("fix");
    // Tick 2: same error, same SHA → quiet (already acted).
    const t2 = await Effect.runPromise(
      watcher({ ...ctx, github, iteration: 2 }),
    );
    expect(t2.kind).toBe("quiet");
  });

  it("no failing checks → quiet (the happy path)", async () => {
    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(Effect.succeed(makePr({ merged: false }))),
      getCheckRuns: vi
        .fn()
        .mockReturnValue(
          Effect.succeed([
            makeCheckRun({ name: "test", conclusion: "success" }),
          ]),
        ),
      getRequiredChecks: vi.fn().mockReturnValue(Effect.succeed(["test"])),
      getCheckRunLogTail: vi.fn(),
    });
    const watcher = makeCiWatcher({ github, config: makeConfig() });
    const signal = await Effect.runPromise(watcher({ ...ctx, github }));
    expect(signal.kind).toBe("quiet");
  });

  it("null required-checks (branch protection inaccessible) → conservatively treats all as required", async () => {
    const invokeCiFixAgent = vi
      .fn()
      .mockReturnValue(Effect.succeed({ kind: "done" as const }));
    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(Effect.succeed(makePr({ merged: false }))),
      getCheckRuns: vi
        .fn()
        .mockReturnValue(
          Effect.succeed([makeCheckRun({ name: "weird-custom-check" })]),
        ),
      getRequiredChecks: vi.fn().mockReturnValue(Effect.succeed(null)),
      getCheckRunLogTail: vi.fn().mockReturnValue(Effect.succeed("err")),
    });
    const watcher = makeCiWatcher({ github, config: makeConfig(), invokeCiFixAgent });
    const signal = await Effect.runPromise(watcher({ ...ctx, github }));
    expect(signal.kind).toBe("fix");
  });

  it("CI fix agent returns BLOCKED → hitl with check name in reason", async () => {
    const invokeCiFixAgent = vi.fn().mockReturnValue(
      Effect.succeed({
        kind: "blocked" as const,
        reason: "test failure exposes a real spec ambiguity",
      }),
    );
    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(Effect.succeed(makePr({ merged: false }))),
      getCheckRuns: vi
        .fn()
        .mockReturnValue(
          Effect.succeed([makeCheckRun({ name: "pnpm test" })]),
        ),
      getRequiredChecks: vi.fn().mockReturnValue(Effect.succeed(["pnpm test"])),
      getCheckRunLogTail: vi.fn().mockReturnValue(Effect.succeed("FAIL")),
    });
    const watcher = makeCiWatcher({ github, config: makeConfig(), invokeCiFixAgent });
    const signal = await Effect.runPromise(watcher({ ...ctx, github }));
    expect(signal.kind).toBe("fix");
    if (signal.kind !== "fix") return;
    const outcome = await Effect.runPromise(signal.action);
    expect(outcome).toEqual({
      kind: "hitl",
      reason:
        "CI fix BLOCKED in `pnpm test`: test failure exposes a real spec ambiguity",
    });
  });
});

// ---------------------------------------------------------------------------
// VA-463 — reviewer-comment responder
// ---------------------------------------------------------------------------

function makeComment(over: Partial<PrComment> = {}): PrComment {
  return {
    id: 1,
    authorLogin: "human-reviewer",
    body: "looks good to me",
    createdAtUnixSeconds: 1_715_000_000,
    source: "issue",
    ...over,
  };
}

describe("parsePrReviewVerdict (VA-463)", () => {
  it("recognises REVIEW: APPROVED", () => {
    expect(parsePrReviewVerdict("REVIEW: APPROVED")).toEqual({
      kind: "approved",
    });
  });
  it("recognises REVIEW: CHANGES-REQUESTED — <fix> and captures the fix verbatim", () => {
    const r = parsePrReviewVerdict(
      "Some preamble\n\nREVIEW: CHANGES-REQUESTED — add a guard before the regex",
    );
    expect(r).toEqual({
      kind: "changes-requested",
      fix: "add a guard before the regex",
    });
  });
  it("recognises REVIEW: NEEDS-DISCUSSION — <decision>", () => {
    const r = parsePrReviewVerdict(
      "REVIEW: NEEDS-DISCUSSION — should we keep back-compat for the v0 API?",
    );
    expect(r).toEqual({
      kind: "needs-discussion",
      decision: "should we keep back-compat for the v0 API?",
    });
  });
  it("returns { kind: none } when no REVIEW: line appears", () => {
    expect(parsePrReviewVerdict("just a status update")).toEqual({
      kind: "none",
    });
  });
  it("picks the LAST verdict when multiple are present", () => {
    const r = parsePrReviewVerdict(
      "REVIEW: CHANGES-REQUESTED — old\nlater\nREVIEW: APPROVED",
    );
    expect(r).toEqual({ kind: "approved" });
  });
});

describe("parseReviewerResponseVerdict (VA-463)", () => {
  it("recognises IMPL: DONE", () => {
    expect(parseReviewerResponseVerdict("IMPL: DONE")).toEqual({
      kind: "done",
    });
  });
  it("recognises IMPL: BLOCKED with the reason", () => {
    const r = parseReviewerResponseVerdict(
      "IMPL: BLOCKED — request conflicts with the Linear issue scope",
    );
    expect(r.kind).toBe("blocked");
    if (r.kind === "blocked") expect(r.reason).toMatch(/conflicts with/);
  });
  it("blocks when no marker fires", () => {
    expect(parseReviewerResponseVerdict("waffle").kind).toBe("blocked");
  });
});

describe("makeReviewerWatcher (VA-463)", () => {
  const ctx = {
    issue: ISSUE,
    branch: "agent/va-463",
    prUrl: PR_URL,
    prNumber: 123,
    cwd: "/tmp/repo",
    baseBranch: "main",
    config: { ...makeConfig(), prReviewerBotLogin: "runway-reviewer-bot" } as Config,
    iteration: 1,
  };

  function makeGithubWithComments(
    comments: readonly PrComment[],
  ): GithubGateway {
    return makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(Effect.succeed(makePr({ merged: false }))),
      getPullRequestComments: vi.fn().mockReturnValue(Effect.succeed(comments)),
    });
  }

  it("initial-snapshot priming: first poll records existing comments as already-seen and returns quiet", async () => {
    const pre = [
      makeComment({ id: 100, body: "REVIEW: APPROVED", authorLogin: "runway-reviewer-bot" }),
      makeComment({ id: 101, body: "LGTM", authorLogin: "human" }),
    ];
    const invokeReviewerResponseAgent = vi.fn();
    const github = makeGithubWithComments(pre);
    const watcher = makeReviewerWatcher({
      github,
      config: ctx.config,
      invokeReviewerResponseAgent,
    });
    const t1 = await Effect.runPromise(watcher({ ...ctx, github }));
    expect(t1.kind).toBe("quiet");
    expect(invokeReviewerResponseAgent).not.toHaveBeenCalled();
  });

  it("(adversarial, changes-requested): new CHANGES-REQUESTED comment → fix-request prompt", async () => {
    const initialComments = [makeComment({ id: 1, body: "earlier" })];
    let comments: readonly PrComment[] = initialComments;
    const getPullRequestComments = vi.fn(() => Effect.succeed(comments));
    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(Effect.succeed(makePr({ merged: false }))),
      getPullRequestComments,
    });
    const invokeReviewerResponseAgent = vi
      .fn()
      .mockReturnValue(Effect.succeed({ kind: "done" as const }));
    const watcher = makeReviewerWatcher({
      github,
      config: ctx.config,
      invokeReviewerResponseAgent,
    });
    // Tick 1 primes.
    await Effect.runPromise(watcher({ ...ctx, github }));
    // Now a new bot CHANGES-REQUESTED comment lands.
    comments = [
      ...initialComments,
      makeComment({
        id: 2,
        authorLogin: "runway-reviewer-bot",
        body: "Preamble paragraph.\n\nREVIEW: CHANGES-REQUESTED — add a URL scheme guard",
        createdAtUnixSeconds: 1_715_000_100,
      }),
    ];
    const t2 = await Effect.runPromise(
      watcher({ ...ctx, github, iteration: 2 }),
    );
    expect(t2.kind).toBe("fix");
    if (t2.kind !== "fix") return;
    expect(t2.description).toMatch(/CHANGES-REQUESTED/);
    const outcome = await Effect.runPromise(t2.action);
    expect(outcome.kind).toBe("fixed");
    expect(invokeReviewerResponseAgent).toHaveBeenCalledOnce();
    expect(invokeReviewerResponseAgent.mock.calls[0]![0]).toMatchObject({
      branch: "agent/va-463",
      mode: { kind: "fix-request", fix: "add a URL scheme guard" },
    });
  });

  it("(adversarial, needs-discussion): immediate hitl with canonical reason", async () => {
    let comments: readonly PrComment[] = [];
    const getPullRequestComments = vi.fn(() => Effect.succeed(comments));
    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(Effect.succeed(makePr({ merged: false }))),
      getPullRequestComments,
    });
    const invokeReviewerResponseAgent = vi.fn();
    const watcher = makeReviewerWatcher({
      github,
      config: ctx.config,
      invokeReviewerResponseAgent,
    });
    await Effect.runPromise(watcher({ ...ctx, github }));
    comments = [
      makeComment({
        id: 10,
        authorLogin: "runway-reviewer-bot",
        body: "REVIEW: NEEDS-DISCUSSION — should we keep back-compat for v0 callers?",
      }),
    ];
    const t = await Effect.runPromise(
      watcher({ ...ctx, github, iteration: 2 }),
    );
    expect(t).toEqual({
      kind: "hitl",
      reason:
        "Reviewer flagged needs-discussion: should we keep back-compat for v0 callers?",
    });
    expect(invokeReviewerResponseAgent).not.toHaveBeenCalled();
  });

  it("(adversarial, approved): quiet (loop continues watching CI/merge)", async () => {
    let comments: readonly PrComment[] = [];
    const getPullRequestComments = vi.fn(() => Effect.succeed(comments));
    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(Effect.succeed(makePr({ merged: false }))),
      getPullRequestComments,
    });
    const watcher = makeReviewerWatcher({
      github,
      config: ctx.config,
    });
    await Effect.runPromise(watcher({ ...ctx, github }));
    comments = [
      makeComment({
        id: 20,
        authorLogin: "runway-reviewer-bot",
        body: "Nicely done. REVIEW: APPROVED",
      }),
    ];
    const t = await Effect.runPromise(
      watcher({ ...ctx, github, iteration: 2 }),
    );
    expect(t.kind).toBe("quiet");
  });

  it("(human, actionable): passes body verbatim to the respond prompt; agent IMPL: DONE → fixed", async () => {
    let comments: readonly PrComment[] = [];
    const getPullRequestComments = vi.fn(() => Effect.succeed(comments));
    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(Effect.succeed(makePr({ merged: false }))),
      getPullRequestComments,
    });
    const invokeReviewerResponseAgent = vi
      .fn()
      .mockReturnValue(Effect.succeed({ kind: "done" as const }));
    const watcher = makeReviewerWatcher({
      github,
      config: ctx.config,
      invokeReviewerResponseAgent,
    });
    await Effect.runPromise(watcher({ ...ctx, github }));
    comments = [
      makeComment({
        id: 30,
        authorLogin: "human-reviewer",
        body: "please rename `foo` to `bar` throughout the diff",
        source: "review",
      }),
    ];
    const t = await Effect.runPromise(
      watcher({ ...ctx, github, iteration: 2 }),
    );
    expect(t.kind).toBe("fix");
    if (t.kind !== "fix") return;
    const outcome = await Effect.runPromise(t.action);
    expect(outcome.kind).toBe("fixed");
    expect(invokeReviewerResponseAgent).toHaveBeenCalledOnce();
    expect(invokeReviewerResponseAgent.mock.calls[0]![0]).toMatchObject({
      mode: {
        kind: "verbatim",
        commentAuthor: "human-reviewer",
        commentSource: "review",
        commentBody: "please rename `foo` to `bar` throughout the diff",
      },
    });
  });

  it("(human, non-actionable): agent IMPL: DONE with no commit → fixed (no-op path)", async () => {
    // AC: "LGTM, looks good" passed verbatim; agent recognises it as
    // non-actionable and returns IMPL: DONE without pushing. The
    // watcher does not distinguish — IMPL: DONE is fixed regardless
    // of whether the agent committed. The agent prompt forbids
    // fabricating changes for non-actionable comments.
    let comments: readonly PrComment[] = [];
    const getPullRequestComments = vi.fn(() => Effect.succeed(comments));
    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(Effect.succeed(makePr({ merged: false }))),
      getPullRequestComments,
    });
    const invokeReviewerResponseAgent = vi
      .fn()
      .mockReturnValue(Effect.succeed({ kind: "done" as const }));
    const watcher = makeReviewerWatcher({
      github,
      config: ctx.config,
      invokeReviewerResponseAgent,
    });
    await Effect.runPromise(watcher({ ...ctx, github }));
    comments = [
      makeComment({ id: 40, authorLogin: "human", body: "LGTM, looks good" }),
    ];
    const t = await Effect.runPromise(
      watcher({ ...ctx, github, iteration: 2 }),
    );
    expect(t.kind).toBe("fix");
    if (t.kind !== "fix") return;
    const outcome = await Effect.runPromise(t.action);
    expect(outcome.kind).toBe("fixed");
  });

  it("(human, blocked): agent IMPL: BLOCKED → hitl with author name + reason", async () => {
    let comments: readonly PrComment[] = [];
    const getPullRequestComments = vi.fn(() => Effect.succeed(comments));
    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(Effect.succeed(makePr({ merged: false }))),
      getPullRequestComments,
    });
    const invokeReviewerResponseAgent = vi.fn().mockReturnValue(
      Effect.succeed({
        kind: "blocked" as const,
        reason: "comment is ambiguous; needs a product decision",
      }),
    );
    const watcher = makeReviewerWatcher({
      github,
      config: ctx.config,
      invokeReviewerResponseAgent,
    });
    await Effect.runPromise(watcher({ ...ctx, github }));
    comments = [
      makeComment({
        id: 50,
        authorLogin: "pm-jane",
        body: "should this also handle the v0 callers?",
      }),
    ];
    const t = await Effect.runPromise(
      watcher({ ...ctx, github, iteration: 2 }),
    );
    expect(t.kind).toBe("fix");
    if (t.kind !== "fix") return;
    const outcome = await Effect.runPromise(t.action);
    expect(outcome).toEqual({
      kind: "hitl",
      reason:
        "Reviewer comment BLOCKED (pm-jane): comment is ambiguous; needs a product decision",
    });
  });

  it("dedup: a comment already responded to is not re-fired on the next poll", async () => {
    let comments: readonly PrComment[] = [];
    const getPullRequestComments = vi.fn(() => Effect.succeed(comments));
    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(Effect.succeed(makePr({ merged: false }))),
      getPullRequestComments,
    });
    const invokeReviewerResponseAgent = vi
      .fn()
      .mockReturnValue(Effect.succeed({ kind: "done" as const }));
    const watcher = makeReviewerWatcher({
      github,
      config: ctx.config,
      invokeReviewerResponseAgent,
    });
    await Effect.runPromise(watcher({ ...ctx, github }));
    comments = [makeComment({ id: 99, authorLogin: "human", body: "fix typo" })];
    const t2 = await Effect.runPromise(
      watcher({ ...ctx, github, iteration: 2 }),
    );
    expect(t2.kind).toBe("fix");
    if (t2.kind === "fix") await Effect.runPromise(t2.action);
    // Same comments list on tick 3 — already responded.
    const t3 = await Effect.runPromise(
      watcher({ ...ctx, github, iteration: 3 }),
    );
    expect(t3.kind).toBe("quiet");
    expect(invokeReviewerResponseAgent).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// VA-464 — budget knobs (maxFixAttempts + maxWallSeconds)
// ---------------------------------------------------------------------------

describe("runShepherdPass — VA-464 budget knobs", () => {
  function makeFixSub(description: string): Subscription {
    // Always returns a fix that succeeds. Drives the iteration
    // counter without ever resolving the loop.
    return () =>
      Effect.succeed({
        kind: "fix",
        description,
        action: Effect.succeed({ kind: "fixed", detail: "did stuff" }),
      });
  }

  it("iteration budget: exits hitl after exactly maxFixAttempts fix attempts; reason names the last action", async () => {
    const isMerged = vi.fn().mockReturnValue(Effect.succeed(false));
    const sub = vi.fn(makeFixSub("rebase agent/x"));

    const outcome = await Effect.runPromise(
      runShepherdPass(
        ISSUE,
        {
          config: makeConfig(),
          cwd: "/tmp/repo",
          baseBranch: "main",
          github: makeGithub(),
          isMerged,
          subscriptions: [sub],
          pollIntervalSeconds: 0,
          maxFixAttempts: 3,
          // Wall-clock far enough out that the iteration budget wins.
          maxWallSeconds: 60,
          // Quiet-polls floor is irrelevant here — every poll fires a fix.
          maxQuietPolls: 999,
        },
        "agent/va-460",
        PR_URL,
      ),
    );

    expect(outcome.kind).toBe("hitl");
    if (outcome.kind !== "hitl") return;
    expect(outcome.reason).toContain("Shepherd iteration budget exhausted (3)");
    expect(outcome.reason).toContain("last action:");
    expect(outcome.reason).toContain("rebase agent/x");
    // Exactly 3 fixes ran; the 4th poll detected exhaustion.
    expect(sub).toHaveBeenCalledTimes(4);
  });

  it("wall-clock budget: exits hitl within ±1s of maxWallSeconds when the loop never resolves", async () => {
    const isMerged = vi.fn().mockReturnValue(Effect.succeed(false));
    // Quiet subscriptions — never fire. Without wall-clock, this
    // would exit `ready` after maxQuietPolls. We set maxQuietPolls
    // far above the wall-clock-window's polls so the budget wins.
    const sub: Subscription = () => Effect.succeed({ kind: "quiet" });

    const t0 = Date.now();
    const outcome = await Effect.runPromise(
      runShepherdPass(
        ISSUE,
        {
          config: makeConfig(),
          cwd: "/tmp/repo",
          baseBranch: "main",
          github: makeGithub(),
          isMerged,
          subscriptions: [sub],
          // 0.2s sleep between polls × ~10 polls = 2s window.
          pollIntervalSeconds: 0.2,
          maxFixAttempts: 999,
          maxWallSeconds: 2,
          maxQuietPolls: 999,
        },
        "agent/va-460",
        PR_URL,
      ),
    );
    const elapsedMs = Date.now() - t0;

    expect(outcome.kind).toBe("hitl");
    if (outcome.kind !== "hitl") return;
    expect(outcome.reason).toContain("Shepherd wall-clock budget exhausted (2s)");
    expect(outcome.reason).toContain("last action:");
    // ±1s tolerance per the AC. Lower bound: we shouldn't exit
    // BEFORE the budget elapses; upper bound: pollInterval + scheduling jitter.
    expect(elapsedMs).toBeGreaterThanOrEqual(1500);
    expect(elapsedMs).toBeLessThanOrEqual(3500);
  });

  it("iteration budget fires BEFORE wall-clock when both could trigger and iterations exhaust first", async () => {
    const isMerged = vi.fn().mockReturnValue(Effect.succeed(false));
    const sub = makeFixSub("ci-fix on pnpm test");

    const outcome = await Effect.runPromise(
      runShepherdPass(
        ISSUE,
        {
          config: makeConfig(),
          cwd: "/tmp/repo",
          baseBranch: "main",
          github: makeGithub(),
          isMerged,
          subscriptions: [sub],
          pollIntervalSeconds: 0,
          maxFixAttempts: 1,
          // Wall-clock could fire too — but iteration cap is 1 and
          // we burn it on the first fix; the 2nd poll detects
          // iteration exhaustion before wall-clock has elapsed.
          maxWallSeconds: 60,
          maxQuietPolls: 999,
        },
        "agent/va-460",
        PR_URL,
      ),
    );

    expect(outcome.kind).toBe("hitl");
    if (outcome.kind !== "hitl") return;
    expect(outcome.reason).toContain("iteration budget exhausted");
    expect(outcome.reason).not.toContain("wall-clock");
  });

  it("defaults: ShepherdDeps without overrides reads maxFixAttempts + maxWallSeconds from config", async () => {
    // Drive the iteration budget by setting config.shepherdMaxIterations to 2
    // and confirming hitl fires after exactly 2 fix attempts.
    const cfg = {
      ...makeConfig(),
      shepherdMaxIterations: 2,
      shepherdMaxWallSeconds: 60,
    } as unknown as Config;
    const isMerged = vi.fn().mockReturnValue(Effect.succeed(false));
    const sub = vi.fn(makeFixSub("act"));

    const outcome = await Effect.runPromise(
      runShepherdPass(
        ISSUE,
        {
          config: cfg,
          cwd: "/tmp/repo",
          baseBranch: "main",
          github: makeGithub(),
          isMerged,
          subscriptions: [sub],
          pollIntervalSeconds: 0,
          maxQuietPolls: 999,
          // NO maxFixAttempts override — should read from config.
        },
        "agent/va-460",
        PR_URL,
      ),
    );

    expect(outcome.kind).toBe("hitl");
    if (outcome.kind !== "hitl") return;
    expect(outcome.reason).toContain("(2)");
    expect(sub).toHaveBeenCalledTimes(3);
  });
});
