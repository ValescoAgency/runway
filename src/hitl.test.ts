import { Effect, Redacted } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import type { FailureRoutingDeps } from "./hitl.js";
import {
  LinearNetworkError,
  LinearNotFound,
  type LinearGateway,
  type RunwayIssue,
} from "./linear.js";

// VA-355 + VA-358 + VA-423: focused tests for the failure-routing
// module. These hit flagHitl and handleProcessFailure directly — not
// via drainQueue — so the assertions describe each function's contract
// rather than the composer's end-to-end behaviour.
//
// VA-423 collapsed the revert-vs-HITL fork into a single flagHitl
// path: every per-issue failure (startup OR mid-run) lands on
// `ready-for-human`. Runway no longer re-applies `ready-for-agent`
// because terminal failures shouldn't retry indefinitely.

const { flagHitl, handleProcessFailure } = await import("./hitl.js");

const run = <A>(eff: Effect.Effect<A, never, never>) => Effect.runPromise(eff);

type MockedLinear = {
  applyLabel: ReturnType<typeof vi.fn>;
  removeLabel: ReturnType<typeof vi.fn>;
  comment: ReturnType<typeof vi.fn>;
};

function makeLinear(): MockedLinear {
  return {
    applyLabel: vi.fn().mockReturnValue(Effect.succeed(undefined)),
    removeLabel: vi.fn().mockReturnValue(Effect.succeed({ removed: true })),
    comment: vi.fn().mockReturnValue(Effect.succeed(undefined)),
  };
}

function asLinear(m: MockedLinear): LinearGateway {
  return m as unknown as LinearGateway;
}

const config: Config = {
  linearApiKey: Redacted.make("test-key"),
  linearTeam: "VA",
  readyLabel: "ready-for-agent",
  hitlLabel: "ready-for-human",
  maxIterations: 1,
  implTurns: 1,
  reviewRetries: 0,
  metaReviewModel: "claude-sonnet-4-6",
  metaProjectName: "runway-meta",
  shepherdEnabled: false,
  shepherdPollIntervalSeconds: 15,
  shepherdMaxIterations: 3,
  shepherdMaxWallSeconds: 3600,
  plannerTickSeconds: 30,
  plannerHost: "127.0.0.1",
  plannerPort: 3002,
};

const issue: RunwayIssue = {
  id: "issue-123",
  identifier: "VA-312",
  title: "Test issue",
  description: "test",
  labels: [],
};

function depsWith(linear: MockedLinear): FailureRoutingDeps {
  return {
    config,
    linear: asLinear(linear),
  };
}

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
    expect(linear.applyLabel).toHaveBeenCalledWith(
      "issue-123",
      "ready-for-human",
    );
  });

  it("posts a follow-up note when the label apply fails — the substantive reason still landed", async () => {
    const linear = makeLinear();
    linear.applyLabel.mockReturnValueOnce(
      Effect.fail(
        new LinearNotFound({
          resource: "label",
          identifier: "ready-for-human",
          message: 'Linear label "ready-for-human" not found on team xyz',
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

describe("handleProcessFailure (VA-358 + VA-423)", () => {
  it("flags HITL with `ready-for-human` on any failure (startup OR mid-run — no revert path)", async () => {
    const linear = makeLinear();

    const outcome = await run(
      handleProcessFailure(
        new Error("missing image"),
        issue,
        depsWith(linear),
      ),
    );

    expect(outcome).toEqual({ kind: "errored", detail: "missing image" });
    // VA-423 AC: failures flip to `ready-for-human`; runway does NOT
    // re-apply `ready-for-agent`.
    expect(linear.applyLabel).toHaveBeenCalledWith(
      "issue-123",
      "ready-for-human",
    );
    expect(linear.applyLabel).not.toHaveBeenCalledWith(
      "issue-123",
      "ready-for-agent",
    );

    // The HITL comment carries the error detail.
    const bodies = linear.comment.mock.calls.map((c) => String(c[1]));
    expect(bodies.some((b) => /missing image/.test(b))).toBe(true);
  });

  it("treats a mid-run crash identically — no separate revert branch", async () => {
    const linear = makeLinear();

    const outcome = await run(
      handleProcessFailure(
        new Error("review pass crashed"),
        issue,
        depsWith(linear),
      ),
    );

    expect(outcome).toEqual({
      kind: "errored",
      detail: "review pass crashed",
    });
    expect(linear.applyLabel).toHaveBeenCalledWith(
      "issue-123",
      "ready-for-human",
    );
  });
});
