import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LinearGateway, RunwayIssue } from "./linear.js";
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
}));

const { drainQueue } = await import("./orchestrator.js");

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
  return {
    fetchReady: vi.fn(),
    transition: vi.fn().mockResolvedValue(undefined),
    applyLabel: vi.fn().mockResolvedValue(undefined),
    comment: vi.fn().mockResolvedValue(undefined),
  };
}

function asLinear(m: MockedLinear): LinearGateway {
  return m as unknown as LinearGateway;
}

function makeGithub(): GithubGateway {
  return {
    pushBranch: vi.fn().mockResolvedValue(undefined),
    openPullRequest: vi.fn().mockResolvedValue("https://example/pr/1"),
  };
}

const config: Config = {
  linearApiKey: "test-key",
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
// returns `origin/main`; rev-list returns whatever the test sets.
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
      .mockResolvedValueOnce([issue])
      .mockResolvedValueOnce([]); // queue drains after the failed attempt

    const result = await drainQueue({
      config,
      linear: asLinear(linear),
      github: makeGithub(),
      cwd: "/tmp/repo",
    });

    expect(result).toEqual({ processed: 0, opened: 0, hitl: 0, errored: 1 });

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
      .mockResolvedValueOnce([issue])
      .mockResolvedValueOnce([]);

    const result = await drainQueue({
      config,
      linear: asLinear(linear),
      github: makeGithub(),
      cwd: "/tmp/repo",
    });

    expect(result).toEqual({ processed: 0, opened: 0, hitl: 0, errored: 1 });

    // Only the original In Progress transition — no revert.
    const transitions = linear.transition.mock.calls.map((c) => c[1]);
    expect(transitions).toEqual(["In Progress"]);

    // HITL label applied on a mid-run failure.
    expect(linear.applyLabel).toHaveBeenCalledWith("issue-123", "needs-human");
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
      .mockResolvedValueOnce([issue])
      .mockResolvedValueOnce([]);

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
