import { describe, expect, it } from "vitest";
import {
  formatInRunReviewerFeedback,
  formatPriorFeedback,
  renderImplementPrompt,
  renderReviewPrompt,
  renderShepherdCiFixPrompt,
  renderShepherdRebasePrompt,
  renderShepherdReviewFixPrompt,
  renderShepherdReviewRespondPrompt,
} from "./prompts.js";
import type { Policy } from "./policy.js";
import type { RunwayComment, RunwayIssue } from "./linear.js";

// VA-361: contract tests on the deep prompt API. The leaf helpers
// (load*, renderPrompt, *Vars, renderForbiddenPathsBullet) are now
// private — we assert at the seam callers actually use: "given this
// issue + policy + state, the rendered string contains X."
//
// These tests read the real `prompts/implement.md` and
// `prompts/review.md` templates. That's intentional — if a template
// drops a placeholder, the corresponding substitution test fails
// loudly, which is the alert we want.

const issue: RunwayIssue = {
  id: "issue-1",
  identifier: "VA-312",
  title: "Fix the TOCTOU race in provisionHousehold",
  description: "Acceptance: add a unique index on owner role.",
  labels: [],
};

const policyWithPaths: Policy = {
  forbiddenPaths: [".env*", "*.pem"],
  source: "test",
};

const policyEmpty: Policy = {
  forbiddenPaths: [],
  source: "test",
};

describe("renderImplementPrompt (VA-361)", () => {
  it("substitutes the issue identifier, title, and description into the template", async () => {
    const out = await renderImplementPrompt({
      issue,
      policy: policyWithPaths,
      previousIterations: "",
      priorReviewFeedback: "",
    });
    expect(out).toContain("VA-312");
    expect(out).toContain("Fix the TOCTOU race in provisionHousehold");
    expect(out).toContain("Acceptance: add a unique index on owner role.");
  });

  it("falls back to `(no description)` when the issue description is empty", async () => {
    const out = await renderImplementPrompt({
      issue: { ...issue, description: "" },
      policy: policyEmpty,
      previousIterations: "",
      priorReviewFeedback: "",
    });
    expect(out).toContain("(no description)");
  });

  it("renders the policy's forbidden paths into the working-style bullet", async () => {
    const out = await renderImplementPrompt({
      issue,
      policy: policyWithPaths,
      previousIterations: "",
      priorReviewFeedback: "",
    });
    expect(out).toContain("`.env*`");
    expect(out).toContain("`*.pem`");
    expect(out).toContain("IMPL: BLOCKED");
  });

  it("emits the no-restriction sentence when forbiddenPaths is empty", async () => {
    const out = await renderImplementPrompt({
      issue,
      policy: policyEmpty,
      previousIterations: "",
      priorReviewFeedback: "",
    });
    expect(out).toMatch(/No write-path restrictions/);
  });

  it("substitutes previousIterations into the {{PREVIOUS_ITERATIONS}} slot", async () => {
    const summary = "## Previous iterations\n\nDid stuff already.";
    const out = await renderImplementPrompt({
      issue,
      policy: policyWithPaths,
      previousIterations: summary,
      priorReviewFeedback: "",
    });
    expect(out).toContain("Did stuff already.");
  });

  it("leaves PREVIOUS_ITERATIONS empty when no summary is passed", async () => {
    const out = await renderImplementPrompt({
      issue,
      policy: policyWithPaths,
      previousIterations: "",
      priorReviewFeedback: "",
    });
    expect(out).not.toContain("{{PREVIOUS_ITERATIONS}}");
  });

  it("substitutes priorReviewFeedback into the {{PRIOR_REVIEW_FEEDBACK}} slot (VA-383)", async () => {
    const feedback =
      "# Review feedback from prior attempts\n\nFix the SQL migrations before retrying.";
    const out = await renderImplementPrompt({
      issue,
      policy: policyWithPaths,
      previousIterations: "",
      priorReviewFeedback: feedback,
    });
    expect(out).toContain("Review feedback from prior attempts");
    expect(out).toContain("Fix the SQL migrations before retrying.");
    expect(out).not.toContain("{{PRIOR_REVIEW_FEEDBACK}}");
  });

  it("leaves no {{PRIOR_REVIEW_FEEDBACK}} placeholder when feedback is empty (VA-383)", async () => {
    const out = await renderImplementPrompt({
      issue,
      policy: policyWithPaths,
      previousIterations: "",
      priorReviewFeedback: "",
    });
    expect(out).not.toContain("{{PRIOR_REVIEW_FEEDBACK}}");
  });

  it("substitutes the actual baseBranch into the prompt (VA-417)", async () => {
    const out = await renderImplementPrompt({
      issue,
      policy: policyWithPaths,
      previousIterations: "",
      priorReviewFeedback: "",
      baseBranch: "master",
    });
    expect(out).toContain("based off\n`master`");
    expect(out).not.toContain("{{BASE_BRANCH}}");
  });

  it("falls back to `main` when baseBranch is omitted (VA-417 back-compat)", async () => {
    const out = await renderImplementPrompt({
      issue,
      policy: policyWithPaths,
      previousIterations: "",
      priorReviewFeedback: "",
    });
    expect(out).toContain("based off\n`main`");
    expect(out).not.toContain("{{BASE_BRANCH}}");
  });

  it("substitutes inRunReviewerFeedback into the {{IN_RUN_REVIEWER_FEEDBACK}} slot (VA-418)", async () => {
    const feedback = formatInRunReviewerFeedback([
      "normalize both timestamps to SQLite ISO-8601 before the lex compare",
    ]);
    const out = await renderImplementPrompt({
      issue,
      policy: policyWithPaths,
      previousIterations: "",
      priorReviewFeedback: "",
      inRunReviewerFeedback: feedback,
    });
    expect(out).toContain("Reviewer feedback from this run");
    expect(out).toContain("normalize both timestamps to SQLite ISO-8601");
    expect(out).not.toContain("{{IN_RUN_REVIEWER_FEEDBACK}}");
  });

  it("leaves no {{IN_RUN_REVIEWER_FEEDBACK}} placeholder when feedback is empty (VA-418)", async () => {
    const out = await renderImplementPrompt({
      issue,
      policy: policyWithPaths,
      previousIterations: "",
      priorReviewFeedback: "",
    });
    expect(out).not.toContain("{{IN_RUN_REVIEWER_FEEDBACK}}");
    // The implement.md prose references the in-run section by name
    // ("If a section titled `Reviewer feedback from this run` is
    // present above…"). With no in-run feedback the section header
    // (the literal `# Reviewer feedback from this run`) must be
    // absent, even though the back-reference in the prose remains.
    expect(out).not.toContain("# Reviewer feedback from this run");
  });

  it("renders both PRIOR_REVIEW_FEEDBACK and IN_RUN_REVIEWER_FEEDBACK independently when both are present (VA-418)", async () => {
    const prior =
      "# Review feedback from prior attempts\n\nCross-drain rejection: tests missing.";
    const inRun = formatInRunReviewerFeedback([
      "add a URL scheme guard before the <a href={url}> render",
    ]);
    const out = await renderImplementPrompt({
      issue,
      policy: policyWithPaths,
      previousIterations: "",
      priorReviewFeedback: prior,
      inRunReviewerFeedback: inRun,
    });
    expect(out).toContain("Review feedback from prior attempts");
    expect(out).toContain("Cross-drain rejection");
    expect(out).toContain("Reviewer feedback from this run");
    expect(out).toContain("add a URL scheme guard");
  });
});

describe("formatInRunReviewerFeedback (VA-418)", () => {
  it("returns an empty string when no rejections are present", () => {
    expect(formatInRunReviewerFeedback([])).toBe("");
  });

  it("renders a single rejection under the in-run header", () => {
    const out = formatInRunReviewerFeedback([
      "add a URL scheme guard before rendering <a href={url}>",
    ]);
    expect(out).toContain("# Reviewer feedback from this run");
    expect(out).toContain("YOUR work this run");
    expect(out).toContain("add a URL scheme guard before rendering <a href={url}>");
  });

  it("orders multiple rejections most-recent-last, numbered for the agent's reference", () => {
    const out = formatInRunReviewerFeedback([
      "first rejection — fix the timestamp comparison",
      "second rejection — also normalize the cache key",
    ]);
    const firstIdx = out.indexOf("first rejection");
    const secondIdx = out.indexOf("second rejection");
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(-1);
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(out).toMatch(/^1\.\s/m);
    expect(out).toMatch(/^2\.\s/m);
  });
});

describe("renderReviewPrompt (VA-361)", () => {
  it("substitutes the issue identifier, title, description, diff, and commits", async () => {
    const out = await renderReviewPrompt({
      issue,
      diff: "--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new",
      commits: "abc123 Add unique index\ndef456 Wire withAudit",
    });
    expect(out).toContain("VA-312");
    expect(out).toContain("Fix the TOCTOU race in provisionHousehold");
    expect(out).toContain("--- a/foo.ts");
    expect(out).toContain("abc123 Add unique index");
  });

  it("falls back to `(empty diff)` / `(no commits)` when those args are empty", async () => {
    const out = await renderReviewPrompt({
      issue,
      diff: "",
      commits: "",
    });
    expect(out).toContain("(empty diff)");
    expect(out).toContain("(no commits)");
  });
});

// VA-383: pure unit tests on the comment-formatting boundary that the
// orchestrator calls before threading the result through to the
// implement prompt. The 3-comment fixture (bot / reviewer / unrelated)
// is the load-bearing AC case — it asserts the filter picks the
// reviewer's comment alone, by author allowlist, when both noise and
// allowlist-violating authors are present.
describe("formatPriorFeedback (VA-383)", () => {
  // Fixed timestamps so the assertion on the rendered ISO string is
  // stable across timezones / CI clocks.
  const fixture: readonly RunwayComment[] = [
    {
      id: "c-bot",
      author: "Linear Bot",
      body: "Sentry attached: 2 new errors on this issue.",
      createdAt: new Date("2026-05-13T15:00:00Z"),
    },
    {
      id: "c-reviewer",
      author: "Jason Kennemer",
      body: "Runway flagged for human review: Sub-agent review rejected: Phase 1 missing SQL migrations and MFA route is broken — see slice-5 acceptance criteria.",
      createdAt: new Date("2026-05-13T16:00:00Z"),
    },
    {
      id: "c-unrelated",
      author: "Jane Doe",
      body: "+1 to this proposal, looks good.",
      createdAt: new Date("2026-05-13T17:00:00Z"),
    },
  ];

  it("surfaces only the allowlisted reviewer's comment, dropping bot and unrelated authors", () => {
    const out = formatPriorFeedback(fixture, ["Jason Kennemer"]);
    expect(out).toContain("Runway flagged for human review");
    expect(out).toContain("Phase 1 missing SQL migrations");
    expect(out).toContain("Jason Kennemer");
    expect(out).not.toContain("Sentry attached");
    expect(out).not.toContain("Linear Bot");
    expect(out).not.toContain("+1 to this proposal");
    expect(out).not.toContain("Jane Doe");
  });

  it("returns the empty string when no comment passes the filter", () => {
    expect(formatPriorFeedback(fixture, ["Nobody Real"])).toBe("");
    expect(formatPriorFeedback([], ["Jason Kennemer"])).toBe("");
  });

  it("strips runway bookkeeping comments even when authored by an allowlisted user", () => {
    const noise: readonly RunwayComment[] = [
      {
        id: "c-pickup",
        author: "Jason Kennemer",
        body: "Runway picked up this issue. Branch: `agent/va-316`.",
        createdAt: new Date("2026-05-13T14:00:00Z"),
      },
      {
        id: "c-opened",
        author: "Jason Kennemer",
        body: "Runway opened a PR for review: https://github.com/x/y/pull/42",
        createdAt: new Date("2026-05-13T14:30:00Z"),
      },
      {
        id: "c-startup",
        author: "Jason Kennemer",
        body: "Runway hit a startup failure before the agent produced any commits — reverting to `Todo` for retry.",
        createdAt: new Date("2026-05-13T14:45:00Z"),
      },
      // Substantive feedback — must survive.
      fixture[1]!,
    ];
    const out = formatPriorFeedback(noise, ["Jason Kennemer"]);
    expect(out).not.toContain("Runway picked up this issue");
    expect(out).not.toContain("Runway opened a PR for review:");
    expect(out).not.toContain("Runway hit a startup failure");
    expect(out).toContain("Phase 1 missing SQL migrations");
  });

  it("orders surviving comments ascending by createdAt regardless of input order", () => {
    const earlier: RunwayComment = {
      id: "c-early",
      author: "Jason Kennemer",
      body: "Runway flagged for human review: First rejection — broken auth.",
      createdAt: new Date("2026-05-12T10:00:00Z"),
    };
    const later: RunwayComment = {
      id: "c-late",
      author: "Jason Kennemer",
      body: "Runway flagged for human review: Second rejection — still broken.",
      createdAt: new Date("2026-05-13T10:00:00Z"),
    };
    // Hand them over reversed; formatter must re-sort.
    const out = formatPriorFeedback([later, earlier], ["Jason Kennemer"]);
    const firstIdx = out.indexOf("First rejection");
    const secondIdx = out.indexOf("Second rejection");
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(-1);
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  it("supports multiple allowlisted authors (reviewer service account + repo owner)", () => {
    const split: readonly RunwayComment[] = [
      {
        id: "c-svc",
        author: "Runway Reviewer Bot",
        body: "REVIEW: REJECTED — tests do not cover the new path.",
        createdAt: new Date("2026-05-13T11:00:00Z"),
      },
      {
        id: "c-owner",
        author: "Jason Kennemer",
        body: "Adding a note: prefer composition over inheritance here.",
        createdAt: new Date("2026-05-13T12:00:00Z"),
      },
    ];
    const out = formatPriorFeedback(split, [
      "Runway Reviewer Bot",
      "Jason Kennemer",
    ]);
    expect(out).toContain("REVIEW: REJECTED");
    expect(out).toContain("tests do not cover");
    expect(out).toContain("prefer composition over inheritance");
  });
});

describe("renderShepherdRebasePrompt (VA-461)", () => {
  const baseIssue: RunwayIssue = {
    id: "issue-uuid",
    identifier: "VA-461",
    title: "Mergeability watcher",
    description: "Wire the mergeability subscription onto the shepherd loop.",
    labels: [],
  };

  it("substitutes branch / base / mergeable_state into the rebase instructions", async () => {
    const out = await renderShepherdRebasePrompt({
      issue: baseIssue,
      branch: "agent/va-461",
      baseBranch: "master",
      mergeableState: "dirty",
      conflictFiles: ["src/foo.ts", "src/bar.ts"],
    });
    expect(out).toContain("VA-461 — Mergeability watcher");
    expect(out).toContain("agent/va-461");
    expect(out).toContain("origin/master");
    expect(out).toContain("`dirty`");
    expect(out).toContain("src/foo.ts");
    expect(out).toContain("src/bar.ts");
  });

  it("AC: instructs `--force-with-lease`, NOT bare `--force`", async () => {
    const out = await renderShepherdRebasePrompt({
      issue: baseIssue,
      branch: "agent/va-461",
      baseBranch: "main",
      mergeableState: "dirty",
      conflictFiles: ["src/foo.ts"],
    });
    expect(out).toMatch(/--force-with-lease/);
    // Bare `--force` (followed by whitespace, end-of-line, or end of
    // word — not the `--force-with-lease` suffix) is a regression.
    expect(out).not.toMatch(/--force(?!\b|-)/);
    // Belt-and-braces: the explicit "Do NOT use plain --force" warning
    // is present in the template, so the agent reading it sees the
    // mandate.
    expect(out).toMatch(/Do NOT use plain `git push --force`/);
  });

  it("renders the no-conflicts hint when the pre-detect list is empty (mergeable_state=behind)", async () => {
    const out = await renderShepherdRebasePrompt({
      issue: baseIssue,
      branch: "agent/va-461",
      baseBranch: "main",
      mergeableState: "behind",
      conflictFiles: [],
    });
    expect(out).toContain("No conflicts pre-detected");
    expect(out).toContain("clean fast-forward");
  });

  it("instructs the agent to emit IMPL: DONE / IMPL: BLOCKED for the parser", async () => {
    const out = await renderShepherdRebasePrompt({
      issue: baseIssue,
      branch: "agent/va-461",
      baseBranch: "main",
      mergeableState: "dirty",
      conflictFiles: ["src/foo.ts"],
    });
    expect(out).toContain("IMPL: DONE");
    expect(out).toContain("IMPL: BLOCKED");
    expect(out).toContain("Mergeability: conflict in");
  });
});

describe("renderShepherdCiFixPrompt (VA-462)", () => {
  const issue: RunwayIssue = {
    id: "issue-uuid",
    identifier: "VA-462",
    title: "CI failure watcher",
    description: "Wire the CI subscription onto the shepherd loop.",
    labels: [],
  };

  it("substitutes check name + log tail + branch into the rendered prompt", async () => {
    const out = await renderShepherdCiFixPrompt({
      issue,
      branch: "agent/va-462",
      checkName: "pnpm test",
      logTail:
        "FAIL src/shepherd.test.ts\nAssertionError: expected 'a' to equal 'b'\n  at line 123",
    });
    expect(out).toContain("VA-462 — CI failure watcher");
    expect(out).toContain("`pnpm test`");
    expect(out).toContain("agent/va-462");
    expect(out).toContain("FAIL src/shepherd.test.ts");
    expect(out).toContain("AssertionError");
  });

  it("AC: instructs `git push origin BRANCH` and explicitly forbids --force / --force-with-lease", async () => {
    const out = await renderShepherdCiFixPrompt({
      issue,
      branch: "agent/va-462",
      checkName: "pnpm test",
      logTail: "FAIL",
    });
    expect(out).toMatch(/git push origin/);
    // Append commits, don't rewrite history — the prompt mentions
    // `--force` and `--force-with-lease` only as things the agent
    // must NOT use (verified via the surrounding warning text), not
    // as the push command itself.
    expect(out).toMatch(/NOT\s+`?--force`?\s+or\s+`?--force-with-lease`?/);
    // The actual push command on the same line is `git push origin
    // {{BRANCH}}` — no flags. Assert that pattern present.
    expect(out).toMatch(/`git push origin agent\/va-462`/);
  });

  it("falls back to `(log unavailable)` when the log tail is empty", async () => {
    const out = await renderShepherdCiFixPrompt({
      issue,
      branch: "agent/va-462",
      checkName: "weird-check",
      logTail: "",
    });
    expect(out).toContain("(log unavailable)");
  });

  it("instructs IMPL: DONE / IMPL: BLOCKED markers for the parser", async () => {
    const out = await renderShepherdCiFixPrompt({
      issue,
      branch: "agent/va-462",
      checkName: "pnpm test",
      logTail: "FAIL",
    });
    expect(out).toContain("IMPL: DONE");
    expect(out).toContain("IMPL: BLOCKED");
  });
});

describe("renderShepherdReviewFixPrompt (VA-463)", () => {
  const issue: RunwayIssue = {
    id: "issue-uuid",
    identifier: "VA-463",
    title: "Reviewer responder",
    description: "Wire subscription C.",
    labels: [],
  };

  it("substitutes the fix-request line into the prompt body", async () => {
    const out = await renderShepherdReviewFixPrompt({
      issue,
      branch: "agent/va-463",
      fixRequest: "add a URL scheme guard before rendering the href",
    });
    expect(out).toContain("VA-463 — Reviewer responder");
    expect(out).toContain("add a URL scheme guard before rendering the href");
    expect(out).toContain("agent/va-463");
  });

  it("instructs a normal push, NOT --force or --force-with-lease", async () => {
    const out = await renderShepherdReviewFixPrompt({
      issue,
      branch: "agent/va-463",
      fixRequest: "fix the regex",
    });
    expect(out).toMatch(/git push origin agent\/va-463/);
    expect(out).toMatch(/NOT\s+`?--force`?\s+or\s+`?--force-with-lease`?/);
  });

  it("emits IMPL: DONE / IMPL: BLOCKED markers for the parser", async () => {
    const out = await renderShepherdReviewFixPrompt({
      issue,
      branch: "agent/va-463",
      fixRequest: "x",
    });
    expect(out).toContain("IMPL: DONE");
    expect(out).toContain("IMPL: BLOCKED");
  });
});

describe("renderShepherdReviewRespondPrompt (VA-463)", () => {
  const issue: RunwayIssue = {
    id: "issue-uuid",
    identifier: "VA-463",
    title: "Reviewer responder",
    description: "Wire subscription C.",
    labels: [],
  };

  it("passes the comment author, source, and body verbatim", async () => {
    const out = await renderShepherdReviewRespondPrompt({
      issue,
      branch: "agent/va-463",
      commentAuthor: "human-jane",
      commentSource: "review",
      commentBody:
        "Could you also rename `foo` to `bar` everywhere? The current name is confusing.",
    });
    expect(out).toContain("human-jane");
    expect(out).toContain("review");
    expect(out).toContain("rename `foo` to `bar`");
  });

  it("includes the non-actionable branch of the decision tree", async () => {
    const out = await renderShepherdReviewRespondPrompt({
      issue,
      branch: "agent/va-463",
      commentAuthor: "human",
      commentSource: "issue",
      commentBody: "LGTM",
    });
    // The agent must explicitly recognise non-actionable comments
    // and IMPL: DONE without committing — pin the language.
    expect(out).toMatch(/non-actionable/i);
    expect(out).toMatch(/do not fabricate|IMPL: DONE with no commit/i);
  });
});
