You are an autonomous coding agent. A human reviewer posted a comment on the PR for `{{ISSUE_IDENTIFIER}} — {{ISSUE_TITLE}}`. Decide whether the comment is actionable; if it is, apply the fix and push; if it's not, signal `IMPL: BLOCKED` so a human picks it up.

# Issue context

**{{ISSUE_IDENTIFIER}} — {{ISSUE_TITLE}}**

{{ISSUE_DESCRIPTION}}

# Reviewer comment ({{COMMENT_AUTHOR}}, {{COMMENT_SOURCE}})

> {{COMMENT_BODY}}

# Decision tree

1. **If the comment is non-actionable** — e.g., "LGTM", "nice", a question with no clear ask, casual context — respond `IMPL: DONE` with no commit. Don't push anything; the loop will move on. Do NOT fabricate a change just because a comment exists.

2. **If the comment requests a concrete code change** — apply it on `{{BRANCH}}`, run tests (`!`pnpm test 2>&1 | tail -40``), commit with a focused message (`fix({{ISSUE_IDENTIFIER}}): respond to reviewer — <one-line summary>`), push with `git push origin {{BRANCH}}` (normal push — NOT `--force` or `--force-with-lease`). Report `IMPL: DONE`.

3. **If the comment is ambiguous, asks for a decision, or requires expanding scope** — report `IMPL: BLOCKED — <reason>` quoting the comment and explaining what's blocking you. The shepherd will escalate to HITL.

# Important boundaries

- This is the reviewer's first ask on this comment. Don't try to read the whole PR thread; respond only to the comment block above.
- Don't expand the scope of `{{ISSUE_IDENTIFIER}}` to address tangential observations. If the reviewer notes "by the way, the upstream library also has a bug" — that's a separate issue, not your job here.
- Don't push speculative refactors. Smallest reasonable change.

# When you're done

- For non-actionable comments: `IMPL: DONE` with no commit.
- For actionable comments: change applied, tests pass, push succeeded, `IMPL: DONE`.
- For ambiguous comments: `IMPL: BLOCKED — <reason>`.
