// Enforces conventional-commits format on every commit message.
// Wired into git via the `commit-msg` hook in lefthook.yml.
//
// CLAUDE.md's repo conventions: feat, fix, chore, docs (others below
// are conventional-commits defaults, kept so we don't surprise
// contributors used to the standard set).
export default {
  extends: ["@commitlint/config-conventional"],
};
