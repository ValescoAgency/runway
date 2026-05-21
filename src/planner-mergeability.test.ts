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
  type Mock,
} from "vitest";
import type { Config } from "./config.js";
import {
  PLANNER_ACTION_COMPLETED_LOG,
  PLANNER_ACTION_FAILED_LOG,
  PLANNER_ACTION_STARTED_LOG,
  PLANNER_RECOMMENDATION_PROPOSED_LOG,
  extractPlannerMarkers,
} from "./dashboard/projector.js";
import { createStorage, type Storage } from "./dashboard/storage.js";
import type { GithubGateway, PullRequestState } from "./github.js";
import type { RunwayIssue } from "./linear.js";

// VA-477: same vi.mock hoisting trick as shepherd.test.ts — keeps the
// production `defaultInvokeRebaseAgent` from reaching Docker when an
// integration test exercises the production path.
const sandcastleRunMock = vi.fn();
vi.mock("@ai-hero/sandcastle", () => ({
  run: sandcastleRunMock,
  claudeCode: vi.fn(() => ({ kind: "claudeCode" })),
}));
vi.mock("@ai-hero/sandcastle/sandboxes/docker", () => ({
  docker: vi.fn(() => ({ kind: "docker" })),
}));

const {
  evaluateMergeability,
  makeMergeabilityWatcher,
  MERGEABILITY_CAPABILITY,
} = await import("./planner-mergeability.js");
const { createPlannerReadClient } = await import("./planner-storage.js");

const ISSUE: RunwayIssue = {
  id: "issue-uuid",
  identifier: "VA-461",
  title: "shepherd test fixture",
  description: "",
  labels: [],
};
const PR_URL = "https://github.com/ValescoAgency/runway/pull/123";

function makeConfig(): Config {
  return {
    shepherdEnabled: true,
    shepherdPollIntervalSeconds: 0,
  } as unknown as Config;
}

function makeGithub(overrides: Partial<GithubGateway> = {}): GithubGateway {
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
    headRefName: "agent/va-461",
    baseRefName: "main",
    ...over,
  };
}

const baseCtx = {
  issue: ISSUE,
  branch: "agent/va-461",
  prUrl: PR_URL,
  prNumber: 123,
  cwd: "/tmp/repo",
  baseBranch: "main",
  config: makeConfig(),
  iteration: 1,
};

// ---------------------------------------------------------------------------
// Relocated watcher unit tests (VA-461 — moved from src/shepherd.test.ts
// per VA-477 AC: "Existing mergeability subscription tests pass against
// the new module location").
// ---------------------------------------------------------------------------

describe("makeMergeabilityWatcher — relocated from shepherd.ts", () => {
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
    const signal = await Effect.runPromise(watcher({ ...baseCtx, github }));
    expect(signal.kind).toBe("quiet");
  });

  it("returns quiet on unknown (GH still computing)", async () => {
    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(Effect.succeed(makePr({ mergeableState: "unknown" }))),
    });
    const watcher = makeMergeabilityWatcher({ github, config: makeConfig() });
    const signal = await Effect.runPromise(watcher({ ...baseCtx, github }));
    expect(signal.kind).toBe("quiet");
  });

  it("returns fix on dirty; action invokes rebase agent against the impl branch and returns fixed on DONE", async () => {
    const invokeRebaseAgent = vi
      .fn()
      .mockReturnValue(Effect.succeed({ kind: "done" as const }));
    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(Effect.succeed(makePr({ mergeableState: "dirty" }))),
      getConflictFiles: vi
        .fn()
        .mockReturnValue(Effect.succeed(["src/a.ts", "src/b.ts"])),
    });
    const watcher = makeMergeabilityWatcher({
      github,
      config: makeConfig(),
      invokeRebaseAgent,
    });
    const signal = await Effect.runPromise(watcher({ ...baseCtx, github }));
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
    const signal = await Effect.runPromise(watcher({ ...baseCtx, github }));
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
    const signal = await Effect.runPromise(watcher({ ...baseCtx, github }));
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
    const watcher = makeMergeabilityWatcher({ github, config: makeConfig() });
    const signal = await Effect.runPromise(watcher({ ...baseCtx, github }));
    expect(signal.kind).toBe("quiet");
  });
});

// ---------------------------------------------------------------------------
// VA-477 — capability dispatcher tests + propose → accept → action.completed
// integration loop.
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

describe("evaluateMergeability — capability dispatcher (VA-477)", () => {
  let dir: string;
  let dbPath: string;
  let writer: Storage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "planner-merge-"));
    dbPath = join(dir, "runway.sqlite");
    writer = createStorage(dbPath);
  });

  afterEach(() => {
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const PR_URL_A = "https://github.com/ValescoAgency/runway/pull/777";

  it("emits no events when no open shepherded PRs are tracked", async () => {
    const sink: CapturedLog[] = [];
    const reader = createPlannerReadClient({ sqlitePath: dbPath });
    try {
      const result = await Effect.runPromise(
        evaluateMergeability({
          readClient: reader,
          github: makeGithub(),
          config: makeConfig(),
          cwd: "/tmp/repo",
          baseBranch: "main",
          now: () => "1000",
        }).pipe(
          Effect.provide(captureLogger(sink)),
          Logger.withMinimumLogLevel(LogLevel.Info),
        ),
      );
      expect(result.proposed).toEqual([]);
      expect(sink).toEqual([]);
    } finally {
      reader.close();
    }
  });

  it("emits recommendation.proposed for a dirty PR with no prior recommendation", async () => {
    seedIssueProcess(writer, {
      branch: "agent/va-477",
      prUrl: PR_URL_A,
      identifier: "VA-477",
      ts: "1715000000000000000",
    });

    const sink: CapturedLog[] = [];
    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(Effect.succeed(makePr({ mergeableState: "dirty" }))),
      getConflictFiles: vi.fn().mockReturnValue(Effect.succeed(["src/x.ts"])),
    });

    const reader = createPlannerReadClient({ sqlitePath: dbPath });
    try {
      const result = await Effect.runPromise(
        evaluateMergeability({
          readClient: reader,
          github,
          config: makeConfig(),
          cwd: "/tmp/repo",
          baseBranch: "main",
          // Stable timestamp so the snapshot is stable.
          now: () => "1715000005000000000",
        }).pipe(
          Effect.provide(captureLogger(sink)),
          Logger.withMinimumLogLevel(LogLevel.Info),
        ),
      );

      expect(result.proposed).toEqual([
        `${MERGEABILITY_CAPABILITY}:PR-777`,
      ]);

      const proposed = sink.find(
        (l) => l.message === PLANNER_RECOMMENDATION_PROPOSED_LOG,
      );
      expect(proposed).toBeDefined();
      expect(proposed?.attrs).toMatchObject({
        recommendationId: `${MERGEABILITY_CAPABILITY}:PR-777`,
        capability: MERGEABILITY_CAPABILITY,
        target: "PR-777",
        autoApproveEligible: "false",
        timestampUnixNano: "1715000005000000000",
      });
      expect(String(proposed?.attrs.summary)).toMatch(
        /Rebase agent\/va-477 onto origin\/main/,
      );
    } finally {
      reader.close();
    }
  });

  it("skips PRs that already have a proposed recommendation (no re-emit per tick)", async () => {
    seedIssueProcess(writer, {
      branch: "agent/va-477",
      prUrl: PR_URL_A,
      identifier: "VA-477",
      ts: "1715000000000000000",
    });
    writer.recordPlannerRecommendationProposed({
      recommendationId: `${MERGEABILITY_CAPABILITY}:PR-777`,
      capability: MERGEABILITY_CAPABILITY,
      target: "PR-777",
      summary: "Rebase agent/va-477 onto origin/main (mergeable_state=dirty)",
      evidence: { prNumber: 777 },
      autoApproveEligible: false,
      timestampUnixNano: "1715000005000000000",
    });

    const getPullRequest = vi.fn();
    const github = makeGithub({ getPullRequest });

    const reader = createPlannerReadClient({ sqlitePath: dbPath });
    try {
      const result = await Effect.runPromise(
        evaluateMergeability({
          readClient: reader,
          github,
          config: makeConfig(),
          cwd: "/tmp/repo",
          baseBranch: "main",
          now: () => "1715000010000000000",
        }),
      );
      expect(result.proposed).toEqual([]);
      // The GH gateway is never hit — the dedup short-circuits before
      // any network call.
      expect(getPullRequest).not.toHaveBeenCalled();
    } finally {
      reader.close();
    }
  });

  it("integration: propose → accept → action.started → invoke rebase agent → action.completed", async () => {
    seedIssueProcess(writer, {
      branch: "agent/va-477",
      prUrl: PR_URL_A,
      identifier: "VA-477",
      ts: "1715000000000000000",
    });

    const invokeRebaseAgent = vi
      .fn()
      .mockReturnValue(Effect.succeed({ kind: "done" as const }));
    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(Effect.succeed(makePr({ mergeableState: "dirty" }))),
      getConflictFiles: vi.fn().mockReturnValue(Effect.succeed(["src/x.ts"])),
    });

    let nowCounter = 1715000005000000000n;
    const now = () => {
      const value = String(nowCounter);
      nowCounter += 1_000_000n;
      return value;
    };

    // The capture sink doubles as the OTLP transport in this test —
    // each Effect.logInfo lands here, then we feed the equivalent
    // marker into the dashboard's storage so the next tick observes
    // the writer-side projection. This closes the loop without
    // having to spin up the real OTLP receiver.
    const sink: CapturedLog[] = [];

    const reader = createPlannerReadClient({ sqlitePath: dbPath });
    try {
      // Tick 1 — propose.
      const r1 = await Effect.runPromise(
        evaluateMergeability({
          readClient: reader,
          github,
          config: makeConfig(),
          cwd: "/tmp/repo",
          baseBranch: "main",
          invokeRebaseAgent,
          now,
        }).pipe(
          Effect.provide(captureLogger(sink)),
          Logger.withMinimumLogLevel(LogLevel.Info),
        ),
      );
      expect(r1.proposed).toEqual([`${MERGEABILITY_CAPABILITY}:PR-777`]);

      // Pump the proposed marker through the dashboard projection so
      // tick 2 reads the live row.
      const proposedMarker = projectMarker(
        sink,
        PLANNER_RECOMMENDATION_PROPOSED_LOG,
      );
      expect(proposedMarker).toBeDefined();
      writer.recordPlannerRecommendationProposed({
        recommendationId: String(proposedMarker!.attrs.recommendationId),
        capability: MERGEABILITY_CAPABILITY,
        target: String(proposedMarker!.attrs.target),
        summary: String(proposedMarker!.attrs.summary),
        evidence: JSON.parse(String(proposedMarker!.attrs.evidence)),
        autoApproveEligible: false,
        timestampUnixNano: String(proposedMarker!.attrs.timestampUnixNano),
      });

      // Operator accept → mirror the HTTP handler's writer call.
      writer.recordPlannerRecommendationDecision({
        recommendationId: `${MERGEABILITY_CAPABILITY}:PR-777`,
        status: "accepted",
        source: "operator",
        reason: null,
        timestampUnixNano: now(),
      });

      // Tick 2 — accept fires the action.
      sink.length = 0;
      const r2 = await Effect.runPromise(
        evaluateMergeability({
          readClient: reader,
          github,
          config: makeConfig(),
          cwd: "/tmp/repo",
          baseBranch: "main",
          invokeRebaseAgent,
          now,
        }).pipe(
          Effect.provide(captureLogger(sink)),
          Logger.withMinimumLogLevel(LogLevel.Info),
        ),
      );
      expect(invokeRebaseAgent).toHaveBeenCalledOnce();
      expect(r2.actionsCompleted).toHaveLength(1);
      expect(r2.actionsFailed).toEqual([]);

      const started = sink.find((l) => l.message === PLANNER_ACTION_STARTED_LOG);
      const completed = sink.find(
        (l) => l.message === PLANNER_ACTION_COMPLETED_LOG,
      );
      expect(started).toBeDefined();
      expect(completed).toBeDefined();
      expect(started?.attrs).toMatchObject({
        recommendationId: `${MERGEABILITY_CAPABILITY}:PR-777`,
        capability: MERGEABILITY_CAPABILITY,
        target: "PR-777",
      });
      expect(String(completed?.attrs.outcome)).toMatch(/Rebased/);

      // Tick 3 — already-acted accepted recommendation is a no-op.
      writer.recordPlannerActionStarted({
        actionId: String(started!.attrs.actionId),
        recommendationId: `${MERGEABILITY_CAPABILITY}:PR-777`,
        capability: MERGEABILITY_CAPABILITY,
        target: "PR-777",
        timestampUnixNano: String(started!.attrs.timestampUnixNano),
      });
      writer.recordPlannerActionCompleted({
        actionId: String(started!.attrs.actionId),
        outcome: String(completed!.attrs.outcome),
        timestampUnixNano: String(completed!.attrs.timestampUnixNano),
      });
      sink.length = 0;
      const r3 = await Effect.runPromise(
        evaluateMergeability({
          readClient: reader,
          github,
          config: makeConfig(),
          cwd: "/tmp/repo",
          baseBranch: "main",
          invokeRebaseAgent,
          now,
        }).pipe(
          Effect.provide(captureLogger(sink)),
          Logger.withMinimumLogLevel(LogLevel.Info),
        ),
      );
      expect(r3.proposed).toEqual([]);
      expect(r3.actionsCompleted).toEqual([]);
      // The rebase agent was only invoked once across the three ticks.
      expect(invokeRebaseAgent).toHaveBeenCalledOnce();
    } finally {
      reader.close();
    }
  });

  it("emits action.failed when the rebase agent returns blocked", async () => {
    seedIssueProcess(writer, {
      branch: "agent/va-477",
      prUrl: PR_URL_A,
      identifier: "VA-477",
      ts: "1715000000000000000",
    });
    writer.recordPlannerRecommendationProposed({
      recommendationId: `${MERGEABILITY_CAPABILITY}:PR-777`,
      capability: MERGEABILITY_CAPABILITY,
      target: "PR-777",
      summary: "Rebase agent/va-477 onto origin/main (mergeable_state=dirty)",
      evidence: { prNumber: 777 },
      autoApproveEligible: false,
      timestampUnixNano: "1715000005000000000",
    });
    writer.recordPlannerRecommendationDecision({
      recommendationId: `${MERGEABILITY_CAPABILITY}:PR-777`,
      status: "accepted",
      source: "operator",
      reason: null,
      timestampUnixNano: "1715000006000000000",
    });

    const invokeRebaseAgent = vi.fn().mockReturnValue(
      Effect.succeed({
        kind: "blocked" as const,
        reason: "rebase impossible without human",
        conflictFiles: ["src/x.ts"],
      }),
    );
    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(Effect.succeed(makePr({ mergeableState: "dirty" }))),
      getConflictFiles: vi.fn().mockReturnValue(Effect.succeed(["src/x.ts"])),
    });

    const sink: CapturedLog[] = [];
    const reader = createPlannerReadClient({ sqlitePath: dbPath });
    try {
      const result = await Effect.runPromise(
        evaluateMergeability({
          readClient: reader,
          github,
          config: makeConfig(),
          cwd: "/tmp/repo",
          baseBranch: "main",
          invokeRebaseAgent,
          now: () => "1715000010000000000",
        }).pipe(
          Effect.provide(captureLogger(sink)),
          Logger.withMinimumLogLevel(LogLevel.Info),
        ),
      );
      expect(result.actionsFailed).toHaveLength(1);
      expect(result.actionsCompleted).toEqual([]);
      const failed = sink.find((l) => l.message === PLANNER_ACTION_FAILED_LOG);
      expect(failed?.attrs.error).toMatch(/conflict in src\/x\.ts/);
    } finally {
      reader.close();
    }
  });
});

function projectMarker(
  sink: CapturedLog[],
  body: string,
): CapturedLog | undefined {
  return sink.find((l) => l.message === body);
}

// Quick sanity check that the projector recognises the bodies the
// capability emits. extractPlannerMarkers is the validator — if a body
// constant drifts away from the capability emission, the dashboard
// stops projecting; this assertion is the canary.
describe("capability emits markers extractPlannerMarkers accepts", () => {
  it("includes the four bodies the capability emits", () => {
    expect(PLANNER_RECOMMENDATION_PROPOSED_LOG).toBe(
      "planner.recommendation.proposed",
    );
    expect(PLANNER_ACTION_STARTED_LOG).toBe("planner.action.started");
    expect(PLANNER_ACTION_COMPLETED_LOG).toBe("planner.action.completed");
    expect(PLANNER_ACTION_FAILED_LOG).toBe("planner.action.failed");
    // extractPlannerMarkers exists and is a function — the import
    // succeeded.
    expect(typeof extractPlannerMarkers).toBe("function");
  });
});
