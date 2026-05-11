import { describe, expect, it } from "vitest";
import {
  buildIterationSummary,
  implementVars,
  renderPrompt,
  tailOfMessage,
} from "./prompts.js";

describe("buildIterationSummary (VA-349)", () => {
  it("includes the iteration count, commit log, and tail of the last message", () => {
    const out = buildIterationSummary({
      iterationsRun: 2,
      commits: "abc Add foo\ndef Wire bar",
      finalMessageTail: "All tests pass.",
    });
    expect(out).toContain("already completed 2 iteration(s)");
    expect(out).toContain("abc Add foo");
    expect(out).toContain("All tests pass.");
    expect(out).toContain("Do **not** re-explore the repository");
  });

  it("substitutes a placeholder when commits / final-message tail are empty", () => {
    const out = buildIterationSummary({
      iterationsRun: 1,
      commits: "",
      finalMessageTail: "",
    });
    expect(out).toContain("(no commits yet)");
    expect(out).toContain("(no output captured)");
  });
});

describe("tailOfMessage", () => {
  it("returns the input unchanged when shorter than the cap", () => {
    expect(tailOfMessage("hello", 50)).toBe("hello");
  });

  it("keeps the LAST maxChars when input exceeds the cap, prefixed with a marker", () => {
    const out = tailOfMessage("a".repeat(100) + "TAIL", 10);
    expect(out.endsWith("aaaaaaTAIL")).toBe(true);
    expect(out).toContain("earlier output truncated");
  });
});

describe("implementVars / renderPrompt with PREVIOUS_ITERATIONS", () => {
  const issue = {
    id: "1",
    identifier: "VA-1",
    title: "test",
    description: "do the thing",
  };

  it("defaults PREVIOUS_ITERATIONS to empty string on iteration 1", () => {
    const vars = implementVars(issue);
    expect(vars.PREVIOUS_ITERATIONS).toBe("");
  });

  it("renders the prior summary into the {{PREVIOUS_ITERATIONS}} slot", () => {
    const template =
      "before\n{{PREVIOUS_ITERATIONS}}\nafter — {{ISSUE_IDENTIFIER}}";
    const vars = implementVars(issue, { previousIterations: "PRIOR-SUMMARY" });
    const out = renderPrompt(template, vars);
    expect(out).toBe("before\nPRIOR-SUMMARY\nafter — VA-1");
  });
});
