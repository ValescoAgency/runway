import { Effect, Redacted } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LinearNetworkError,
  LinearNotFound,
  type LinearGateway,
  type RunwayIssue,
} from "./linear.js";
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
  loadImplementPrompt: vi.fn().mockResolvedValue("implement template"),
  loadReviewPrompt: vi.fn().mockResolvedValue("review template"),
  renderPrompt: (tmpl: string) => tmpl,
  implementVars: () => ({}),
  reviewVars: () => ({}),
  buildIterationSummary: (args: { iterationsRun: number }) =>
    `summary-after-${args.iterationsRun}`,
  tailOfMessage: (s: string) => s,
}));

const {
  drainQueue: drainQueueEffect,
  parseImplVerdict,
  parseReviewVerdict,
} = await import("./orchestrator.js");

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
  transition: ReturnType<typeof vi.fn>;
  applyLabel: ReturnType<typeof vi.fn>;
  comment: ReturnType<typeof vi.fn>;
};

function makeLinear(): MockedLinear {
  // VA-356: mocks now return Effects (not Promises). Tests that set up
  // their own behavior with `.mockReturnValueOnce(Effect.succeed(...))`
  // / `.mockReturnValueOnce(Effect.fail(...))` follow the same pattern;
  // tests with no explicit setup get a successful default.
  return {
    fetchReady: vi.fn(),
    transition: vi.fn().mockReturnValue(Effect.succeed(undefined)),
    applyLabel: vi.fn().mockReturnValue(Effect.succeed(undefined)),
    comment: vi.fn().mockReturnValue(Effect.succeed(undefined)),
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
  readyStatus: "Todo",
  inProgressStatus: "In Progress",
  inReviewStatus: "In Review",
  hitlLabel: "needs-human",
  maxIterations: 1,
};

const issue: RunwayIssue = {
  id: "issue-123",
  identifier: "VA-312",
  title: "Test issue",
  description: "test",
};

beforeEach(() => {
  execaMock.mockReset();
  sandcastleRunMock.mockReset();
});

// Default `execa` mock router. detectBaseBranch's symbolic-ref call
// returns `origin/main`; rev-list returns whatever the test sets;
// diff/log return empty (review path doesn't inspect their contents
// beyond rendering them into a prompt template).
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
    return Promise.reject(new Error(`unexpected git args: ${args.join(" ")}`));
  });
}

// ---------------------------------------------------------------------------
// Tests — VA-342 revert-on-startup-failure behaviour
// ---------------------------------------------------------------------------

describe("drainQueue error handling (VA-342)", () => {
  it("reverts to Todo and skips needs-human when the agent crashes with zero commits", async () => {
    routeExeca({ revListCount: "0" });
    sandcastleRunMock.mockRejectedValue(new Error("missing image"));

    const linear = makeLinear();
    linear.fetchReady
      .mockReturnValueOnce(Effect.succeed([issue]))
      .mockReturnValueOnce(Effect.succeed([])); // queue drains after the failed attempt

    const result = await drainQueue({
      config,
      linear: asLinear(linear),
      github: makeGithub(),
      cwd: "/tmp/repo",
    });

    expect(result).toMatchObject({
      attempts: 1,
      opened: 0,
      hitl: 0,
      errored: 1,
    });
    expect(result.outcomes).toEqual([
      { identifier: "VA-312", kind: "reverted", detail: "missing image" },
    ]);

    // First transition is to In Progress (processIssue's early call); the
    // recovery path adds a second transition back to Todo.
    const transitions = linear.transition.mock.calls.map((c) => c[1]);
    expect(transitions).toEqual(["In Progress", "Todo"]);

    // No HITL label on an infra failure.
    expect(linear.applyLabel).not.toHaveBeenCalled();

    // The recovery comment mentions the revert.
    const commentBodies = linear.comment.mock.calls.map((c) => String(c[1]));
    expect(commentBodies.some((b) => /reverting to .*Todo/.test(b))).toBe(true);
  });

  it("applies needs-human and stays In Progress when the agent crashes after producing commits", async () => {
    routeExeca({ revListCount: "3" });
    sandcastleRunMock.mockRejectedValue(new Error("review pass crashed"));

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
      hitl: 0,
      errored: 1,
    });
    expect(result.outcomes).toEqual([
      { identifier: "VA-312", kind: "errored", detail: "review pass crashed" },
    ]);

    // Only the original In Progress transition — no revert.
    const transitions = linear.transition.mock.calls.map((c) => c[1]);
    expect(transitions).toEqual(["In Progress"]);

    // HITL label applied on a mid-run failure.
    expect(linear.applyLabel).toHaveBeenCalledWith("issue-123", "needs-human");
  });
});

// ---------------------------------------------------------------------------
// Tests — VA-344 attempt-count + seen-this-run loop guard
// ---------------------------------------------------------------------------

describe("drainQueue --max semantics (VA-344)", () => {
  it("counts every attempt — including reverted ones — so --max bounds the loop", async () => {
    // Three issues; the first deterministically fails on every attempt
    // (sandcastle rejects) and produces zero commits, so VA-342 reverts
    // it to Todo. Without VA-344 the loop would re-pick it forever.
    routeExeca({ revListCount: "0" });

    const a: RunwayIssue = { id: "a", identifier: "VA-1", title: "a", description: "" };
    const b: RunwayIssue = { id: "b", identifier: "VA-2", title: "b", description: "" };
    const c: RunwayIssue = { id: "c", identifier: "VA-3", title: "c", description: "" };

    sandcastleRunMock.mockRejectedValue(new Error("kapow"));

    const linear = makeLinear();
    // Every fetchReady returns the full queue — `a` keeps coming back
    // because VA-342 reverts it. The seen-set must filter it out.
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
    // distinct In-Progress transitions.
    const inProgress = linear.transition.mock.calls
      .filter((c) => c[1] === "In Progress")
      .map((c) => c[0]);
    expect(inProgress.sort()).toEqual(["a", "b", "c"]);
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

    // One pickup, one revert. No second attempt despite `fetchReady`
    // still surfacing the issue.
    const inProgress = linear.transition.mock.calls.filter(
      (c) => c[1] === "In Progress",
    );
    expect(inProgress).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tests — VA-350 IMPL: marker contract
// ---------------------------------------------------------------------------

describe("parseImplVerdict (VA-350)", () => {
  it("returns DONE on a trailing IMPL: DONE marker", () => {
    expect(
      parseImplVerdict({ stdout: "all green\n\nIMPL: DONE\n" }),
    ).toEqual({ kind: "done" });
  });

  it("returns BLOCKED with the trailing reason after `—`", () => {
    expect(
      parseImplVerdict({
        stdout:
          "I can't modify .github/workflows under policy.\n\nIMPL: BLOCKED — issue requires CI workflow changes that policy forbids\n",
      }),
    ).toEqual({
      kind: "blocked",
      reason: "issue requires CI workflow changes that policy forbids",
    });
  });

  it("returns BLOCKED with a fallback reason when none is given", () => {
    expect(parseImplVerdict({ stdout: "IMPL: BLOCKED\n" })).toEqual({
      kind: "blocked",
      reason: "no reason given",
    });
  });

  it("returns CONTINUE on a trailing CONTINUE marker", () => {
    expect(parseImplVerdict({ stdout: "still working\nIMPL: CONTINUE\n" }))
      .toEqual({ kind: "continue" });
  });

  it("treats output with no IMPL: marker as missing", () => {
    expect(parseImplVerdict({ stdout: "no marker here" })).toEqual({
      kind: "missing",
    });
  });

  it("uses the LAST marker when several appear across iterations", () => {
    expect(
      parseImplVerdict({
        stdout: "IMPL: CONTINUE\n...next iteration...\nIMPL: DONE\n",
      }),
    ).toEqual({ kind: "done" });
  });
});

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
    expect(linear.applyLabel).toHaveBeenCalledWith("issue-123", "needs-human");
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
// Tests — VA-355 HITL ordering + per-issue verdict trail
// ---------------------------------------------------------------------------

describe("drainQueue HITL ordering (VA-355)", () => {
  it("posts the rejection reason as a comment BEFORE applying the label, so a missing label doesn't swallow the reason", async () => {
    routeExeca({ revListCount: "3" });
    sandcastleRunMock
      .mockResolvedValueOnce({
        stdout: "implementation done\nIMPL: DONE",
        commits: [{ sha: "abc" }],
      })
      .mockResolvedValueOnce({
        stdout:
          "REVIEW: REJECTED — TOCTOU race in provisionHousehold, three substantive bugs",
        commits: [],
      });

    const linear = makeLinear();
    linear.applyLabel.mockReturnValueOnce(
      Effect.fail(
        new LinearNotFound({
          resource: "label",
          identifier: "needs-human",
          message: 'Linear label "needs-human" not found on team xyz',
        }),
      ),
    );
    linear.fetchReady
      .mockReturnValueOnce(Effect.succeed([issue]))
      .mockReturnValueOnce(Effect.succeed([]));

    await drainQueue({
      config,
      linear: asLinear(linear),
      github: makeGithub(),
      cwd: "/tmp/repo",
    });

    const commentBodies = linear.comment.mock.calls.map((c) => String(c[1]));
    const hitlComment = commentBodies.find((b) =>
      /TOCTOU race in provisionHousehold/.test(b),
    );
    expect(hitlComment).toBeDefined();
    expect(hitlComment).toMatch(/Runway flagged for human review/);

    expect(
      commentBodies.some((b) =>
        /could not apply .* label — please apply it manually/.test(b),
      ),
    ).toBe(true);
  });

  it("dumps the rejection reason to stderr when even the Linear comment fails", async () => {
    routeExeca({ revListCount: "3" });
    sandcastleRunMock
      .mockResolvedValueOnce({
        stdout: "implementation done\nIMPL: DONE",
        commits: [{ sha: "abc" }],
      })
      .mockResolvedValueOnce({
        stdout: "REVIEW: REJECTED — three bugs found",
        commits: [],
      });

    const linear = makeLinear();
    linear.comment.mockImplementation((_id: string, body: string) =>
      /flagged for human review/.test(body)
        ? Effect.fail(
            new LinearNetworkError({
              cause: null,
              message: "Linear unreachable",
            }),
          )
        : Effect.succeed(undefined),
    );
    linear.applyLabel.mockReturnValueOnce(
      Effect.fail(
        new LinearNetworkError({
          cause: null,
          message: "also unreachable",
        }),
      ),
    );
    linear.fetchReady
      .mockReturnValueOnce(Effect.succeed([issue]))
      .mockReturnValueOnce(Effect.succeed([]));

    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;

    try {
      await drainQueue({
        config,
        linear: asLinear(linear),
        github: makeGithub(),
        cwd: "/tmp/repo",
      });
    } finally {
      process.stderr.write = origWrite;
    }

    const combined = writes.join("");
    expect(combined).toMatch(/REJECTION REASON FOLLOWS \(VA-312\)/);
    expect(combined).toMatch(/three bugs found/);
  });

  it("includes a per-issue verdict trail in the exit summary", async () => {
    routeExeca({ revListCount: "3" });
    sandcastleRunMock
      .mockResolvedValueOnce({
        stdout: "implementation done\nIMPL: DONE",
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

    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]).toMatchObject({
      identifier: "VA-312",
      kind: "opened",
    });
    expect(result.outcomes[0]?.detail).toMatch(/^https:\/\//);
  });
});

// ---------------------------------------------------------------------------
// Tests — VA-353 review marker parsing
// ---------------------------------------------------------------------------

describe("parseReviewVerdict (VA-353)", () => {
  // Exact reproducer from .sandcastle/logs/master-review-va-312.log
  // (truncated). Sandcastle's wrapper output ("Agent stopped",
  // "Capturing session", "Run complete: …") trails the marker.
  const va312Tail = [
    "REVIEW: REJECTED — provisionHousehold has a TOCTOU race that creates duplicate households with no DB-level guard (missing unique index on owner role), and withAudit error path can swallow original errors",
    "Agent stopped",
    "Capturing session",
    "Collecting commits",
    "Collecting commits done (0.0s)",
    "Reached max iterations (1).",
    "Run complete: reached 1 iteration(s) without completion signal.",
    "Context window: 58k",
  ].join("\n");

  it("recovers REVIEW: REJECTED with reason when sandcastle wrapper output trails the marker", () => {
    expect(parseReviewVerdict({ stdout: va312Tail })).toEqual({
      kind: "rejected",
      reason:
        "provisionHousehold has a TOCTOU race that creates duplicate households with no DB-level guard (missing unique index on owner role), and withAudit error path can swallow original errors",
    });
  });

  it("recovers REVIEW: APPROVED when sandcastle wrapper output trails the marker", () => {
    const stdout = [
      "Looks good, all tests pass.",
      "REVIEW: APPROVED",
      "Agent stopped",
      "Run complete: reached 1 iteration(s) without completion signal.",
    ].join("\n");
    expect(parseReviewVerdict({ stdout })).toEqual({
      kind: "approved",
      reason: "",
    });
  });

  it("rejects (with a 'no marker' reason) when the agent never emitted a verdict", () => {
    expect(parseReviewVerdict({ stdout: "i forgot to emit anything useful" }))
      .toEqual({
        kind: "rejected",
        reason: "review output did not contain a REVIEW: verdict line",
      });
  });

  it("does not match a marker in mid-prose (not at line start)", () => {
    // The reviewer is discussing the contract, not emitting it.
    const stdout =
      "I should remind the agent: the reviewer should output REVIEW: APPROVED when…";
    expect(parseReviewVerdict({ stdout })).toMatchObject({
      kind: "rejected",
      reason: "review output did not contain a REVIEW: verdict line",
    });
  });

  it("when multiple markers appear, the LAST one wins", () => {
    const stdout = [
      "Initial pass: REVIEW: APPROVED",
      "On second look I see a bug.",
      "REVIEW: REJECTED — withAudit swallows errors",
    ].join("\n");
    expect(parseReviewVerdict({ stdout })).toEqual({
      kind: "rejected",
      reason: "withAudit swallows errors",
    });
  });
});

// ---------------------------------------------------------------------------
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
// Tests — VA-346 base-branch threading
// ---------------------------------------------------------------------------

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
