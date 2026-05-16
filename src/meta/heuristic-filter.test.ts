import { describe, expect, it } from "vitest";
import type { RunReviewContext } from "./context.js";
import type {
  CapturedCodingAgentReport,
  CapturedIssueProcess,
  CapturedReviewerReport,
} from "./dashboard-read.js";
import {
  DEFAULT_META_FILTER_THRESHOLDS,
  shouldRunIRA,
} from "./heuristic-filter.js";

// VA-404: each trip condition gets a fixture; the clean one-iteration
// merged run case asserts the skip path. Defaults are 3 iterations / 2
// reviewer-rejection proxy.

const baseIp = (over: Partial<CapturedIssueProcess> = {}): CapturedIssueProcess => ({
  traceId: "trace-abc",
  spanId: "span-ip",
  issueIdentifier: "VA-401",
  issueId: "issue-1",
  issueTitle: "test",
  issueLabels: [],
  branch: "agent/x",
  outcomeKind: "opened",
  outcomeDetail: null,
  prUrl: "https://example.com/pr/1",
  hitlReason: null,
  startTimeUnixNano: "1",
  endTimeUnixNano: "2",
  ...over,
});

const okAgent = (iterationIndex: number): CapturedCodingAgentReport => ({
  ok: true,
  iterationIndex,
  templateVersion: "1.0.0",
  payload: "{}",
});

const okReviewer = (): CapturedReviewerReport => ({
  ok: true,
  templateVersion: "1.0.0",
  payload: "{}",
});

const ctxOf = (
  ip: CapturedIssueProcess,
  agent: CapturedCodingAgentReport = okAgent(1),
  reviewer: CapturedReviewerReport = okReviewer(),
): RunReviewContext => ({
  issueProcess: ip,
  codingAgentReport: agent,
  reviewerReport: reviewer,
  hindsightSignals: null,
  norms: null,
});

describe("shouldRunIRA (VA-404)", () => {
  it("skips a clean one-iteration merged run", () => {
    const d = shouldRunIRA(ctxOf(baseIp({ outcomeKind: "opened" }), okAgent(1)));
    expect(d.run).toBe(false);
    expect(d.reason).toMatch(/clean run/);
  });

  it("trips on iteration count >= 3 (default)", () => {
    const d = shouldRunIRA(ctxOf(baseIp({ outcomeKind: "opened" }), okAgent(3)));
    expect(d.run).toBe(true);
    expect(d.reason).toMatch(/iteration count 3/);
  });

  it("trips on retry triggered (Sub-agent review rejected prefix)", () => {
    const d = shouldRunIRA(
      ctxOf(
        baseIp({
          outcomeKind: "hitl",
          outcomeDetail: "Sub-agent review rejected: missing tests",
        }),
        okAgent(1),
      ),
    );
    expect(d.run).toBe(true);
    expect(d.reason).toMatch(/retry triggered/);
  });

  it("trips on HITL escape", () => {
    const d = shouldRunIRA(
      ctxOf(
        baseIp({ outcomeKind: "hitl", outcomeDetail: "needs human review" }),
        okAgent(1),
      ),
    );
    expect(d.run).toBe(true);
    expect(d.reason).toMatch(/HITL escape/);
  });

  it("trips on revert outcome", () => {
    const d = shouldRunIRA(ctxOf(baseIp({ outcomeKind: "reverted" })));
    expect(d.run).toBe(true);
    expect(d.reason).toMatch(/revert outcome/);
  });

  it("trips on infra-error outcome", () => {
    const d = shouldRunIRA(ctxOf(baseIp({ outcomeKind: "errored" })));
    expect(d.run).toBe(true);
    expect(d.reason).toMatch(/infra-error/);
  });

  it("trips on reviewer-rejected proxy (HITL + iterations >= 2)", () => {
    const d = shouldRunIRA(
      ctxOf(
        baseIp({ outcomeKind: "hitl", outcomeDetail: "stuck" }),
        okAgent(2),
      ),
    );
    expect(d.run).toBe(true);
    expect(d.reason).toMatch(/reviewer-rejection proxy/);
  });

  it("trips when the agent report is missing (can't verify cleanliness)", () => {
    const d = shouldRunIRA(
      ctxOf(baseIp({ outcomeKind: "opened" }), {
        ok: false,
        kind: "missing",
        message: "no impl-iter spans",
      }),
    );
    expect(d.run).toBe(true);
    expect(d.reason).toMatch(/coding agent report missing/);
  });

  it("respects custom thresholds — minIterationCount=2 trips on 2", () => {
    const d = shouldRunIRA(
      ctxOf(baseIp({ outcomeKind: "opened" }), okAgent(2)),
      { ...DEFAULT_META_FILTER_THRESHOLDS, minIterationCount: 2 },
    );
    expect(d.run).toBe(true);
    expect(d.reason).toMatch(/iteration count 2/);
  });

  it("respects custom thresholds — minIterationCount=10 lets a 3-iter run skip", () => {
    const d = shouldRunIRA(
      ctxOf(baseIp({ outcomeKind: "opened" }), okAgent(3)),
      { ...DEFAULT_META_FILTER_THRESHOLDS, minIterationCount: 10 },
    );
    expect(d.run).toBe(false);
  });
});
