import { Effect, Redacted } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import type { FailureRoutingDeps } from "./hitl.js";
import {
  LinearNetworkError,
  LinearNotFound,
  type LinearGateway,
  type RunwayIssue,
} from "./linear.js";

// VA-355 + VA-358: focused tests for the failure-routing module.
// These hit flagHitl and handleProcessFailure directly — not via
// drainQueue — so the assertions describe each function's contract
// rather than the composer's end-to-end behaviour.
const execaMock = vi.fn();
vi.mock("execa", () => ({ execa: execaMock }));

const { flagHitl, handleProcessFailure } = await import("./hitl.js");

const run = <A>(eff: Effect.Effect<A, never, never>) => Effect.runPromise(eff);

type MockedLinear = {
  transition: ReturnType<typeof vi.fn>;
  applyLabel: ReturnType<typeof vi.fn>;
  comment: ReturnType<typeof vi.fn>;
};

function makeLinear(): MockedLinear {
  return {
    transition: vi.fn().mockReturnValue(Effect.succeed(undefined)),
    applyLabel: vi.fn().mockReturnValue(Effect.succeed(undefined)),
    comment: vi.fn().mockReturnValue(Effect.succeed(undefined)),
  };
}

function asLinear(m: MockedLinear): LinearGateway {
  return m as unknown as LinearGateway;
}

const config: Config = {
  linearApiKey: Redacted.make("test-key"),
  linearTeam: "VA",
  readyStatus: "Todo",
  inProgressStatus: "In Progress",
  inReviewStatus: "In Review",
  hitlLabel: "needs-human",
  maxIterations: 1,
  implTurns: 1,
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

// FailureRoutingDeps is the wider shape — it structurally satisfies
// HitlDeps too, so flagHitl tests can pass it without ceremony.
function depsWith(linear: MockedLinear): FailureRoutingDeps {
  return {
    config,
    linear: asLinear(linear),
    cwd: "/tmp/repo",
    baseBranch: "main",
  };
}

beforeEach(() => {
  execaMock.mockReset();
});

describe("flagHitl (VA-355)", () => {
  it("posts the rejection reason as a comment BEFORE applying the label, so a missing label doesn't swallow the reason", async () => {
    const linear = makeLinear();
    await run(flagHitl(issue, depsWith(linear), "TOCTOU race in provisionHousehold"));

    // Ordering: comment fires before label apply.
    const commentOrder = linear.comment.mock.invocationCallOrder[0];
    const labelOrder = linear.applyLabel.mock.invocationCallOrder[0];
    expect(commentOrder).toBeDefined();
    expect(labelOrder).toBeDefined();
    expect(commentOrder).toBeLessThan(labelOrder!);

    // Comment body carries the substantive reason.
    const commentBody = String(linear.comment.mock.calls[0]?.[1]);
    expect(commentBody).toMatch(/Runway flagged for human review/);
    expect(commentBody).toMatch(/TOCTOU race in provisionHousehold/);

    // Label applied with the configured value.
    expect(linear.applyLabel).toHaveBeenCalledWith("issue-123", "needs-human");
  });

  it("posts a follow-up note when the label apply fails — the substantive reason still landed", async () => {
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

    await run(flagHitl(issue, depsWith(linear), "three substantive bugs"));

    const bodies = linear.comment.mock.calls.map((c) => String(c[1]));
    // The first comment carries the HITL reason; a follow-up note
    // tells the operator to apply the label manually.
    expect(bodies[0]).toMatch(/three substantive bugs/);
    expect(
      bodies.some((b) =>
        /could not apply .* label — please apply it manually/.test(b),
      ),
    ).toBe(true);
  });

  it("dumps the rejection reason to stderr when even the Linear comment fails", async () => {
    const linear = makeLinear();
    linear.comment.mockReturnValue(
      Effect.fail(
        new LinearNetworkError({ cause: null, message: "Linear unreachable" }),
      ),
    );
    linear.applyLabel.mockReturnValue(
      Effect.fail(
        new LinearNetworkError({ cause: null, message: "also unreachable" }),
      ),
    );

    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;

    try {
      await run(flagHitl(issue, depsWith(linear), "three bugs found"));
    } finally {
      process.stderr.write = origWrite;
    }

    const combined = writes.join("");
    expect(combined).toMatch(/REJECTION REASON FOLLOWS \(VA-312\)/);
    expect(combined).toMatch(/three bugs found/);
  });
});

describe("handleProcessFailure (VA-342 + VA-358)", () => {
  // Default execa router: only the rev-list count call matters here.
  function routeExeca(revListCount: string): void {
    execaMock.mockImplementation((bin: string, args: readonly string[]) => {
      if (bin !== "git" || args[0] !== "rev-list") {
        return Promise.reject(
          new Error(`unexpected execa call: ${bin} ${args.join(" ")}`),
        );
      }
      return Promise.resolve({ exitCode: 0, stdout: revListCount });
    });
  }

  it("reverts to readyStatus when the agent produced no commits — infrastructure failure", async () => {
    routeExeca("0");
    const linear = makeLinear();

    const outcome = await run(
      handleProcessFailure(
        new Error("missing image"),
        issue,
        depsWith(linear),
        "agent/va-312",
      ),
    );

    expect(outcome).toEqual({ kind: "reverted", detail: "missing image" });

    // Revert transition fired, no HITL label.
    expect(linear.transition).toHaveBeenCalledWith("issue-123", "Todo");
    expect(linear.applyLabel).not.toHaveBeenCalled();

    // The revert comment names the destination state.
    const commentBody = String(linear.comment.mock.calls[0]?.[1]);
    expect(commentBody).toMatch(/reverting to .*Todo/);
    expect(commentBody).toMatch(/missing image/);
  });

  it("flags HITL when the agent crashed after producing commits — mid-run failure stays In Progress", async () => {
    routeExeca("3");
    const linear = makeLinear();

    const outcome = await run(
      handleProcessFailure(
        new Error("review pass crashed"),
        issue,
        depsWith(linear),
        "agent/va-312",
      ),
    );

    expect(outcome).toEqual({ kind: "errored", detail: "review pass crashed" });

    // No revert transition — the issue stays In Progress so the human
    // reviewer can pick up where the agent left off.
    expect(linear.transition).not.toHaveBeenCalled();

    // HITL label applied via flagHitl.
    expect(linear.applyLabel).toHaveBeenCalledWith("issue-123", "needs-human");

    // The HITL comment carries the error detail.
    const bodies = linear.comment.mock.calls.map((c) => String(c[1]));
    expect(bodies.some((b) => /review pass crashed/.test(b))).toBe(true);
  });

  it("treats a git rev-list failure as no commits (defensive revert path)", async () => {
    // If we can't ask git whether commits exist, assume not — that
    // routes to revert rather than stranding the issue In Progress.
    execaMock.mockImplementation(() =>
      Promise.reject(new Error("git binary missing")),
    );
    const linear = makeLinear();

    const outcome = await run(
      handleProcessFailure(
        new Error("agent kaboom"),
        issue,
        depsWith(linear),
        "agent/va-312",
      ),
    );

    expect(outcome.kind).toBe("reverted");
    expect(linear.transition).toHaveBeenCalledWith("issue-123", "Todo");
    expect(linear.applyLabel).not.toHaveBeenCalled();
  });
});
