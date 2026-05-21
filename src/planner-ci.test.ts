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
  CheckRun,
  GithubGateway,
  PullRequestState,
} from "./github.js";
import type { RunwayIssue } from "./linear.js";

// VA-478: same vi.mock hoisting as planner-mergeability.test.ts so the
// production `defaultInvokeCiFixAgent` path doesn't reach Docker if a
// test omits its stub.
const sandcastleRunMock = vi.fn();
vi.mock("@ai-hero/sandcastle", () => ({
  run: sandcastleRunMock,
  claudeCode: vi.fn(() => ({ kind: "claudeCode" })),
}));
vi.mock("@ai-hero/sandcastle/sandboxes/docker", () => ({
  docker: vi.fn(() => ({ kind: "docker" })),
}));

const {
  CI_CAPABILITY,
  evaluateCi,
  hashLogTail,
  makeCiWatcher,
  parseCiFixVerdict,
  sanitiseCheckName,
} = await import("./planner-ci.js");
const { createPlannerReadClient } = await import("./planner-storage.js");

const ISSUE: RunwayIssue = {
  id: "issue-uuid",
  identifier: "VA-462",
  title: "ci watcher fixture",
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
    getCheckRuns: vi.fn(),
    getRequiredChecks: vi.fn(),
    getCheckRunLogTail: vi.fn(),
    ...overrides,
  } as unknown as GithubGateway;
}

function makePr(over: Partial<PullRequestState> = {}): PullRequestState {
  return {
    number: 123,
    mergeableState: "clean",
    merged: false,
    headSha: "abc1234",
    headRefName: "agent/va-462",
    baseRefName: "main",
    ...over,
  };
}

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

const baseCtx = {
  issue: ISSUE,
  branch: "agent/va-462",
  prUrl: PR_URL,
  prNumber: 123,
  cwd: "/tmp/repo",
  baseBranch: "main",
  config: makeConfig(),
  iteration: 1,
};

// ---------------------------------------------------------------------------
// Relocated parseCiFixVerdict tests (VA-462 — moved from
// src/shepherd.test.ts per VA-478 AC).
// ---------------------------------------------------------------------------

describe("parseCiFixVerdict — relocated from shepherd.ts", () => {
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

// ---------------------------------------------------------------------------
// Relocated makeCiWatcher tests (VA-462) — same as before, just imports
// from planner-ci.js now.
// ---------------------------------------------------------------------------

describe("makeCiWatcher — relocated from shepherd.ts", () => {
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
      getRequiredChecks: vi
        .fn()
        .mockReturnValue(Effect.succeed(["pnpm test", "pnpm typecheck"])),
      getCheckRunLogTail: vi.fn().mockReturnValue(Effect.succeed(logTail)),
    });
    const watcher = makeCiWatcher({
      github,
      config: makeConfig(),
      invokeCiFixAgent,
    });
    const signal = await Effect.runPromise(watcher({ ...baseCtx, github }));
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
      getRequiredChecks: vi
        .fn()
        .mockReturnValue(Effect.succeed(["pnpm test"])),
      getCheckRunLogTail: vi.fn(),
    });
    const watcher = makeCiWatcher({
      github,
      config: makeConfig(),
      invokeCiFixAgent,
    });
    const signal = await Effect.runPromise(watcher({ ...baseCtx, github }));
    expect(signal.kind).toBe("quiet");
    expect(invokeCiFixAgent).not.toHaveBeenCalled();
  });

  it("(c) same required check fails 3× consecutively (across SHAs) → hitl with canonical reason", async () => {
    const invokeCiFixAgent = vi
      .fn()
      .mockReturnValue(Effect.succeed({ kind: "done" as const }));
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
    const watcher = makeCiWatcher({
      github,
      config: makeConfig(),
      invokeCiFixAgent,
    });

    const t1 = await Effect.runPromise(watcher({ ...baseCtx, github }));
    expect(t1.kind).toBe("fix");
    const t2 = await Effect.runPromise(
      watcher({ ...baseCtx, github, iteration: 2 }),
    );
    expect(t2.kind).toBe("fix");
    const t3 = await Effect.runPromise(
      watcher({ ...baseCtx, github, iteration: 3 }),
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
    const watcher = makeCiWatcher({
      github,
      config: makeConfig(),
      invokeCiFixAgent,
    });

    const t1 = await Effect.runPromise(watcher({ ...baseCtx, github }));
    expect(t1.kind).toBe("fix");
    const t2 = await Effect.runPromise(
      watcher({ ...baseCtx, github, iteration: 2 }),
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
    const signal = await Effect.runPromise(watcher({ ...baseCtx, github }));
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
    const watcher = makeCiWatcher({
      github,
      config: makeConfig(),
      invokeCiFixAgent,
    });
    const signal = await Effect.runPromise(watcher({ ...baseCtx, github }));
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
    const watcher = makeCiWatcher({
      github,
      config: makeConfig(),
      invokeCiFixAgent,
    });
    const signal = await Effect.runPromise(watcher({ ...baseCtx, github }));
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
// VA-478 — capability dispatcher tests + integration loop.
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

describe("evaluateCi — capability dispatcher (VA-478)", () => {
  let dir: string;
  let dbPath: string;
  let writer: Storage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "planner-ci-"));
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
        evaluateCi({
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

  it("emits recommendation.proposed with check name + logTailExcerpt in evidence", async () => {
    seedIssueProcess(writer, {
      branch: "agent/va-478",
      prUrl: PR_URL_A,
      identifier: "VA-478",
      ts: "1715000000000000000",
    });

    const logTail =
      "FAIL src/foo.test.ts\nExpected 1 to equal 2\n  at line 42 in foo.test.ts";
    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(
          Effect.succeed(makePr({ headSha: "head1", merged: false })),
        ),
      getCheckRuns: vi
        .fn()
        .mockReturnValue(
          Effect.succeed([makeCheckRun({ name: "pnpm test", runId: 99 })]),
        ),
      getRequiredChecks: vi.fn().mockReturnValue(Effect.succeed(["pnpm test"])),
      getCheckRunLogTail: vi.fn().mockReturnValue(Effect.succeed(logTail)),
    });

    const sink: CapturedLog[] = [];
    const reader = createPlannerReadClient({ sqlitePath: dbPath });
    try {
      const result = await Effect.runPromise(
        evaluateCi({
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

      const expectedHash = hashLogTail(logTail);
      const expectedId = `${CI_CAPABILITY}:PR-777:${sanitiseCheckName("pnpm test")}:${expectedHash}`;
      expect(result.proposed).toEqual([expectedId]);

      const proposed = sink.find(
        (l) => l.message === PLANNER_RECOMMENDATION_PROPOSED_LOG,
      );
      expect(proposed).toBeDefined();
      expect(proposed?.attrs).toMatchObject({
        recommendationId: expectedId,
        capability: CI_CAPABILITY,
        target: "PR-777",
        autoApproveEligible: "true",
      });
      expect(String(proposed?.attrs.summary)).toMatch(/Re-impl after CI failure/);
      const evidence = JSON.parse(String(proposed?.attrs.evidence));
      expect(evidence).toMatchObject({
        prNumber: 777,
        checkName: "pnpm test",
        headSha: "head1",
      });
      expect(evidence.logTailExcerpt).toMatch(/at line 42/);
    } finally {
      reader.close();
    }
  });

  it("dedups identical failures via stable recommendation_id (same hash → existing row → skip)", async () => {
    seedIssueProcess(writer, {
      branch: "agent/va-478",
      prUrl: PR_URL_A,
      identifier: "VA-478",
      ts: "1715000000000000000",
    });

    const logTail = "FAIL same-error";
    const expectedHash = hashLogTail(logTail);
    const expectedId = `${CI_CAPABILITY}:PR-777:${sanitiseCheckName("pnpm test")}:${expectedHash}`;
    writer.recordPlannerRecommendationProposed({
      recommendationId: expectedId,
      capability: CI_CAPABILITY,
      target: "PR-777",
      summary: "Re-impl after CI failure in `pnpm test`",
      evidence: {},
      autoApproveEligible: false,
      timestampUnixNano: "1715000005000000000",
    });

    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(
          Effect.succeed(makePr({ headSha: "head1", merged: false })),
        ),
      getCheckRuns: vi
        .fn()
        .mockReturnValue(
          Effect.succeed([makeCheckRun({ name: "pnpm test" })]),
        ),
      getRequiredChecks: vi.fn().mockReturnValue(Effect.succeed(["pnpm test"])),
      getCheckRunLogTail: vi.fn().mockReturnValue(Effect.succeed(logTail)),
    });

    const reader = createPlannerReadClient({ sqlitePath: dbPath });
    try {
      const result = await Effect.runPromise(
        evaluateCi({
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

  it("different log-tail hash → new recommendation row", async () => {
    seedIssueProcess(writer, {
      branch: "agent/va-478",
      prUrl: PR_URL_A,
      identifier: "VA-478",
      ts: "1715000000000000000",
    });

    // Seed an older recommendation with hash for "FAIL old-error".
    const oldHash = hashLogTail("FAIL old-error");
    writer.recordPlannerRecommendationProposed({
      recommendationId: `${CI_CAPABILITY}:PR-777:${sanitiseCheckName("pnpm test")}:${oldHash}`,
      capability: CI_CAPABILITY,
      target: "PR-777",
      summary: "old",
      evidence: {},
      autoApproveEligible: false,
      timestampUnixNano: "1715000000000000000",
    });

    // Current failure: a NEW log tail.
    const newLogTail = "FAIL different-error";
    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(
          Effect.succeed(makePr({ headSha: "head2", merged: false })),
        ),
      getCheckRuns: vi
        .fn()
        .mockReturnValue(
          Effect.succeed([makeCheckRun({ name: "pnpm test" })]),
        ),
      getRequiredChecks: vi.fn().mockReturnValue(Effect.succeed(["pnpm test"])),
      getCheckRunLogTail: vi.fn().mockReturnValue(Effect.succeed(newLogTail)),
    });

    const reader = createPlannerReadClient({ sqlitePath: dbPath });
    try {
      const result = await Effect.runPromise(
        evaluateCi({
          readClient: reader,
          github,
          config: makeConfig(),
          cwd: "/tmp/repo",
          baseBranch: "main",
          now: () => "1715000010000000000",
        }),
      );
      expect(result.proposed).toHaveLength(1);
      const newHash = hashLogTail(newLogTail);
      expect(result.proposed[0]).toBe(
        `${CI_CAPABILITY}:PR-777:${sanitiseCheckName("pnpm test")}:${newHash}`,
      );
    } finally {
      reader.close();
    }
  });

  it("optional-only failures emit a planner.ci.optional_failure log but no recommendation", async () => {
    seedIssueProcess(writer, {
      branch: "agent/va-478",
      prUrl: PR_URL_A,
      identifier: "VA-478",
      ts: "1715000000000000000",
    });

    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(Effect.succeed(makePr({ merged: false }))),
      getCheckRuns: vi
        .fn()
        .mockReturnValue(
          Effect.succeed([makeCheckRun({ name: "optional-lint" })]),
        ),
      getRequiredChecks: vi
        .fn()
        .mockReturnValue(Effect.succeed(["pnpm test"])),
      getCheckRunLogTail: vi.fn(),
    });

    const sink: CapturedLog[] = [];
    const reader = createPlannerReadClient({ sqlitePath: dbPath });
    try {
      const result = await Effect.runPromise(
        evaluateCi({
          readClient: reader,
          github,
          config: makeConfig(),
          cwd: "/tmp/repo",
          baseBranch: "main",
          now: () => "1715000010000000000",
        }).pipe(
          Effect.provide(captureLogger(sink)),
          Logger.withMinimumLogLevel(LogLevel.Info),
        ),
      );
      expect(result.proposed).toEqual([]);
      const opt = sink.find((l) => l.message === "planner.ci.optional_failure");
      expect(opt).toBeDefined();
      expect(String(opt?.attrs.checks)).toMatch(/optional-lint/);
    } finally {
      reader.close();
    }
  });

  it("integration: propose → accept → action.started → invoke CI fix agent → action.completed", async () => {
    seedIssueProcess(writer, {
      branch: "agent/va-478",
      prUrl: PR_URL_A,
      identifier: "VA-478",
      ts: "1715000000000000000",
    });

    const logTail = "FAIL src/x.test.ts\nExpected error";
    const invokeCiFixAgent = vi
      .fn()
      .mockReturnValue(Effect.succeed({ kind: "done" as const }));
    const github = makeGithub({
      getPullRequest: vi
        .fn()
        .mockReturnValue(
          Effect.succeed(makePr({ headSha: "h1", merged: false })),
        ),
      getCheckRuns: vi
        .fn()
        .mockReturnValue(
          Effect.succeed([makeCheckRun({ name: "pnpm test", runId: 42 })]),
        ),
      getRequiredChecks: vi.fn().mockReturnValue(Effect.succeed(["pnpm test"])),
      getCheckRunLogTail: vi.fn().mockReturnValue(Effect.succeed(logTail)),
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
        evaluateCi({
          readClient: reader,
          github,
          config: makeConfig(),
          cwd: "/tmp/repo",
          baseBranch: "main",
          invokeCiFixAgent,
          now,
        }).pipe(
          Effect.provide(captureLogger(sink)),
          Logger.withMinimumLogLevel(LogLevel.Info),
        ),
      );
      const expectedHash = hashLogTail(logTail);
      const expectedId = `${CI_CAPABILITY}:PR-777:${sanitiseCheckName("pnpm test")}:${expectedHash}`;
      expect(r1.proposed).toEqual([expectedId]);

      const proposedMarker = sink.find(
        (l) => l.message === PLANNER_RECOMMENDATION_PROPOSED_LOG,
      )!;
      writer.recordPlannerRecommendationProposed({
        recommendationId: String(proposedMarker.attrs.recommendationId),
        capability: CI_CAPABILITY,
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

      // Tick 2 — fire the action.
      sink.length = 0;
      const r2 = await Effect.runPromise(
        evaluateCi({
          readClient: reader,
          github,
          config: makeConfig(),
          cwd: "/tmp/repo",
          baseBranch: "main",
          invokeCiFixAgent,
          now,
        }).pipe(
          Effect.provide(captureLogger(sink)),
          Logger.withMinimumLogLevel(LogLevel.Info),
        ),
      );
      expect(invokeCiFixAgent).toHaveBeenCalledOnce();
      expect(r2.actionsCompleted).toHaveLength(1);
      expect(r2.actionsFailed).toEqual([]);

      const started = sink.find((l) => l.message === PLANNER_ACTION_STARTED_LOG)!;
      const completed = sink.find(
        (l) => l.message === PLANNER_ACTION_COMPLETED_LOG,
      )!;
      expect(started.attrs).toMatchObject({
        recommendationId: expectedId,
        capability: CI_CAPABILITY,
        target: "PR-777",
      });
      expect(String(completed.attrs.outcome)).toMatch(/Re-impl after `pnpm test`/);

      // Tick 3 — once an action has fired for this rec, the
      // dispatcher leaves it alone.
      writer.recordPlannerActionStarted({
        actionId: String(started.attrs.actionId),
        recommendationId: expectedId,
        capability: CI_CAPABILITY,
        target: "PR-777",
        timestampUnixNano: String(started.attrs.timestampUnixNano),
      });
      writer.recordPlannerActionCompleted({
        actionId: String(started.attrs.actionId),
        outcome: String(completed.attrs.outcome),
        timestampUnixNano: String(completed.attrs.timestampUnixNano),
      });
      sink.length = 0;
      const r3 = await Effect.runPromise(
        evaluateCi({
          readClient: reader,
          github,
          config: makeConfig(),
          cwd: "/tmp/repo",
          baseBranch: "main",
          invokeCiFixAgent,
          now,
        }).pipe(
          Effect.provide(captureLogger(sink)),
          Logger.withMinimumLogLevel(LogLevel.Info),
        ),
      );
      expect(r3.proposed).toEqual([]);
      expect(r3.actionsCompleted).toEqual([]);
      expect(invokeCiFixAgent).toHaveBeenCalledOnce();
    } finally {
      reader.close();
    }
  });

  it("emits action.failed when the CI fix agent returns BLOCKED", async () => {
    seedIssueProcess(writer, {
      branch: "agent/va-478",
      prUrl: PR_URL_A,
      identifier: "VA-478",
      ts: "1715000000000000000",
    });

    const logTail = "FAIL src/x.test.ts";
    const expectedHash = hashLogTail(logTail);
    const expectedId = `${CI_CAPABILITY}:PR-777:${sanitiseCheckName("pnpm test")}:${expectedHash}`;
    writer.recordPlannerRecommendationProposed({
      recommendationId: expectedId,
      capability: CI_CAPABILITY,
      target: "PR-777",
      summary: "Re-impl after CI failure in `pnpm test`",
      evidence: {},
      autoApproveEligible: false,
      timestampUnixNano: "1715000000000000000",
    });
    writer.recordPlannerRecommendationDecision({
      recommendationId: expectedId,
      status: "accepted",
      source: "operator",
      reason: null,
      timestampUnixNano: "1715000001000000000",
    });

    const invokeCiFixAgent = vi.fn().mockReturnValue(
      Effect.succeed({
        kind: "blocked" as const,
        reason: "ambiguous failure",
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
      getCheckRunLogTail: vi.fn().mockReturnValue(Effect.succeed(logTail)),
    });

    const sink: CapturedLog[] = [];
    const reader = createPlannerReadClient({ sqlitePath: dbPath });
    try {
      const result = await Effect.runPromise(
        evaluateCi({
          readClient: reader,
          github,
          config: makeConfig(),
          cwd: "/tmp/repo",
          baseBranch: "main",
          invokeCiFixAgent,
          now: () => "1715000010000000000",
        }).pipe(
          Effect.provide(captureLogger(sink)),
          Logger.withMinimumLogLevel(LogLevel.Info),
        ),
      );
      expect(result.actionsFailed).toHaveLength(1);
      expect(result.actionsCompleted).toEqual([]);
      const failed = sink.find((l) => l.message === PLANNER_ACTION_FAILED_LOG);
      expect(failed?.attrs.error).toMatch(/CI fix BLOCKED in `pnpm test`/);
      expect(failed?.attrs.error).toMatch(/ambiguous failure/);
    } finally {
      reader.close();
    }
  });

  // VA-481 — mode gating
  it("manual mode → capability stays silent", async () => {
    seedIssueProcess(writer, {
      branch: "agent/va-481",
      prUrl: PR_URL_A,
      identifier: "VA-481",
      ts: "1715000000000000000",
    });
    writer.recordPlannerCapabilityModeChange({
      capability: "shepherd-ci",
      mode: "manual",
      updatedBy: "operator",
      timestampUnixNano: "1715000000000000000",
    });
    const github = makeGithub({ getPullRequest: vi.fn() });
    const reader = createPlannerReadClient({ sqlitePath: dbPath });
    try {
      const result = await Effect.runPromise(
        evaluateCi({
          readClient: reader,
          github,
          config: makeConfig(),
          cwd: "/tmp/repo",
          baseBranch: "main",
          now: () => "1715000010000000000",
        }),
      );
      expect(result.proposed).toEqual([]);
      // GH gateway never even called — capability returns before
      // hitting the read path.
      expect((github.getPullRequest as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    } finally {
      reader.close();
    }
  });

  it("auto mode → emits both proposed AND accepted (source=auto)", async () => {
    seedIssueProcess(writer, {
      branch: "agent/va-481",
      prUrl: PR_URL_A,
      identifier: "VA-481",
      ts: "1715000000000000000",
    });
    writer.recordPlannerCapabilityModeChange({
      capability: "shepherd-ci",
      mode: "auto",
      updatedBy: "operator",
      timestampUnixNano: "1715000000000000000",
    });
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
      getCheckRunLogTail: vi.fn().mockReturnValue(Effect.succeed("FAIL ci")),
    });
    const sink: CapturedLog[] = [];
    const reader = createPlannerReadClient({ sqlitePath: dbPath });
    try {
      await Effect.runPromise(
        evaluateCi({
          readClient: reader,
          github,
          config: makeConfig(),
          cwd: "/tmp/repo",
          baseBranch: "main",
          now: () => "1715000010000000000",
        }).pipe(
          Effect.provide(captureLogger(sink)),
          Logger.withMinimumLogLevel(LogLevel.Info),
        ),
      );
      const proposed = sink.find(
        (l) => l.message === PLANNER_RECOMMENDATION_PROPOSED_LOG,
      );
      const accepted = sink.find(
        (l) => l.message === "planner.recommendation.accepted",
      );
      expect(proposed?.attrs.autoApproveEligible).toBe("true");
      expect(accepted).toBeDefined();
      expect(accepted?.attrs.source).toBe("auto");
    } finally {
      reader.close();
    }
  });
});
