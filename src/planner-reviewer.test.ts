import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, HashMap, Logger, LogLevel } from "effect";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Config } from "./config.js";
import {
  PLANNER_ACTION_COMPLETED_LOG,
  PLANNER_ACTION_FAILED_LOG,
  PLANNER_ACTION_STARTED_LOG,
  PLANNER_RECOMMENDATION_PROPOSED_LOG,
} from "./dashboard/projector.js";
import { createStorage, type Storage } from "./dashboard/storage.js";
import type {
  GithubGateway,
  PrComment,
  PullRequestState,
} from "./github.js";
import type { RunwayIssue } from "./linear.js";

const sandcastleRunMock = vi.fn();
vi.mock("@ai-hero/sandcastle", () => ({
  run: sandcastleRunMock,
  claudeCode: vi.fn(() => ({ kind: "claudeCode" })),
}));
vi.mock("@ai-hero/sandcastle/sandboxes/docker", () => ({
  docker: vi.fn(() => ({ kind: "docker" })),
}));

const {
  evaluateReviewer,
  parsePrReviewVerdict,
  parseReviewerResponseVerdict,
  REVIEWER_CAPABILITY,
} = await import("./planner-reviewer.js");
const { createPlannerReadClient } = await import("./planner-storage.js");

const ISSUE: RunwayIssue = {
  id: "issue-uuid",
  identifier: "VA-463",
  title: "reviewer test fixture",
  description: "",
  labels: [],
};
const PR_URL = "https://github.com/ValescoAgency/runway/pull/123";

function makeConfig(over: Partial<Config> = {}): Config {
  return {
    prReviewerBotLogin: "review-bot",
    ...over,
  } as unknown as Config;
}

function makeGithub(overrides: Partial<GithubGateway> = {}): GithubGateway {
  return {
    pushBranch: vi.fn(),
    openPullRequest: vi.fn(),
    getPullRequest: vi.fn(),
    getPullRequestComments: vi.fn(),
    ...overrides,
  } as unknown as GithubGateway;
}

function makePr(over: Partial<PullRequestState> = {}): PullRequestState {
  return {
    number: 123,
    mergeableState: "clean",
    merged: false,
    headSha: "abc1234",
    headRefName: "agent/va-463",
    baseRefName: "main",
    ...over,
  };
}

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

const baseCtx = {
  issue: ISSUE,
  branch: "agent/va-463",
  prUrl: PR_URL,
  prNumber: 123,
  cwd: "/tmp/repo",
  baseBranch: "main",
  config: makeConfig(),
  iteration: 1,
};

// ---------------------------------------------------------------------------
// Relocated parsers + watcher unit tests (VA-463 — moved from
// shepherd.test.ts per VA-479 AC).
// ---------------------------------------------------------------------------

describe("parsePrReviewVerdict — relocated", () => {
  it("recognises APPROVED", () => {
    expect(parsePrReviewVerdict("REVIEW: APPROVED")).toEqual({
      kind: "approved",
    });
  });

  it("recognises CHANGES-REQUESTED with em-dash fix line", () => {
    const r = parsePrReviewVerdict(
      "Look at this thing.\nREVIEW: CHANGES-REQUESTED — add null check in src/foo.ts",
    );
    expect(r.kind).toBe("changes-requested");
    if (r.kind === "changes-requested") {
      expect(r.fix).toBe("add null check in src/foo.ts");
    }
  });

  it("recognises NEEDS-DISCUSSION", () => {
    const r = parsePrReviewVerdict("REVIEW: NEEDS-DISCUSSION — broader design");
    expect(r.kind).toBe("needs-discussion");
    if (r.kind === "needs-discussion") expect(r.decision).toBe("broader design");
  });

  it("returns none when no REVIEW: marker", () => {
    expect(parsePrReviewVerdict("just a status update").kind).toBe("none");
  });

  it("picks the LAST occurrence when multiple", () => {
    const r = parsePrReviewVerdict(
      "REVIEW: APPROVED\nthen on second look\nREVIEW: CHANGES-REQUESTED — change after all",
    );
    expect(r.kind).toBe("changes-requested");
  });
});

describe("parseReviewerResponseVerdict — relocated", () => {
  it("recognises IMPL: DONE", () => {
    expect(parseReviewerResponseVerdict("IMPL: DONE").kind).toBe("done");
  });
  it("recognises IMPL: BLOCKED with reason", () => {
    const r = parseReviewerResponseVerdict("IMPL: BLOCKED — out of scope");
    expect(r.kind).toBe("blocked");
    if (r.kind === "blocked") expect(r.reason).toMatch(/out of scope/);
  });
  it("blocks when no marker", () => {
    expect(parseReviewerResponseVerdict("rambling output").kind).toBe("blocked");
  });
});


// ---------------------------------------------------------------------------
// VA-479 — capability dispatcher tests + integration loop.
// ---------------------------------------------------------------------------

interface CapturedLog {
  readonly message: string;
  readonly attrs: Record<string, unknown>;
}

const captureLogger = (sink: CapturedLog[]) =>
  Logger.replace(
    Logger.defaultLogger,
    Logger.make((options) => {
      const msg = Array.isArray(options.message)
        ? options.message.join(" ")
        : String(options.message);
      const attrs: Record<string, unknown> = {};
      for (const [k, v] of HashMap.toEntries(options.annotations)) {
        attrs[k] = v;
      }
      sink.push({ message: msg, attrs });
    }),
  );

const PR_URL_A = "https://github.com/ValescoAgency/runway/pull/777";

const seedIssueProcess = (
  writer: Storage,
  args: { branch: string; prUrl: string; identifier: string; ts: string },
) => {
  writer.saveIssueProcess({
    traceId: `trace-${args.identifier}`,
    spanId: `span-${args.identifier}`,
    parentSpanId: null,
    issueIdentifier: args.identifier,
    issueId: `id-${args.identifier}`,
    issueTitle: `Title ${args.identifier}`,
    issueLabels: ["agent"],
    branch: args.branch,
    outcomeKind: "opened",
    outcomeDetail: args.prUrl,
    prUrl: args.prUrl,
    hitlReason: null,
    startTimeUnixNano: args.ts,
    endTimeUnixNano: args.ts,
    statusCode: 1,
    statusMessage: null,
  });
};

describe("evaluateReviewer — capability dispatcher (VA-479)", () => {
  let dir: string;
  let dbPath: string;
  let writer: Storage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "planner-reviewer-"));
    dbPath = join(dir, "runway.sqlite");
    writer = createStorage(dbPath);
  });

  afterEach(() => {
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits no events when no open shepherded PRs are tracked", async () => {
    const reader = createPlannerReadClient({ sqlitePath: dbPath });
    try {
      const result = await Effect.runPromise(
        evaluateReviewer({
          readClient: reader,
          github: makeGithub(),
          config: makeConfig(),
          cwd: "/tmp/repo",
          baseBranch: "main",
          now: () => "1000",
        }),
      );
      expect(result.proposed).toEqual([]);
    } finally {
      reader.close();
    }
  });

  it("bot CHANGES-REQUESTED comment → recommendation with parsed fix as summary", async () => {
    seedIssueProcess(writer, {
      branch: "agent/va-479",
      prUrl: PR_URL_A,
      identifier: "VA-479",
      ts: "1715000000000000000",
    });

    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(Effect.succeed(makePr({ merged: false }))),
      getPullRequestComments: vi.fn().mockReturnValue(
        Effect.succeed([
          makeComment({
            id: 7,
            authorLogin: "review-bot",
            body: "REVIEW: CHANGES-REQUESTED — wrap the null path with a guard",
          }),
        ]),
      ),
    });

    const sink: CapturedLog[] = [];
    const reader = createPlannerReadClient({ sqlitePath: dbPath });
    try {
      const result = await Effect.runPromise(
        evaluateReviewer({
          readClient: reader,
          github,
          config: makeConfig(),
          cwd: "/tmp/repo",
          baseBranch: "main",
          now: () => "1715000005000000000",
        }).pipe(
          Effect.provide(captureLogger(sink)),
          Logger.withMinimumLogLevel(LogLevel.Info),
        ),
      );

      const expectedId = `${REVIEWER_CAPABILITY}:PR-777:comment-7`;
      expect(result.proposed).toEqual([expectedId]);

      const proposed = sink.find(
        (l) => l.message === PLANNER_RECOMMENDATION_PROPOSED_LOG,
      );
      expect(proposed?.attrs).toMatchObject({
        recommendationId: expectedId,
        capability: REVIEWER_CAPABILITY,
        target: "PR-777",
      });
      const evidence = JSON.parse(String(proposed?.attrs.evidence));
      expect(evidence).toMatchObject({
        prNumber: 777,
        commentId: 7,
        commentAuthor: "review-bot",
        mode: "fix-request",
        fix: "wrap the null path with a guard",
      });
      expect(String(proposed?.attrs.summary)).toMatch(/CHANGES-REQUESTED/);
      expect(String(proposed?.attrs.summary)).toMatch(/wrap the null path/);
    } finally {
      reader.close();
    }
  });

  it("bot APPROVED comment → no recommendation", async () => {
    seedIssueProcess(writer, {
      branch: "agent/va-479",
      prUrl: PR_URL_A,
      identifier: "VA-479",
      ts: "1715000000000000000",
    });

    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(Effect.succeed(makePr({ merged: false }))),
      getPullRequestComments: vi.fn().mockReturnValue(
        Effect.succeed([
          makeComment({
            id: 8,
            authorLogin: "review-bot",
            body: "REVIEW: APPROVED",
          }),
        ]),
      ),
    });

    const reader = createPlannerReadClient({ sqlitePath: dbPath });
    try {
      const result = await Effect.runPromise(
        evaluateReviewer({
          readClient: reader,
          github,
          config: makeConfig(),
          cwd: "/tmp/repo",
          baseBranch: "main",
          now: () => "1715000005000000000",
        }),
      );
      expect(result.proposed).toEqual([]);
    } finally {
      reader.close();
    }
  });

  it("ambiguous human comment → recommendation w/ LLM interpretation in evidence", async () => {
    seedIssueProcess(writer, {
      branch: "agent/va-479",
      prUrl: PR_URL_A,
      identifier: "VA-479",
      ts: "1715000000000000000",
    });

    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(Effect.succeed(makePr({ merged: false }))),
      getPullRequestComments: vi.fn().mockReturnValue(
        Effect.succeed([
          makeComment({
            id: 9,
            authorLogin: "alice",
            body:
              "Hmm — I think this is racy under concurrent access? Could you guard with a mutex or use the existing lock helper?",
          }),
        ]),
      ),
    });

    const interpretComment = vi.fn().mockReturnValue(
      Effect.succeed({
        summary: "Guard mutated state with the existing lock helper",
        rationale:
          "Reviewer flagged a race; suggests using the project's existing lock helper to serialize access.",
      }),
    );

    const sink: CapturedLog[] = [];
    const reader = createPlannerReadClient({ sqlitePath: dbPath });
    try {
      const result = await Effect.runPromise(
        evaluateReviewer({
          readClient: reader,
          github,
          config: makeConfig(),
          cwd: "/tmp/repo",
          baseBranch: "main",
          interpretComment,
          now: () => "1715000005000000000",
        }).pipe(
          Effect.provide(captureLogger(sink)),
          Logger.withMinimumLogLevel(LogLevel.Info),
        ),
      );

      const expectedId = `${REVIEWER_CAPABILITY}:PR-777:comment-9`;
      expect(result.proposed).toEqual([expectedId]);
      expect(interpretComment).toHaveBeenCalledOnce();
      expect(interpretComment.mock.calls[0]![0]).toMatchObject({
        commentAuthor: "alice",
        commentSource: "issue",
      });

      const proposed = sink.find(
        (l) => l.message === PLANNER_RECOMMENDATION_PROPOSED_LOG,
      );
      expect(String(proposed?.attrs.summary)).toBe(
        "Guard mutated state with the existing lock helper",
      );
      const evidence = JSON.parse(String(proposed?.attrs.evidence));
      expect(evidence).toMatchObject({
        mode: "verbatim",
        commentAuthor: "alice",
        interpretationRationale: expect.stringContaining("race"),
      });
      expect(evidence.commentBody).toMatch(/concurrent access/);
    } finally {
      reader.close();
    }
  });

  it("integration: bot CHANGES-REQUESTED → accept → invoke reviewer-response agent → action.completed", async () => {
    seedIssueProcess(writer, {
      branch: "agent/va-479",
      prUrl: PR_URL_A,
      identifier: "VA-479",
      ts: "1715000000000000000",
    });

    const invokeReviewerResponseAgent = vi
      .fn()
      .mockReturnValue(Effect.succeed({ kind: "done" as const }));
    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(Effect.succeed(makePr({ merged: false }))),
      getPullRequestComments: vi.fn().mockReturnValue(
        Effect.succeed([
          makeComment({
            id: 10,
            authorLogin: "review-bot",
            body: "REVIEW: CHANGES-REQUESTED — return early when input is null",
          }),
        ]),
      ),
    });

    let counter = 1715000005000000000n;
    const now = () => {
      const v = String(counter);
      counter += 1_000_000n;
      return v;
    };

    const sink: CapturedLog[] = [];
    const reader = createPlannerReadClient({ sqlitePath: dbPath });
    try {
      // Tick 1 — propose.
      const r1 = await Effect.runPromise(
        evaluateReviewer({
          readClient: reader,
          github,
          config: makeConfig(),
          cwd: "/tmp/repo",
          baseBranch: "main",
          invokeReviewerResponseAgent,
          now,
        }).pipe(
          Effect.provide(captureLogger(sink)),
          Logger.withMinimumLogLevel(LogLevel.Info),
        ),
      );
      const expectedId = `${REVIEWER_CAPABILITY}:PR-777:comment-10`;
      expect(r1.proposed).toEqual([expectedId]);

      const proposedMarker = sink.find(
        (l) => l.message === PLANNER_RECOMMENDATION_PROPOSED_LOG,
      )!;
      writer.recordPlannerRecommendationProposed({
        recommendationId: String(proposedMarker.attrs.recommendationId),
        capability: REVIEWER_CAPABILITY,
        target: String(proposedMarker.attrs.target),
        summary: String(proposedMarker.attrs.summary),
        evidence: JSON.parse(String(proposedMarker.attrs.evidence)),
        autoApproveEligible: false,
        timestampUnixNano: String(proposedMarker.attrs.timestampUnixNano),
      });
      writer.recordPlannerRecommendationDecision({
        recommendationId: expectedId,
        status: "accepted",
        source: "operator",
        reason: null,
        timestampUnixNano: now(),
      });

      // Tick 2 — fire action.
      sink.length = 0;
      const r2 = await Effect.runPromise(
        evaluateReviewer({
          readClient: reader,
          github,
          config: makeConfig(),
          cwd: "/tmp/repo",
          baseBranch: "main",
          invokeReviewerResponseAgent,
          now,
        }).pipe(
          Effect.provide(captureLogger(sink)),
          Logger.withMinimumLogLevel(LogLevel.Info),
        ),
      );
      expect(invokeReviewerResponseAgent).toHaveBeenCalledOnce();
      expect(r2.actionsCompleted).toHaveLength(1);
      expect(r2.actionsFailed).toEqual([]);
      expect(invokeReviewerResponseAgent.mock.calls[0]![0]).toMatchObject({
        mode: {
          kind: "fix-request",
          fix: "return early when input is null",
        },
      });

      const started = sink.find((l) => l.message === PLANNER_ACTION_STARTED_LOG)!;
      const completed = sink.find(
        (l) => l.message === PLANNER_ACTION_COMPLETED_LOG,
      )!;
      expect(started.attrs.recommendationId).toBe(expectedId);
      expect(String(completed.attrs.outcome)).toMatch(/fix-request/i);
    } finally {
      reader.close();
    }
  });

  it("integration: ambiguous human comment → LLM interpretation → accept → action.completed", async () => {
    seedIssueProcess(writer, {
      branch: "agent/va-479",
      prUrl: PR_URL_A,
      identifier: "VA-479",
      ts: "1715000000000000000",
    });

    const invokeReviewerResponseAgent = vi
      .fn()
      .mockReturnValue(Effect.succeed({ kind: "done" as const }));
    const interpretComment = vi.fn().mockReturnValue(
      Effect.succeed({
        summary: "Switch the loop to a guarded for-of with break",
        rationale: "Reviewer worries about infinite iteration if cursor doesn't advance.",
      }),
    );
    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(Effect.succeed(makePr({ merged: false }))),
      getPullRequestComments: vi.fn().mockReturnValue(
        Effect.succeed([
          makeComment({
            id: 11,
            authorLogin: "bob",
            body: "I'm worried this while-loop could spin if the cursor doesn't move.",
          }),
        ]),
      ),
    });

    let counter = 1715000005000000000n;
    const now = () => {
      const v = String(counter);
      counter += 1_000_000n;
      return v;
    };

    const sink: CapturedLog[] = [];
    const reader = createPlannerReadClient({ sqlitePath: dbPath });
    try {
      const r1 = await Effect.runPromise(
        evaluateReviewer({
          readClient: reader,
          github,
          config: makeConfig(),
          cwd: "/tmp/repo",
          baseBranch: "main",
          invokeReviewerResponseAgent,
          interpretComment,
          now,
        }).pipe(
          Effect.provide(captureLogger(sink)),
          Logger.withMinimumLogLevel(LogLevel.Info),
        ),
      );
      const expectedId = `${REVIEWER_CAPABILITY}:PR-777:comment-11`;
      expect(r1.proposed).toEqual([expectedId]);

      const proposedMarker = sink.find(
        (l) => l.message === PLANNER_RECOMMENDATION_PROPOSED_LOG,
      )!;
      writer.recordPlannerRecommendationProposed({
        recommendationId: String(proposedMarker.attrs.recommendationId),
        capability: REVIEWER_CAPABILITY,
        target: String(proposedMarker.attrs.target),
        summary: String(proposedMarker.attrs.summary),
        evidence: JSON.parse(String(proposedMarker.attrs.evidence)),
        autoApproveEligible: false,
        timestampUnixNano: String(proposedMarker.attrs.timestampUnixNano),
      });
      writer.recordPlannerRecommendationDecision({
        recommendationId: expectedId,
        status: "accepted",
        source: "operator",
        reason: null,
        timestampUnixNano: now(),
      });

      sink.length = 0;
      const r2 = await Effect.runPromise(
        evaluateReviewer({
          readClient: reader,
          github,
          config: makeConfig(),
          cwd: "/tmp/repo",
          baseBranch: "main",
          invokeReviewerResponseAgent,
          interpretComment,
          now,
        }).pipe(
          Effect.provide(captureLogger(sink)),
          Logger.withMinimumLogLevel(LogLevel.Info),
        ),
      );
      expect(invokeReviewerResponseAgent).toHaveBeenCalledOnce();
      expect(r2.actionsCompleted).toHaveLength(1);
      // The action invocation uses verbatim mode (human author).
      expect(invokeReviewerResponseAgent.mock.calls[0]![0]).toMatchObject({
        mode: { kind: "verbatim", commentAuthor: "bob" },
      });
    } finally {
      reader.close();
    }
  });

  it("emits action.failed when reviewer-response agent returns BLOCKED", async () => {
    seedIssueProcess(writer, {
      branch: "agent/va-479",
      prUrl: PR_URL_A,
      identifier: "VA-479",
      ts: "1715000000000000000",
    });

    const recommendationId = `${REVIEWER_CAPABILITY}:PR-777:comment-12`;
    writer.recordPlannerRecommendationProposed({
      recommendationId,
      capability: REVIEWER_CAPABILITY,
      target: "PR-777",
      summary: "CHANGES-REQUESTED — out of scope",
      evidence: {},
      autoApproveEligible: false,
      timestampUnixNano: "1715000000000000000",
    });
    writer.recordPlannerRecommendationDecision({
      recommendationId,
      status: "accepted",
      source: "operator",
      reason: null,
      timestampUnixNano: "1715000001000000000",
    });

    const invokeReviewerResponseAgent = vi.fn().mockReturnValue(
      Effect.succeed({
        kind: "blocked" as const,
        reason: "scope ambiguous",
      }),
    );
    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(Effect.succeed(makePr({ merged: false }))),
      getPullRequestComments: vi.fn().mockReturnValue(
        Effect.succeed([
          makeComment({
            id: 12,
            authorLogin: "review-bot",
            body: "REVIEW: CHANGES-REQUESTED — refactor unrelated module",
          }),
        ]),
      ),
    });

    const sink: CapturedLog[] = [];
    const reader = createPlannerReadClient({ sqlitePath: dbPath });
    try {
      const result = await Effect.runPromise(
        evaluateReviewer({
          readClient: reader,
          github,
          config: makeConfig(),
          cwd: "/tmp/repo",
          baseBranch: "main",
          invokeReviewerResponseAgent,
          now: () => "1715000010000000000",
        }).pipe(
          Effect.provide(captureLogger(sink)),
          Logger.withMinimumLogLevel(LogLevel.Info),
        ),
      );
      expect(result.actionsFailed).toHaveLength(1);
      expect(result.actionsCompleted).toEqual([]);
      const failed = sink.find((l) => l.message === PLANNER_ACTION_FAILED_LOG);
      expect(String(failed?.attrs.error)).toMatch(/CHANGES-REQUESTED BLOCKED/);
      expect(String(failed?.attrs.error)).toMatch(/scope ambiguous/);
    } finally {
      reader.close();
    }
  });

  it("dedups already-proposed comment (re-tick does not re-emit)", async () => {
    seedIssueProcess(writer, {
      branch: "agent/va-479",
      prUrl: PR_URL_A,
      identifier: "VA-479",
      ts: "1715000000000000000",
    });
    const recommendationId = `${REVIEWER_CAPABILITY}:PR-777:comment-13`;
    writer.recordPlannerRecommendationProposed({
      recommendationId,
      capability: REVIEWER_CAPABILITY,
      target: "PR-777",
      summary: "already-known",
      evidence: {},
      autoApproveEligible: false,
      timestampUnixNano: "1715000000000000000",
    });

    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(Effect.succeed(makePr({ merged: false }))),
      getPullRequestComments: vi.fn().mockReturnValue(
        Effect.succeed([
          makeComment({
            id: 13,
            authorLogin: "review-bot",
            body: "REVIEW: CHANGES-REQUESTED — same as before",
          }),
        ]),
      ),
    });

    const reader = createPlannerReadClient({ sqlitePath: dbPath });
    try {
      const result = await Effect.runPromise(
        evaluateReviewer({
          readClient: reader,
          github,
          config: makeConfig(),
          cwd: "/tmp/repo",
          baseBranch: "main",
          now: () => "1715000010000000000",
        }),
      );
      expect(result.proposed).toEqual([]);
    } finally {
      reader.close();
    }
  });
});
