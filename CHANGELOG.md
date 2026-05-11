# Changelog

All notable changes to runway are documented here. Versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); breaking
changes bump the major.

## 0.3.0 — 2026-05-11

Unblocks `runway run` for any repo not on `main`, adds OAuth-token support for Pro/Max users, and lands the dev infrastructure (tests + git hooks) the past few releases kept deferring.

### Added

- **`--auth-mode={api-key,oauth}` on `runway init`** ([PR #23](https://github.com/ValescoAgency/runway/pull/23), VA-347). Pro/Max users on a `claude setup-token` OAuth credential (`sk-ant-oat01-…`) can now scaffold a tier-2 repo without hand-editing `.env.schema`. Default `api-key` preserves current behavior; `--auth-mode=oauth` writes `CLAUDE_CODE_OAUTH_TOKEN` instead of `ANTHROPIC_API_KEY` in the generated schema. `runway upgrade-repo` detects the mode from the existing schema and round-trips it. `runway doctor` surfaces the active mode and fails fast if both env vars are present at once. README has a new "Claude Code auth modes" section.
- **`RUNWAY_BASE_BRANCH` override + auto-detection** ([PR #22](https://github.com/ValescoAgency/runway/pull/22), VA-346). Runway resolves the base branch from `origin/HEAD` at the start of every `runway run` (with `git remote show origin` as a fallback) and threads it through the diff capture, commit count, and `gh pr create --base` calls. Override with `RUNWAY_BASE_BRANCH=<name>` when targeting a release branch. `runway doctor` surfaces the resolved branch under Environment.

### Fixed

- **`runway run` no longer crashes on non-`main` repos** ([PR #22](https://github.com/ValescoAgency/runway/pull/22), VA-346). `captureDiff`, `captureCommitLog`, `hasCommits`, and the `gh pr create --base` argument previously hardcoded `main`. Any repo on `master` (or `develop`/`trunk`/anything else) crashed at the diff-capture step with `fatal: ambiguous argument 'main...agent/...'`, wasting the entire agent execution. Now uses the auto-detected base.

### Internal

- **Vitest harness + 25 seed tests + CI gate** ([PR #24](https://github.com/ValescoAgency/runway/pull/24), VA-348). Every recent PR carried a "Vitest test" acceptance criterion and deferred it for lack of a harness; that's done. `pnpm test` runs Vitest against `src/**/*.test.ts`, and a new `.github/workflows/ci.yml` runs `pnpm typecheck && pnpm test` on every PR. Seed tests cover `parseRunArgs`, `detectBaseBranch`, `parseOpRefs`, and `drainQueue`'s VA-342 error branches. `tsconfig.build.json` keeps `*.test.ts` out of the published tarball.
- **Git hooks via lefthook + commitlint** ([PR #25](https://github.com/ValescoAgency/runway/pull/25)). Installs automatically on `pnpm install` via a `prepare` script. `pre-commit` runs `pnpm typecheck`, `commit-msg` enforces conventional-commits format, `pre-push` runs `pnpm test`. `LEFTHOOK=0 git …` skips a single invocation when needed.
- **Self-healing publish workflow** ([PR #21](https://github.com/ValescoAgency/runway/pull/21)). The `release.yml` publish step now retries up to 3× with a 30s backoff on `TLOG_CREATE_ENTRY_ERROR` (a known npm CLI bug where a transient network glitch causes a duplicate Rekor write). Manual `gh run rerun --failed` is no longer needed when sigstore flakes mid-publish.

## 0.2.0 — 2026-05-10

First substantive release since `0.1.0`. One new feature plus three
hard blockers fixed for tier-2 scaffolds doing their first `runway
run` against a fresh repo.

### Added

- **Project-level filter for the Linear queue** ([PR #18](https://github.com/ValescoAgency/runway/pull/18), VA-339). `runway run` now accepts `--project=<id-or-slug-or-name>`, or `RUNWAY_LINEAR_PROJECT` in the environment, to scope the queue to a single Linear project under the configured team. With neither set, behavior is unchanged (drains team-wide). `runway doctor` surfaces the resolved scope under Environment.

### Fixed

- **`.env.schema` template no longer breaks varlock validation** ([PR #17](https://github.com/ValescoAgency/runway/pull/17), VA-341 + VA-343). Two bugs in the generated template were stranding every fresh tier-2 install on its first run:
  - The commented-out example block at the bottom contained `# @sensitive @required` decorators followed by commented config lines. varlock parses `# @decorator` lines as real decorators regardless of comment context and exits 1 ("detached comment block"). Replaced with a short note explaining the pitfall and pointing at the two live entries as the copy-this pattern.
  - `op://` URIs lacked a field selector, so `op read` failed against `API_CREDENTIAL` items (the canonical 1Password category for API keys). Template now generates `op://<vault>/<item>/credential` for both ANTHROPIC_API_KEY and GH_TOKEN; init help text and README updated to match.
- **Issues no longer strand in `In Progress` on startup failures** ([PR #19](https://github.com/ValescoAgency/runway/pull/19), VA-342). When the agent crashed before producing any commits (missing image, varlock failure, container boot error, etc.), the issue was left in `In Progress` and silently skipped on the next run since the queue filter only matches `Todo`. `drainQueue` now checks the agent branch's commit count on error: zero commits → revert to `Todo` for retry, skip the `needs-human` label; otherwise → existing HITL behavior. README "Linear conventions" documents the rule.

## 0.1.2 — 2026-05-10

Patch release fixing a packaging hole that broke `runway run` for everyone installing from npm.

- `prompts/` is now included in the published tarball ([PR #15](https://github.com/ValescoAgency/runway/pull/15), VA-340). 0.1.1 published without the `prompts/implement.md` + `prompts/review.md` files the orchestrator reads at runtime, so every `runway run` against an npm install died with `ENOENT` before the agent started. The `files` array in `package.json` now explicitly lists `prompts/`.

## 0.1.1 — 2026-05-10

Patch release verifying the npm Trusted Publishing (OIDC) path end-to-end. No code changes.

- Release workflow publishes via GitHub OIDC instead of a long-lived `NPM_TOKEN` (see [PR #11](https://github.com/ValescoAgency/runway/pull/11)).
- Each published tarball now carries a signed provenance attestation (`npm audit signatures` verifies the artifact was built and signed by this repo's release workflow at a specific commit).
- Repo-level `.npmrc` pins the `@valescoagency` scope to public npm so host-level config drift can't reroute a future publish ([PR #10](https://github.com/ValescoAgency/runway/pull/10)).

## 0.1.0 — 2026-05-09

First public npm release. **Experimental** — production-shaped (the
init/run/doctor/upgrade/upgrade-repo loop is verified end-to-end on
macOS arm64) but the surface may shift as we dogfood it.

### Commands

- `runway init` — scaffold a target repo with `.sandcastle/Dockerfile`
  + (tier 2) `.env.schema` for varlock + 1Password CLI inside the
  container. Writes the canonical claude-code Dockerfile directly,
  bypassing `sandcastle init`'s interactive prompts (which hang in
  non-TTY environments).
- `runway run` — drain a Linear queue. For each `Todo` issue: branch,
  agent works in a sandcastle Docker sandbox, sub-agent reviews, PR
  opens (or `needs-human` label).
- `runway doctor` — read-only preflight diagnostic with `--json` mode
  for CI / scripted health checks.
- `runway upgrade` — self-update the CLI from its git clone (`git
  pull`, `pnpm install`, typecheck). Will gain a global-install path
  in a follow-up.
- `runway upgrade-repo` — re-render a target repo's runway scaffold
  against current vendored templates. Extracts existing op:// values
  so the user never re-types them. `--check` mode for CI drift detection.

### Notable design choices

- **Tier 2 by default** — secrets resolved at agent runtime via
  varlock + 1Password CLI inside the container, never written to the
  target repo's filesystem.
- **No `.sandcastle/.env`** — runway's tier 2 path keeps the file off
  disk entirely; tier 1 is available as `--tier=1` for users opting
  out of varlock.
- **Vendored Dockerfile base** — runway ships its own copy of
  sandcastle's claude-code Dockerfile so we can patch macOS-specific
  bugs (host GID 20 collision with Debian's `dialout` group) and
  apply the varlock layer without depending on `sandcastle init`'s
  prompts.

### Limitations

- One target repo per `runway run` invocation (no multi-repo dispatch).
- Sequential issue processing (no parallel runs).
- Docker sandbox only — Vercel sandbox provider is a follow-up.
- No DAG / dependency awareness across issues.
- Auto-rebase / merge of approved PRs is the human's job.

### License

MIT.
