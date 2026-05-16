import { Effect, Redacted } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type LinearGateway, type RunwayIssue } from "./linear.js";
import type { GithubGateway } from "./github.js";
import type { Config } from "./config.js";

const execaMock = vi.fn();
const sandcastleRunMock = vi.fn();

vi.mock("execa", () => ({ execa: execaMock }));
vi.mock("@ai-hero/sandcastle", () => ({
  run: sandcastleRunMock,
  claudeCode: vi.fn(() => ({ kind: "claudeCode" })),
}));
vi.mock("@ai-hero/sandcastle/sandboxes/docker", () => ({
  docker: vi.fn(() => ({ kind: "docker" })),
}));
vi.mock("./prompts.js", () => ({
  renderImplementPrompt: vi.fn().mockResolvedValue("implement prompt rendered"),
  renderReviewPrompt: vi.fn().mockResolvedValue("review prompt rendered"),
  // VA-383: orchestrator now calls formatPriorFeedback for every
  // issue. Default to empty string in tests that don't care about
  // prior-feedback wiring — the orchestrator-test fixtures predate
  // VA-383 and shouldn't have to reason about comment history.
  formatPriorFeedback: vi.fn().mockReturnValue(""),
  // VA-418: same default for the in-run reviewer-feedback formatter.
  // The retry-loop tests assert on the number of sandcastle calls
  // and exit shape — they don't care about the formatted string.
  formatInRunReviewerFeedback: vi.fn().mockReturnValue(""),
}));

const { drainQueue: drainQueueEffect } = await import("./orchestrator.js");

// VA-358: drainQueue is now an Effect. Test bodies still want the
// async-await shape; this adapter runs the program and yields the
// `OrchestratorResult`, keeping the existing assertions intact.
const drainQueue = (
  deps: Parameters<typeof drainQueueEffect>[0],
  opts?: Parameters<typeof drainQueueEffect>[1],
) => Effect.runPromise(drainQueueEffect(deps, opts));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockedLinear = {
  fetchReady: ReturnType<typeof vi.fn>;
  applyLabel: ReturnType<typeof vi.fn>;
  removeLabel: ReturnType<typeof vi.fn>;
  comment: ReturnType<typeof vi.fn>;
  fetchComments: ReturnType<typeof vi.fn>;
  viewer: ReturnType<typeof vi.fn>;
};

function makeLinear(): MockedLinear {
  // VA-356: mocks now return Effects (not Promises). Tests that set up
  // their own behavior with `.mockReturnValueOnce(Effect.succeed(...))`
  // / `.mockReturnValueOnce(Effect.fail(...))` follow the same pattern;
  // tests with no explicit setup get a successful default.
  //
  // VA-383: `fetchComments` and `viewer` default to benign returns —
  // empty comment list and a viewer name that matches the test
  // assertions' implicit expectations (no prior-feedback noise in
  // existing fixtures). Tests exercising prior-feedback behavior
  // override with `.mockReturnValueOnce(...)`.
  //
  // VA-423: `transition` is gone (runway no longer mutates Linear
  // workflow state); `removeLabel` is the new pickup-time claim
  // primitive — every drain pickup calls it with `config.readyLabel`.
  return {
    fetchReady: vi.fn(),
    applyLabel: vi.fn().mockReturnValue(Effect.succeed(undefined)),
    // VA-423: default to `{ removed: true }` so the orchestrator
    // treats the test as the claim-winner branch. Lost-race tests
    // override with `Effect.succeed({ removed: false })`.
    removeLabel: vi.fn().mockReturnValue(Effect.succeed({ removed: true })),
    comment: vi.fn().mockReturnValue(Effect.succeed(undefined)),
    fetchComments: vi.fn().mockReturnValue(Effect.succeed([])),
    viewer: vi
      .fn()
      .mockReturnValue(Effect.succeed({ id: "viewer-1", name: "Test Viewer" })),
  };
}

function asLinear(m: MockedLinear): LinearGateway {
  return m as unknown as LinearGateway;
}

function makeGithub(): GithubGateway {
  return {
    pushBranch: vi.fn().mockReturnValue(Effect.succeed(undefined)),
    openPullRequest: vi
      .fn()
      .mockReturnValue(Effect.succeed("https://example/pr/1")),
  };
}

const config: Config = {
  linearApiKey: Redacted.make("test-key"),
  linearTeam: "VA",
  readyLabel: "ready-for-agent",
  hitlLabel: "ready-for-human",
  maxIterations: 1,
  implTurns: 1,
  // VA-418: default review-retries budget for tests is 0 — the
  // legacy fixtures predate the in-run retry loop and shouldn't
  // accidentally fire it. Tests exercising retry behavior override
  // with `{ ...config, reviewRetries: N }` explicitly.
  reviewRetries: 0,
  metaReviewModel: "claude-sonnet-4-6",
  metaProjectName: "runway-meta",
};

const issue: RunwayIssue = {
  id: "issue-123",
  identifier: "VA-312",
  title: "Test issue",
  description: "test",
  labels: [],
};

beforeEach(() => {
  execaMock.mockReset();
  sandcastleRunMock.mockReset();
});

// Default `execa` mock router. detectBaseBranch's symbolic-ref call
// returns `origin/main`; rev-list returns whatever the test sets;
// diff/log return empty (review path doesn't inspect their contents
// beyond rendering them into a prompt template); fetch + rebase
// (VA-419) default to clean replay so the finalize-time rebase
// passthrough doesn't change the outcomes of pre-existing tests.
function routeExeca(opts: { revListCount: string }): void {
  execaMock.mockImplementation((bin: string, args: readonly string[]) => {
    if (bin !== "git") {
      return Promise.reject(new Error(`unexpected binary: ${bin}`));
    }
    if (args[0] === "symbolic-ref") {
      return Promise.resolve({ exitCode: 0, stdout: "origin/main\n" });
    }
    if (args[0] === "rev-list") {
      return Promise.resolve({ exitCode: 0, stdout: opts.revListCount });
    }
    if (args[0] === "diff" || args[0] === "log") {
      // The orchestrator captures the diff + commit log to render the
      // review prompt; tests don't care about the actual contents.
      return Promise.resolve({ exitCode: 0, stdout: "" });
    }
    if (args[0] === "fetch" || args[0] === "rebase") {
      // VA-419: clean rebase by default. Tests covering the conflict
      // path build their own execa impl.
      return Promise.resolve({ exitCode: 0, stdout: "" });
    }
    return Promise.reject(new Error(`unexpected git args: ${args.join(" ")}`));
  });
}

// ---------------------------------------------------------------------------
// Tests — VA-344 attempt-count + seen-this-run loop guard
// ---------------------------------------------------------------------------

describe("drainQueue --max semantics (VA-344 / VA-423)", () => {
  it("counts every attempt so --max bounds the loop, even when fetchReady keeps re-surfacing failed issues", async () => {
    // Three issues; sandcastle rejects on every attempt. VA-423: the
    // pickup-time `removeLabel(readyLabel)` would normally take an
    // issue out of the next drain's queue, but the fake `fetchReady`
    // ignores that side-effect and keeps re-returning the full list,
    // simulating a Linear eventual-consistency window. The
    // same-invocation `seen` guard must filter the repeats out.
    routeExeca({ revListCount: "0" });

    const a: RunwayIssue = { id: "a", identifier: "VA-1", title: "a", description: "", labels: [] };
    const b: RunwayIssue = { id: "b", identifier: "VA-2", title: "b", description: "", labels: [] };
    const c: RunwayIssue = { id: "c", identifier: "VA-3", title: "c", description: "", labels: [] };

    sandcastleRunMock.mockRejectedValue(new Error("kapow"));

    const linear = makeLinear();
    linear.fetchReady.mockReturnValue(Effect.succeed([a, b, c]));

    const result = await drainQueue(
      { config, linear: asLinear(linear), github: makeGithub(), cwd: "/tmp/repo" },
      { max: 3 },
    );

    expect(result).toMatchObject({
      attempts: 3,
      opened: 0,
      hitl: 0,
      errored: 3,
    });

    // Each issue was attempted exactly once — confirmed by the
    // distinct `removeLabel(readyLabel)` pickup signals.
    const picked = linear.removeLabel.mock.calls
      .filter((c) => c[1] === "ready-for-agent")
      .map((c) => c[0]);
    expect(picked.sort()).toEqual(["a", "b", "c"]);
  });

  it("--max 1 against a single broken issue: one attempt then exit", async () => {
    routeExeca({ revListCount: "0" });
    sandcastleRunMock.mockRejectedValue(new Error("missing image"));

    const linear = makeLinear();
    linear.fetchReady.mockReturnValue(Effect.succeed([issue]));

    const result = await drainQueue(
      { config, linear: asLinear(linear), github: makeGithub(), cwd: "/tmp/repo" },
      { max: 1 },
    );

    expect(result).toMatchObject({
      attempts: 1,
      opened: 0,
      hitl: 0,
      errored: 1,
    });

    // One pickup. No second attempt despite `fetchReady` still
    // surfacing the issue (the seen-set short-circuits before the
    // claim removeLabel fires a second time).
    const picked = linear.removeLabel.mock.calls.filter(
      (c) => c[1] === "ready-for-agent",
    );
    expect(picked).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tests — VA-423 lost-claim-race short-circuit
// ---------------------------------------------------------------------------

describe("drainQueue lost-claim-race (VA-423)", () => {
  it("a runner that loses the claim race skips the issue cleanly: no pickup comment, no agent branch, no sandcastle invocation, no PR", async () => {
    routeExeca({ revListCount: "1" });
    const linear = makeLinear();
    // Simulate another runner having stripped `ready-for-agent`
    // between our `fetchReady` and our claim write.
    linear.removeLabel.mockReturnValueOnce(
      Effect.succeed({ removed: false }),
    );
    linear.fetchReady
      .mockReturnValueOnce(Effect.succeed([issue]))
      .mockReturnValueOnce(Effect.succeed([]));

    const github = makeGithub();
    const result = await drainQueue({
      config,
      linear: asLinear(linear),
      github,
      cwd: "/tmp/repo",
    });

    expect(result).toMatchObject({
      attempts: 1,
      opened: 0,
      hitl: 0,
      errored: 0,
      skipped: 1,
    });
    expect(result.outcomes[0]).toMatchObject({
      identifier: "VA-312",
      kind: "skipped",
    });
    // No pickup comment, no sandcastle invocation, no github
    // side-effects — the losing runner did none of the work the
    // winner is doing.
    expect(linear.comment).not.toHaveBeenCalled();
    expect(sandcastleRunMock).not.toHaveBeenCalled();
    expect(github.pushBranch).not.toHaveBeenCalled();
    expect(github.openPullRequest).not.toHaveBeenCalled();
    // And specifically: no flagHitl-side `applyLabel` either — a
    // lost race is not a failure.
    expect(linear.applyLabel).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — VA-350 IMPL: marker contract
// ---------------------------------------------------------------------------

describe("drainQueue impl marker behaviour (VA-350)", () => {
  it("BLOCKED short-circuits to HITL with the reason; reviewer pass does not run", async () => {
    routeExeca({ revListCount: "1" });
    sandcastleRunMock.mockResolvedValue({
      stdout: "IMPL: BLOCKED — issue ambiguous, need product decision",
      commits: [{ sha: "abc" }],
    });

    const linear = makeLinear();
    linear.fetchReady
      .mockReturnValueOnce(Effect.succeed([issue]))
      .mockReturnValueOnce(Effect.succeed([]));

    const result = await drainQueue({
      config,
      linear: asLinear(linear),
      github: makeGithub(),
      cwd: "/tmp/repo",
    });

    expect(result).toMatchObject({
      attempts: 1,
      opened: 0,
      hitl: 1,
      errored: 0,
    });
    // sandcastle.run was called once (impl) — not twice (impl + review).
    expect(sandcastleRunMock).toHaveBeenCalledTimes(1);
    expect(linear.applyLabel).toHaveBeenCalledWith("issue-123", "ready-for-human");
    const commentBodies = linear.comment.mock.calls.map((c) => String(c[1]));
    expect(commentBodies.some((b) => /issue ambiguous/.test(b))).toBe(true);
  });

  it("DONE proceeds to the reviewer pass and passes completionSignal through", async () => {
    routeExeca({ revListCount: "1" });
    sandcastleRunMock
      .mockResolvedValueOnce({
        stdout: "all done\nIMPL: DONE",
        commits: [{ sha: "abc" }],
      })
      .mockResolvedValueOnce({
        stdout: "REVIEW: APPROVED",
        commits: [],
      });

    const linear = makeLinear();
    linear.fetchReady
      .mockReturnValueOnce(Effect.succeed([issue]))
      .mockReturnValueOnce(Effect.succeed([]));

    const github = makeGithub();
    const result = await drainQueue({
      config,
      linear: asLinear(linear),
      github,
      cwd: "/tmp/repo",
    });

    expect(result).toMatchObject({
      attempts: 1,
      opened: 1,
      hitl: 0,
      errored: 0,
    });
    expect(sandcastleRunMock).toHaveBeenCalledTimes(2);
    // First call (impl) wires IMPL: completion signals.
    expect(sandcastleRunMock.mock.calls[0]?.[0]).toMatchObject({
      completionSignal: ["IMPL: DONE", "IMPL: BLOCKED"],
    });
    expect(github.openPullRequest).toHaveBeenCalled();
  });

  it("missing marker with commits falls through to review (back-compat)", async () => {
    routeExeca({ revListCount: "1" });
    sandcastleRunMock
      .mockResolvedValueOnce({
        stdout: "did stuff, forgot the marker",
        commits: [{ sha: "abc" }],
      })
      .mockResolvedValueOnce({
        stdout: "REVIEW: APPROVED",
        commits: [],
      });

    const linear = makeLinear();
    linear.fetchReady
      .mockReturnValueOnce(Effect.succeed([issue]))
      .mockReturnValueOnce(Effect.succeed([]));

    const result = await drainQueue({
      config,
      linear: asLinear(linear),
      github: makeGithub(),
      cwd: "/tmp/repo",
    });

    expect(result).toMatchObject({
      attempts: 1,
      opened: 1,
      hitl: 0,
      errored: 0,
    });
    expect(sandcastleRunMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Tests — VA-360 missing-verdict routing
// ---------------------------------------------------------------------------

describe("drainQueue missing-verdict routing (VA-360)", () => {
  it("routes a review pass with no REVIEW: marker to HITL with a 'crashed or truncated' reason — not a generic rejection", async () => {
    // Pre-VA-360 this case was bucketed as "Sub-agent review
    // rejected: review output did not contain a REVIEW: verdict
    // line" — indistinguishable from a real rejection. The operator
    // would argue with a verdict that wasn't actually made.
    routeExeca({ revListCount: "3" });
    sandcastleRunMock
      .mockResolvedValueOnce({
        stdout: "implementation done\nIMPL: DONE",
        commits: [{ sha: "abc" }],
      })
      .mockResolvedValueOnce({
        // No REVIEW: marker anywhere — review pass crashed mid-output.
        stdout: "reviewing...\nReached max iterations (1).",
        commits: [],
      });

    const linear = makeLinear();
    linear.fetchReady
      .mockReturnValueOnce(Effect.succeed([issue]))
      .mockReturnValueOnce(Effect.succeed([]));

    const result = await drainQueue({
      config,
      linear: asLinear(linear),
      github: makeGithub(),
      cwd: "/tmp/repo",
    });

    expect(result).toMatchObject({
      attempts: 1,
      opened: 0,
      hitl: 1,
      errored: 0,
    });

    const commentBodies = linear.comment.mock.calls.map((c) => String(c[1]));
    const hitlComment = commentBodies.find((b) =>
      /flagged for human review/.test(b),
    );
    expect(hitlComment).toBeDefined();
    // The post-VA-360 reason explicitly distinguishes
    // crashed/truncated from a real rejection.
    expect(hitlComment).toMatch(
      /without a REVIEW: marker \(likely crashed or truncated\)/,
    );
    expect(hitlComment).not.toMatch(/Sub-agent review rejected/);
  });
});

// Tests — VA-349 iteration memory plumbing
// ---------------------------------------------------------------------------

describe("drainQueue iteration memory (VA-349)", () => {
  it("threads the previous-iteration summary into the next prompt and stops on DONE", async () => {
    routeExeca({ revListCount: "1" });
    // Iteration 1: CONTINUE (no marker on first message). Iteration 2:
    // DONE. Iteration 3 must NOT run.
    sandcastleRunMock
      .mockResolvedValueOnce({
        stdout: "iter1 work\nIMPL: CONTINUE",
        commits: [{ sha: "abc" }],
      })
      .mockResolvedValueOnce({
        stdout: "iter2 finished\nIMPL: DONE",
        commits: [{ sha: "abc" }, { sha: "def" }],
      })
      .mockResolvedValueOnce({
        stdout: "REVIEW: APPROVED",
        commits: [],
      });

    const linear = makeLinear();
    linear.fetchReady
      .mockReturnValueOnce(Effect.succeed([issue]))
      .mockReturnValueOnce(Effect.succeed([]));

    const result = await drainQueue(
      {
        config: { ...config, maxIterations: 5 },
        linear: asLinear(linear),
        github: makeGithub(),
        cwd: "/tmp/repo",
      },
      {},
    );

    expect(result).toMatchObject({
      attempts: 1,
      opened: 1,
      hitl: 0,
      errored: 0,
    });
    // Two impl iterations + one review = 3 sandcastle calls. Iteration 3
    // must NOT run because iter2 emitted IMPL: DONE.
    expect(sandcastleRunMock).toHaveBeenCalledTimes(3);

    // Iteration names carry the iteration counter.
    const names = sandcastleRunMock.mock.calls.map(
      (c) => (c[0] as { name?: string }).name ?? "",
    );
    expect(names[0]).toBe("impl-VA-312-iter-1");
    expect(names[1]).toBe("impl-VA-312-iter-2");
    expect(names[2]).toBe("review-VA-312");

    // Iteration 1's prompt is whatever the (mocked) prompt template
    // is — our mock returns it verbatim. Iteration 2's prompt should
    // carry the summary string produced after iter 1 by our mocked
    // `buildIterationSummary`.
    const iter2Prompt = (sandcastleRunMock.mock.calls[1]?.[0] as {
      prompt?: string;
    }).prompt;
    // Because implementVars is mocked to return `{}`, the rendered
    // template doesn't substitute PREVIOUS_ITERATIONS — to keep this
    // test scoped to the orchestrator, we instead assert the
    // orchestrator built and passed a non-empty summary on to render.
    // The presence of "summary-after-1" inside the rendered prompt
    // requires the real renderPrompt+template; the mock above renders
    // verbatim. We separately unit-test buildIterationSummary in
    // prompts.test.ts.
    expect(typeof iter2Prompt).toBe("string");
  });

  it("does not call captureCommitLog on the final iteration when it terminates with DONE", async () => {
    routeExeca({ revListCount: "1" });
    sandcastleRunMock
      .mockResolvedValueOnce({
        stdout: "done first try\nIMPL: DONE",
        commits: [{ sha: "abc" }],
      })
      .mockResolvedValueOnce({
        stdout: "REVIEW: APPROVED",
        commits: [],
      });

    const linear = makeLinear();
    linear.fetchReady
      .mockReturnValueOnce(Effect.succeed([issue]))
      .mockReturnValueOnce(Effect.succeed([]));

    await drainQueue(
      {
        config: { ...config, maxIterations: 5 },
        linear: asLinear(linear),
        github: makeGithub(),
        cwd: "/tmp/repo",
      },
      {},
    );

    // Only one log call: the pre-review one. The mid-loop summary
    // build was skipped because iter1 returned DONE.
    const logCalls = execaMock.mock.calls.filter(
      (c) => Array.isArray(c[1]) && (c[1] as string[])[0] === "log",
    );
    expect(logCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tests — VA-418 in-run review-rejection retry loop
// ---------------------------------------------------------------------------

describe("drainQueue review-rejection retry loop (VA-418)", () => {
  it("on REJECTED-RETRY (budget remaining), re-runs impl with reviewer feedback and re-runs review", async () => {
    routeExeca({ revListCount: "1" });
    // Pair 1: impl DONE then review REJECTED-RETRY.
    // Pair 2: impl DONE then review APPROVED.
    sandcastleRunMock
      .mockResolvedValueOnce({
        stdout: "first impl pass\nIMPL: DONE",
        commits: [{ sha: "abc" }],
      })
      .mockResolvedValueOnce({
        stdout:
          "REVIEW: REJECTED-RETRY — normalize both timestamps before the lex compare",
        commits: [],
      })
      .mockResolvedValueOnce({
        stdout: "second impl pass with fix\nIMPL: DONE",
        commits: [{ sha: "abc" }, { sha: "def" }],
      })
      .mockResolvedValueOnce({
        stdout: "REVIEW: APPROVED",
        commits: [],
      });

    const linear = makeLinear();
    linear.fetchReady
      .mockReturnValueOnce(Effect.succeed([issue]))
      .mockReturnValueOnce(Effect.succeed([]));

    const github = makeGithub();
    const result = await drainQueue({
      config: { ...config, reviewRetries: 1 },
      linear: asLinear(linear),
      github,
      cwd: "/tmp/repo",
    });

    expect(result).toMatchObject({
      attempts: 1,
      opened: 1,
      hitl: 0,
      errored: 0,
    });

    // Two impl + two review = 4 sandcastle calls.
    expect(sandcastleRunMock).toHaveBeenCalledTimes(4);

    const names = sandcastleRunMock.mock.calls.map(
      (c) => (c[0] as { name?: string }).name ?? "",
    );
    expect(names).toEqual([
      "impl-VA-312-iter-1",
      "review-VA-312",
      "impl-VA-312-iter-1",
      "review-VA-312",
    ]);
    expect(github.openPullRequest).toHaveBeenCalled();
  });

  it("on REJECTED-RETRY with budget exhausted, escalates to HITL naming the FINAL rejection and chain length", async () => {
    routeExeca({ revListCount: "1" });
    sandcastleRunMock
      .mockResolvedValueOnce({
        stdout: "first impl\nIMPL: DONE",
        commits: [{ sha: "abc" }],
      })
      .mockResolvedValueOnce({
        stdout: "REVIEW: REJECTED-RETRY — fix the timestamp lex compare",
        commits: [],
      })
      .mockResolvedValueOnce({
        stdout: "second impl\nIMPL: DONE",
        commits: [{ sha: "abc" }, { sha: "def" }],
      })
      .mockResolvedValueOnce({
        stdout: "REVIEW: REJECTED-RETRY — still doesn't handle DST",
        commits: [],
      });

    const linear = makeLinear();
    linear.fetchReady
      .mockReturnValueOnce(Effect.succeed([issue]))
      .mockReturnValueOnce(Effect.succeed([]));

    const result = await drainQueue({
      config: { ...config, reviewRetries: 1 },
      linear: asLinear(linear),
      github: makeGithub(),
      cwd: "/tmp/repo",
    });

    expect(result).toMatchObject({
      attempts: 1,
      opened: 0,
      hitl: 1,
      errored: 0,
    });
    expect(sandcastleRunMock).toHaveBeenCalledTimes(4);

    const hitlComment = linear.comment.mock.calls
      .map((c) => String(c[1]))
      .find((b) => /flagged for human review/.test(b));
    expect(hitlComment).toBeDefined();
    // Names the FINAL rejection reason and the chain length so the
    // operator can see how many attempts we burned.
    expect(hitlComment).toMatch(/Ran out of review retries \(2 attempts\)/);
    expect(hitlComment).toMatch(/still doesn't handle DST/);
    expect(linear.applyLabel).toHaveBeenCalledWith("issue-123", "ready-for-human");
  });

  it("on REJECTED-HITL, escalates immediately — no second impl attempt", async () => {
    routeExeca({ revListCount: "1" });
    sandcastleRunMock
      .mockResolvedValueOnce({
        stdout: "first impl\nIMPL: DONE",
        commits: [{ sha: "abc" }],
      })
      .mockResolvedValueOnce({
        stdout:
          "REVIEW: REJECTED-HITL — diff implements a different feature than the issue describes; needs a product call",
        commits: [],
      });

    const linear = makeLinear();
    linear.fetchReady
      .mockReturnValueOnce(Effect.succeed([issue]))
      .mockReturnValueOnce(Effect.succeed([]));

    const result = await drainQueue({
      // Generous retry budget — REJECTED-HITL must short-circuit it
      // regardless.
      config: { ...config, reviewRetries: 5 },
      linear: asLinear(linear),
      github: makeGithub(),
      cwd: "/tmp/repo",
    });

    expect(result).toMatchObject({
      attempts: 1,
      opened: 0,
      hitl: 1,
      errored: 0,
    });
    // One impl + one review = 2 sandcastle calls. No retry.
    expect(sandcastleRunMock).toHaveBeenCalledTimes(2);

    const hitlComment = linear.comment.mock.calls
      .map((c) => String(c[1]))
      .find((b) => /flagged for human review/.test(b));
    expect(hitlComment).toMatch(/needs human judgment/);
    expect(hitlComment).toMatch(/implements a different feature/);
  });

  it("RUNWAY_REVIEW_RETRIES=0 disables retries entirely — every rejection goes straight to HITL", async () => {
    routeExeca({ revListCount: "1" });
    sandcastleRunMock
      .mockResolvedValueOnce({
        stdout: "first impl\nIMPL: DONE",
        commits: [{ sha: "abc" }],
      })
      .mockResolvedValueOnce({
        stdout:
          "REVIEW: REJECTED-RETRY — add the missing scheme guard (would be mechanically fixable)",
        commits: [],
      });

    const linear = makeLinear();
    linear.fetchReady
      .mockReturnValueOnce(Effect.succeed([issue]))
      .mockReturnValueOnce(Effect.succeed([]));

    const result = await drainQueue({
      // Kill-switch: zero retries. Even though the marker is RETRY,
      // the budget is exhausted after the first review and we
      // escalate immediately.
      config: { ...config, reviewRetries: 0 },
      linear: asLinear(linear),
      github: makeGithub(),
      cwd: "/tmp/repo",
    });

    expect(result).toMatchObject({
      attempts: 1,
      opened: 0,
      hitl: 1,
      errored: 0,
    });
    expect(sandcastleRunMock).toHaveBeenCalledTimes(2);

    const hitlComment = linear.comment.mock.calls
      .map((c) => String(c[1]))
      .find((b) => /flagged for human review/.test(b));
    // Single attempt → "1 attempt" (singular), naming the rejection.
    expect(hitlComment).toMatch(/Ran out of review retries \(1 attempt\)/);
    expect(hitlComment).toMatch(/add the missing scheme guard/);
  });

  it("legacy bare REVIEW: REJECTED maps to rejected-retry and flows through the retry loop (VA-418 back-compat)", async () => {
    routeExeca({ revListCount: "1" });
    sandcastleRunMock
      .mockResolvedValueOnce({
        stdout: "first impl\nIMPL: DONE",
        commits: [{ sha: "abc" }],
      })
      .mockResolvedValueOnce({
        // Legacy marker — no `-RETRY` / `-HITL` suffix.
        stdout: "REVIEW: REJECTED — withAudit swallows errors",
        commits: [],
      })
      .mockResolvedValueOnce({
        stdout: "second impl, fixed it\nIMPL: DONE",
        commits: [{ sha: "abc" }, { sha: "def" }],
      })
      .mockResolvedValueOnce({
        stdout: "REVIEW: APPROVED",
        commits: [],
      });

    const linear = makeLinear();
    linear.fetchReady
      .mockReturnValueOnce(Effect.succeed([issue]))
      .mockReturnValueOnce(Effect.succeed([]));

    const result = await drainQueue({
      config: { ...config, reviewRetries: 1 },
      linear: asLinear(linear),
      github: makeGithub(),
      cwd: "/tmp/repo",
    });

    expect(result).toMatchObject({
      attempts: 1,
      opened: 1,
      hitl: 0,
      errored: 0,
    });
    // Legacy REJECTED flowed through retry → second impl → APPROVED → PR.
    expect(sandcastleRunMock).toHaveBeenCalledTimes(4);
  });
});

// ---------------------------------------------------------------------------
// Tests — VA-346 base-branch threading
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tests — VA-419 rebase-onto-base before opening the PR
// ---------------------------------------------------------------------------

describe("drainQueue finalize-time rebase (VA-419)", () => {
  it("clean rebase passes through to push + PR open as before", async () => {
    // Default routeExeca returns exit 0 for fetch + rebase, so this
    // reproduces the pre-VA-419 "happy path" outcome. The extra git
    // calls don't change the final result.
    routeExeca({ revListCount: "1" });
    sandcastleRunMock
      .mockResolvedValueOnce({
        stdout: "impl done\nIMPL: DONE",
        commits: [{ sha: "abc" }],
      })
      .mockResolvedValueOnce({
        stdout: "REVIEW: APPROVED",
        commits: [],
      });

    const linear = makeLinear();
    linear.fetchReady
      .mockReturnValueOnce(Effect.succeed([issue]))
      .mockReturnValueOnce(Effect.succeed([]));

    const github = makeGithub();
    const result = await drainQueue({
      config,
      linear: asLinear(linear),
      github,
      cwd: "/tmp/repo",
    });

    expect(result).toMatchObject({
      attempts: 1,
      opened: 1,
      hitl: 0,
      errored: 0,
    });
    // The fetch + rebase calls were issued.
    const gitVerbs = execaMock.mock.calls
      .filter((c) => c[0] === "git")
      .map((c) => (c[1] as readonly string[])[0]);
    expect(gitVerbs).toContain("fetch");
    expect(gitVerbs).toContain("rebase");
    // PR was opened — push and pr create both fired.
    expect(github.pushBranch).toHaveBeenCalled();
    expect(github.openPullRequest).toHaveBeenCalled();
  });

  it("rebase conflict after APPROVED → HITL with base-branch + file list; PR is NOT opened", async () => {
    // Custom execa impl: fetch ok, rebase exits non-zero, diff
    // surfaces the unmerged files, abort succeeds.
    execaMock.mockImplementation((bin: string, args: readonly string[]) => {
      if (bin !== "git") {
        return Promise.reject(new Error(`unexpected binary: ${bin}`));
      }
      if (args[0] === "symbolic-ref") {
        return Promise.resolve({ exitCode: 0, stdout: "origin/main\n" });
      }
      if (args[0] === "rev-list") {
        return Promise.resolve({ exitCode: 0, stdout: "3" });
      }
      if (args[0] === "diff" && args[1] === "--name-only") {
        return Promise.resolve({
          exitCode: 0,
          stdout:
            "src/dashboard/storage.ts\nsrc/dashboard/storage.test.ts\n",
        });
      }
      if (args[0] === "diff" || args[0] === "log") {
        return Promise.resolve({ exitCode: 0, stdout: "" });
      }
      if (args[0] === "fetch") {
        return Promise.resolve({ exitCode: 0, stdout: "" });
      }
      if (args[0] === "rebase") {
        if (args[1] === "--abort") {
          return Promise.resolve({ exitCode: 0, stdout: "" });
        }
        // origin/<base> <branch> rebase invocation — conflict.
        return Promise.resolve({ exitCode: 1, stdout: "" });
      }
      return Promise.reject(
        new Error(`unexpected git args: ${args.join(" ")}`),
      );
    });

    sandcastleRunMock
      .mockResolvedValueOnce({
        stdout: "impl done\nIMPL: DONE",
        commits: [{ sha: "abc" }],
      })
      .mockResolvedValueOnce({
        stdout: "REVIEW: APPROVED",
        commits: [],
      });

    const linear = makeLinear();
    linear.fetchReady
      .mockReturnValueOnce(Effect.succeed([issue]))
      .mockReturnValueOnce(Effect.succeed([]));

    const github = makeGithub();
    const result = await drainQueue({
      config,
      linear: asLinear(linear),
      github,
      cwd: "/tmp/repo",
    });

    // Routed to HITL — not opened, not errored. The drain spent its
    // attempt and counted one HITL outcome.
    expect(result).toMatchObject({
      attempts: 1,
      opened: 0,
      hitl: 1,
      errored: 0,
    });

    // Push and PR create were NOT invoked — the rebase failure
    // short-circuited finalize before any GitHub side-effect.
    expect(github.pushBranch).not.toHaveBeenCalled();
    expect(github.openPullRequest).not.toHaveBeenCalled();

    // HITL plumbing: ready-for-human label applied, comment names the base
    // branch + conflicted files + quotes the APPROVED verdict.
    expect(linear.applyLabel).toHaveBeenCalledWith("issue-123", "ready-for-human");
    const commentBodies = linear.comment.mock.calls.map((c) => String(c[1]));
    const hitlComment = commentBodies.find((b) =>
      /flagged for human review/.test(b),
    );
    expect(hitlComment).toBeDefined();
    // VA-424: message no longer falsely claims "upstream advanced" —
    // it names merge conflicts as the cause and points at origin/<base>.
    expect(hitlComment).toMatch(/onto `origin\/main` produced merge/);
    expect(hitlComment).not.toMatch(/Upstream base.*advanced/);
    expect(hitlComment).toMatch(/src\/dashboard\/storage\.ts/);
    expect(hitlComment).toMatch(/src\/dashboard\/storage\.test\.ts/);
    expect(hitlComment).toMatch(/Review was APPROVED before the rebase/);
    expect(hitlComment).toMatch(/REVIEW: APPROVED/);
    // VA-424: recovery guidance no longer recommends VA-417 (which
    // would destroy the approved work).
    expect(hitlComment).not.toMatch(/VA-417/);

    // `git rebase --abort` ran — pre-rebase state was restored.
    const gitCalls = execaMock.mock.calls
      .filter((c) => c[0] === "git")
      .map((c) => (c[1] as readonly string[]).join(" "));
    expect(gitCalls).toContain("rebase --abort");
  });

  it("VA-424: non-conflict rebase failure (no unmerged files) → HITL with stderr; PR is NOT opened", async () => {
    // Mode A from the live evidence: rebase exits non-zero but git
    // reports no unmerged files (e.g., dirty host worktree). The
    // orchestrator must distinguish this from a real merge conflict
    // and surface stderr in the HITL diagnostic.
    execaMock.mockImplementation((bin: string, args: readonly string[]) => {
      if (bin !== "git") {
        return Promise.reject(new Error(`unexpected binary: ${bin}`));
      }
      if (args[0] === "symbolic-ref") {
        return Promise.resolve({ exitCode: 0, stdout: "origin/main\n" });
      }
      if (args[0] === "rev-list") {
        return Promise.resolve({ exitCode: 0, stdout: "3" });
      }
      if (args[0] === "diff" && args[1] === "--name-only") {
        // No unmerged files — this is what makes it a "failure" rather
        // than a "conflict" per VA-424.
        return Promise.resolve({ exitCode: 0, stdout: "" });
      }
      if (args[0] === "diff" || args[0] === "log") {
        return Promise.resolve({ exitCode: 0, stdout: "" });
      }
      if (args[0] === "fetch") {
        return Promise.resolve({ exitCode: 0, stdout: "" });
      }
      if (args[0] === "rebase") {
        if (args[1] === "--abort") {
          return Promise.resolve({ exitCode: 0, stdout: "" });
        }
        return Promise.resolve({
          exitCode: 128,
          stdout: "",
          stderr: "error: cannot rebase: You have unstaged changes.\n",
        });
      }
      return Promise.reject(
        new Error(`unexpected git args: ${args.join(" ")}`),
      );
    });

    sandcastleRunMock
      .mockResolvedValueOnce({
        stdout: "impl done\nIMPL: DONE",
        commits: [{ sha: "abc" }],
      })
      .mockResolvedValueOnce({
        stdout: "REVIEW: APPROVED",
        commits: [],
      });

    const linear = makeLinear();
    linear.fetchReady
      .mockReturnValueOnce(Effect.succeed([issue]))
      .mockReturnValueOnce(Effect.succeed([]));

    const github = makeGithub();
    const result = await drainQueue({
      config,
      linear: asLinear(linear),
      github,
      cwd: "/tmp/repo",
    });

    expect(result).toMatchObject({
      attempts: 1,
      opened: 0,
      hitl: 1,
      errored: 0,
    });

    expect(github.pushBranch).not.toHaveBeenCalled();
    expect(github.openPullRequest).not.toHaveBeenCalled();

    expect(linear.applyLabel).toHaveBeenCalledWith("issue-123", "ready-for-human");
    const commentBodies = linear.comment.mock.calls.map((c) => String(c[1]));
    const hitlComment = commentBodies.find((b) =>
      /flagged for human review/.test(b),
    );
    expect(hitlComment).toBeDefined();
    // Failure-path wording — names the failure, surfaces stderr, no
    // "merge conflicts" claim and no "upstream advanced" claim.
    expect(hitlComment).toMatch(/onto `origin\/main` failed/);
    expect(hitlComment).toMatch(/no unmerged files/);
    expect(hitlComment).toMatch(/cannot rebase: You have unstaged changes/);
    expect(hitlComment).not.toMatch(/produced merge/);
    expect(hitlComment).not.toMatch(/Upstream base.*advanced/);
    expect(hitlComment).not.toMatch(/VA-417/);
    expect(hitlComment).toMatch(/Review was APPROVED before the rebase/);
  });
});

describe("drainQueue base-branch resolution (VA-346)", () => {
  it("uses RUNWAY_BASE_BRANCH override and skips origin/HEAD detection", async () => {
    // Only rev-list should be invoked; symbolic-ref must not.
    execaMock.mockImplementation((bin: string, args: readonly string[]) => {
      if (args[0] === "symbolic-ref") {
        throw new Error("detectBaseBranch should not run when override is set");
      }
      return Promise.resolve({ exitCode: 0, stdout: "0" });
    });
    sandcastleRunMock.mockRejectedValue(new Error("kapow"));

    const linear = makeLinear();
    linear.fetchReady
      .mockReturnValueOnce(Effect.succeed([issue]))
      .mockReturnValueOnce(Effect.succeed([]));

    await drainQueue({
      config: { ...config, baseBranch: "develop" },
      linear: asLinear(linear),
      github: makeGithub(),
      cwd: "/tmp/repo",
    });

    // rev-list was called with the override branch.
    const revListCall = execaMock.mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[])[0] === "rev-list",
    );
    expect(revListCall?.[1]).toEqual([
      "rev-list",
      "--count",
      "develop..agent/va-312",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Tests — VA-417 HITL-retry: prune the stale agent branch before impl
// ---------------------------------------------------------------------------

describe("drainQueue HITL-retry branch reset (VA-417)", () => {
  it("resets agent/<id> to origin/<base> when the branch already carries commits from a rejected prior attempt", async () => {
    // Symbolic-ref → origin/main. The HITL-retry shape: branch
    // exists with commits ahead, origin/main reachable, no worktree
    // attached. The orchestrator must detect the stale state and
    // issue `git update-ref refs/heads/agent/va-312
    // refs/remotes/origin/main` BEFORE the impl phase fires.
    // Shared monotonic counter so we can compare orderings between
    // execaMock and sandcastleRunMock invocations.
    let seq = 0;
    let updateRefSeenAt = -1;
    let firstSandcastleSeenAt = -1;
    execaMock.mockImplementation((bin: string, args: readonly string[]) => {
      seq += 1;
      if (bin !== "git") {
        return Promise.reject(new Error(`unexpected binary: ${bin}`));
      }
      if (args[0] === "symbolic-ref") {
        return Promise.resolve({ exitCode: 0, stdout: "origin/main\n" });
      }
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        const ref = args[2] as string | undefined;
        // agent branch exists; origin/main is reachable.
        if (ref?.startsWith("refs/heads/agent/")) {
          return Promise.resolve({ exitCode: 0, stdout: "stale-sha\n" });
        }
        if (ref === "refs/remotes/origin/main") {
          return Promise.resolve({ exitCode: 0, stdout: "base-sha\n" });
        }
        return Promise.resolve({ exitCode: 128, stdout: "" });
      }
      if (args[0] === "rev-list") {
        // Stale rejected commits ahead of base.
        return Promise.resolve({ exitCode: 0, stdout: "3\n" });
      }
      if (args[0] === "worktree" && args[1] === "list") {
        // No worktree currently attached (sandcastle's prior close
        // already cleaned it up — the typical post-HITL state).
        return Promise.resolve({ exitCode: 0, stdout: "" });
      }
      if (args[0] === "update-ref") {
        updateRefSeenAt = seq;
        return Promise.resolve({ exitCode: 0, stdout: "" });
      }
      if (args[0] === "diff" || args[0] === "log") {
        return Promise.resolve({ exitCode: 0, stdout: "" });
      }
      // VA-419: finalize now calls `git fetch origin <base>` and
      // `git rebase origin/<base>` before push. The HITL-retry happy
      // path needs both to return clean exits (no rebase conflict).
      if (args[0] === "fetch" || args[0] === "rebase") {
        return Promise.resolve({ exitCode: 0, stdout: "" });
      }
      return Promise.reject(new Error(`unexpected git args: ${args.join(" ")}`));
    });

    sandcastleRunMock
      .mockImplementationOnce(() => {
        seq += 1;
        if (firstSandcastleSeenAt < 0) firstSandcastleSeenAt = seq;
        return Promise.resolve({
          stdout: "fixed reviewer feedback\nIMPL: DONE",
          commits: [{ sha: "fresh" }],
        });
      })
      .mockImplementationOnce(() => {
        seq += 1;
        return Promise.resolve({ stdout: "REVIEW: APPROVED", commits: [] });
      });

    const linear = makeLinear();
    linear.fetchReady
      .mockReturnValueOnce(Effect.succeed([issue]))
      .mockReturnValueOnce(Effect.succeed([]));

    const result = await drainQueue({
      config,
      linear: asLinear(linear),
      github: makeGithub(),
      cwd: "/tmp/repo",
    });

    // Reset emitted with the correct args.
    const updateRefCall = execaMock.mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[])[0] === "update-ref",
    );
    expect(updateRefCall?.[1]).toEqual([
      "update-ref",
      "refs/heads/agent/va-312",
      "refs/remotes/origin/main",
    ]);
    // Reset must precede the first sandcastle invocation — the impl
    // agent has to see a clean branch tip, not the stale one.
    expect(updateRefSeenAt).toBeGreaterThan(0);
    expect(firstSandcastleSeenAt).toBeGreaterThan(updateRefSeenAt);
    // Drain still produced the normal opened outcome.
    expect(result).toMatchObject({
      attempts: 1,
      opened: 1,
      hitl: 0,
      errored: 0,
    });
  });

  it("does not call update-ref or git branch -D on the first-attempt case (no stale branch)", async () => {
    // Branch doesn't exist; rev-parse --verify exits non-zero.
    // Existence check should short-circuit.
    execaMock.mockImplementation((bin: string, args: readonly string[]) => {
      if (bin !== "git") {
        return Promise.reject(new Error(`unexpected binary: ${bin}`));
      }
      if (args[0] === "symbolic-ref") {
        return Promise.resolve({ exitCode: 0, stdout: "origin/main\n" });
      }
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        return Promise.resolve({ exitCode: 128, stdout: "" });
      }
      if (args[0] === "rev-list") {
        return Promise.resolve({ exitCode: 0, stdout: "1\n" });
      }
      if (args[0] === "diff" || args[0] === "log") {
        return Promise.resolve({ exitCode: 0, stdout: "" });
      }
      return Promise.reject(new Error(`unexpected git args: ${args.join(" ")}`));
    });
    sandcastleRunMock
      .mockResolvedValueOnce({
        stdout: "first attempt done\nIMPL: DONE",
        commits: [{ sha: "fresh" }],
      })
      .mockResolvedValueOnce({ stdout: "REVIEW: APPROVED", commits: [] });

    const linear = makeLinear();
    linear.fetchReady
      .mockReturnValueOnce(Effect.succeed([issue]))
      .mockReturnValueOnce(Effect.succeed([]));

    await drainQueue({
      config,
      linear: asLinear(linear),
      github: makeGithub(),
      cwd: "/tmp/repo",
    });

    // No reset, no delete. Only the agent existence-check (and the
    // ahead-count check is skipped for non-existent branches).
    expect(
      execaMock.mock.calls.find(
        (c) => Array.isArray(c[1]) && (c[1] as string[])[0] === "update-ref",
      ),
    ).toBeUndefined();
    const branchCall = execaMock.mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[])[0] === "branch",
    );
    expect(branchCall).toBeUndefined();
  });

  it("dies the drain when origin/<base> AND local <base> are both unreachable", async () => {
    // Stale agent branch with commits ahead, but neither
    // origin/main nor refs/heads/main resolves — env/config issue.
    // The drain must NOT silently skip the reset; it must surface
    // a fatal error so the operator fixes the env.
    execaMock.mockImplementation((bin: string, args: readonly string[]) => {
      if (bin !== "git") {
        return Promise.reject(new Error(`unexpected binary: ${bin}`));
      }
      if (args[0] === "symbolic-ref") {
        return Promise.resolve({ exitCode: 0, stdout: "origin/main\n" });
      }
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        const ref = args[2] as string | undefined;
        if (ref?.startsWith("refs/heads/agent/")) {
          return Promise.resolve({ exitCode: 0, stdout: "stale-sha\n" });
        }
        // Both origin/main and local main missing.
        return Promise.resolve({ exitCode: 128, stdout: "" });
      }
      if (args[0] === "rev-list") {
        return Promise.resolve({ exitCode: 0, stdout: "1\n" });
      }
      return Promise.reject(new Error(`unexpected git args: ${args.join(" ")}`));
    });

    const linear = makeLinear();
    linear.fetchReady.mockReturnValue(Effect.succeed([issue]));

    await expect(
      drainQueue({
        config,
        linear: asLinear(linear),
        github: makeGithub(),
        cwd: "/tmp/repo",
      }),
    ).rejects.toThrow(/Cannot reset stale agent branch/);

    // Sandcastle was NOT invoked — the drain bailed before impl.
    expect(sandcastleRunMock).not.toHaveBeenCalled();
  });
});
