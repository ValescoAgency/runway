# runway

[![npm version](https://img.shields.io/npm/v/@valescoagency/runway?logo=npm)](https://www.npmjs.com/package/@valescoagency/runway) [![License](https://img.shields.io/npm/l/@valescoagency/runway)](https://github.com/ValescoAgency/runway/blob/master/LICENSE) [![CI status](https://img.shields.io/github/actions/workflow/status/ValescoAgency/runway/release.yml?label=release)](https://github.com/ValescoAgency/runway/actions/workflows/release.yml) [![Provenance](https://img.shields.io/badge/provenance-signed-blue?logo=sigstore)](https://www.npmjs.com/package/@valescoagency/runway)

A small CLI for two jobs: **scaffold** a target repo for autonomous
coding-agent runs, then **drain** a Linear queue against it. Wraps
[Sandcastle](https://github.com/mattpocock/sandcastle) (Claude Code
inside Docker), [varlock](https://varlock.dev) + 1Password for
zero-secrets-at-rest, and the `gh` CLI for PR creation.

## Five commands

| | |
|---|---|
| `runway doctor` | Read-only preflight diagnostic: host tooling, env vars, repo state, and the agent docker image. Use when something stopped working and you want a sanity report. `--json` for CI / scripted health checks. |
| `runway init` | Scaffold the cwd repo for runway: write `.sandcastle/Dockerfile` + (tier 2) `.env.schema` with op:// references. Run **once per target repo**. |
| `runway run` | Drain a Linear queue. For each `Todo` issue: branch, agent works, sub-agent reviews, PR opens (or `needs-human` label). Run **whenever you want a batch of work done**. |
| `runway upgrade` | Update the runway CLI itself: `git pull` the local clone, `pnpm install`, typecheck. `--check` for a dry-run, `--force` to override dirty/branch refusals. |
| `runway upgrade-repo` | Re-render the cwd repo's runway scaffold against the current vendored templates. Use after a runway version bump that changed the Dockerfile or template shape — `init` writes them, `upgrade-repo` keeps them current without re-prompting for op:// values. |

`runway --help` for the full usage; `runway <cmd> --help` per command.

`runway init` and `runway upgrade-repo` are siblings: `init` is the
first-time scaffold (you provide the op:// vault/items), `upgrade-repo`
is the re-render (extracts those values from the existing `.env.schema`
so you never re-type them). Override the extracted values via
`--op-vault=…`, `--anthropic-item=…`, `--gh-token-item=…` if needed,
or use `--check` for a CI dry-run that exits 1 on drift.

## What runway is and isn't

| It is | It isn't |
|---|---|
| A small Node CLI that orchestrates Sandcastle runs from a Linear queue | A sandbox or agent runtime — Sandcastle does that |
| The replacement for the AFK label-handler / preflight / contracts pipeline | A governance layer; trust comes from your review of the PR, not gates |
| Repo-agnostic — runs in whatever cwd you launch it from | Multi-repo (yet) — one repo per `runway run` invocation |
| Sequential | Parallel (yet) |

## Architecture

```
Linear (Todo, team=VA)
  ↓ poll
runway (this CLI, on your Mac, run from inside the target repo)
  ↓ for each issue
  │   sandcastle.run({ agent: claudeCode, sandbox: docker, cwd: process.cwd(), ... })
  │   → branch agent/<issue-id>, commits, tests
  │
  │   sandcastle.run({ ..., prompt: review template })
  │   → REVIEW: APPROVED  | REVIEW: REJECTED — <reason>
  │
  ├── approved  → git push → gh pr create → Linear "In Review"
  └── rejected  → Linear label "needs-human", comment with reason
  ↓ next issue
```

## Prerequisites

- macOS or Linux
- Docker Desktop (or Podman)
- Node 22+
- `gh` CLI authenticated against the org that hosts your target repo
- Linear API key with read+write on the team you're targeting
- A Claude Code credential — **either** an Anthropic API key
  (`sk-ant-api03-…`, pay-per-token) **or** a Pro/Max OAuth token
  (`sk-ant-oat01-…`, generated via `claude setup-token`). The two are
  not interchangeable — see "Claude Code auth modes" below. Stored in
  the **target repo's** `.sandcastle/.env` (tier 1) or 1Password
  (tier 2); never in runway's own env.

## One-time setup per target repo

```bash
cd /path/to/your/repo
runway init \
  --op-vault=runway \
  --anthropic-item=anthropic-api-key \
  --gh-token-item=gh-token \
  --auth-mode=api-key   # or --auth-mode=oauth for Pro/Max tokens
```

(No `--op-account` — runway uses 1Password service-account auth
(`OP_SERVICE_ACCOUNT_TOKEN`) exclusively, and the token already
encodes the tenant. `op://` URIs runway writes are
`op://<vault>/<item>/credential`, not `op://<account>/<vault>/<item>`.
The `/credential` field selector is required for `API_CREDENTIAL`
items, which is the canonical 1Password category for API keys.)

This runs `npx sandcastle init`, patches the generated `.sandcastle/Dockerfile`
to bake in `varlock` + the 1Password CLI + a `claude` shim, scaffolds
`.env.schema` at the repo root with op:// references to your 1Password vault,
and deletes `.sandcastle/.env` so no secrets sit at rest. Review the diff,
commit on a feature branch, open a PR.

Pass `--tier=1` if you want the plain Sandcastle setup with `.sandcastle/.env`
and no varlock (faster but secrets land on disk).

Architecture walkthrough: [`docs/secrets-with-varlock.md`](docs/secrets-with-varlock.md).

## Claude Code auth modes

Claude Code accepts two distinct credentials, and they are **not
interchangeable** — passing one as the other yields a generic
`Invalid API key` inside the container with no useful diagnostic.

| Mode | Env var | Token shape | Source |
|---|---|---|---|
| `api-key` (default) | `ANTHROPIC_API_KEY` | `sk-ant-api03-…` | [Anthropic console](https://console.anthropic.com), pay-per-token |
| `oauth` | `CLAUDE_CODE_OAUTH_TOKEN` | `sk-ant-oat01-…` | `claude setup-token` on your Pro/Max account |

Pick whichever matches what's stored in your 1Password item:

```bash
runway init --tier=2 --op-vault=runway \
  --anthropic-item=claude-pro-oauth-token \
  --gh-token-item=gh-token \
  --auth-mode=oauth
```

The `--anthropic-item` flag is the 1Password item name regardless of
mode; only the env var written into `.env.schema` changes. `runway
doctor` surfaces the resolved mode under Environment (`claude auth
mode: oauth (…)`), and fails fast if `.env.schema` ends up with both
env vars at once.

If you switch modes later, run `runway upgrade-repo` — it extracts
the existing op:// references, re-renders the template with the new
mode (detected automatically from the schema), and writes back. You
do not need to re-pass the op:// flags.

## Secrets — recommended: varlock + 1Password

If you don't want any secret sitting at rest in any `.env` file,
runway integrates [varlock](https://varlock.dev). Two layers (host +
in-container), both opt-in. Full walk-through:
[`docs/secrets-with-varlock.md`](docs/secrets-with-varlock.md).

TL;DR for the host layer:

```bash
varlock run --schema /path/to/runway/.env.schema -- runway --max 3
```

Without varlock, runway falls back to plain `process.env` and
sandcastle reads `.sandcastle/.env` per its docs.

## Install

```bash
pnpm install -g @valescoagency/runway       # or npm i -g, yarn global add
```

Export runway's own env (in your shell rc, or wherever you keep API keys):

```bash
export LINEAR_API_KEY=lin_api_...
# Optional overrides:
# export RUNWAY_LINEAR_TEAM=VA
# export RUNWAY_LINEAR_PROJECT=<project-id-or-slug>   # optional, scopes queue to one project
# export RUNWAY_BASE_BRANCH=master                    # optional, overrides auto-detected default branch
# export RUNWAY_READY_STATUS="Todo"
# export RUNWAY_IN_PROGRESS_STATUS="In Progress"
# export RUNWAY_IN_REVIEW_STATUS="In Review"
# export RUNWAY_HITL_LABEL="needs-human"
# export RUNWAY_MAX_ITERATIONS=5
```

### From source (development)

```bash
git clone git@github.com:ValescoAgency/runway.git
cd runway
pnpm install
pnpm build              # compiles src/ → dist/
pnpm link --global      # so `runway` is on your $PATH
```

`pnpm dev -- <args>` runs the TypeScript source via `tsx` without building, useful while iterating on runway itself.

#### Tests

```bash
pnpm test          # one-shot run, used by CI
pnpm test:watch    # watch mode for local iteration
```

Vitest is the harness; tests live colocated with the source as
`*.test.ts` files (e.g. `src/git.test.ts` next to `src/git.ts`). CI
runs `pnpm typecheck && pnpm test` on every PR via
`.github/workflows/ci.yml`.

When adding logic that has a sharp pass/fail signal, add a test next
to it. The seed suite covers `parseRunArgs`, `detectBaseBranch`, the
`parseOpRefs` regex extraction, and the `drainQueue` error-handler
branches — copy any of those as a shape for new tests.

#### Git hooks (lefthook + commitlint)

Hooks install automatically on `pnpm install` via the `prepare`
script. What runs and when:

| Hook | Runs | Why |
|---|---|---|
| `pre-commit` | `pnpm typecheck` | Catch TS errors before they land on a branch. |
| `commit-msg` | `pnpm exec commitlint --edit` | Reject non-conventional commit messages (CLAUDE.md convention). |
| `pre-push` | `pnpm test` | Block pushing red. |

Skip a single hook invocation with `LEFTHOOK=0 git commit …` (or
`… git push …`). To re-install after editing `lefthook.yml`, run
`pnpm exec lefthook install -f`.

## Usage

```bash
cd /path/to/the/repo/you/want/agents/working/on
runway run             # drain the entire ready queue
runway run --max 3     # process at most 3 issues then exit
runway --help
```

`runway` (no subcommand) is an alias for `runway run` for back-compat.

The CLI exits with 0 even if some issues hit HITL or errored — those
are normal outcomes. Check Linear for the `needs-human` label and the
per-issue comments for what happened.

## Linear conventions

Runway picks up issues that are:

- in team `RUNWAY_LINEAR_TEAM` (default `VA`)
- (optionally) in project `RUNWAY_LINEAR_PROJECT` (override per-run
  with `runway run --project=<id-or-slug-or-name>`; unset = team-wide)
- in workflow state `RUNWAY_READY_STATUS` (default `Todo`)

It transitions them through:

- `In Progress` while the agent is running (specifically: once the
  agent has committed to its branch — startup failures before any
  commits revert the issue back to `Todo` rather than stranding it)
- `In Review` when the PR opens
- (label `needs-human`) if the agent or reviewer can't finish *after*
  the agent has committed real work

These names are configurable per env var; the queries match by name so
your Linear workspace's actual state names need to line up with what
you set.

## Base branch

Runway auto-detects the repo's default branch at the start of every
`runway run` by reading `origin/HEAD` (with `git remote show origin`
as a fallback for fresh clones). That branch is used for diffing the
agent's work, counting commits when deciding whether a startup
failure should revert to `Todo`, and as the `--base` for the PR.

Set `RUNWAY_BASE_BRANCH=<name>` to override detection — useful when
you want runway to target a release branch instead of the default, or
when `origin/HEAD` isn't set and you don't want to run
`git remote set-head origin --auto`. `runway doctor` surfaces the
resolved base branch (detected or overridden) in its Environment
section.

## Sub-agent review

Every implementation run is followed by a fresh Sandcastle run with
[`prompts/review.md`](prompts/review.md). The reviewer reads the diff
and the issue body and outputs one of:

```
REVIEW: APPROVED
REVIEW: REJECTED — <one-line reason>
```

If approved, runway pushes the branch and opens the PR. If rejected,
the issue gets the HITL label and a comment with the reviewer's reason.

The reviewer is intentionally adversarial — its job is to find reasons
NOT to ship, not to rubber-stamp.

## What's deliberately missing in v1

- Parallel runs (one issue at a time)
- Multi-repo dispatch from a single command (cd into each repo)
- Vercel Sandbox provider (Docker only — swap to `vercel()` later)
- DAG / dependency awareness across issues
- Auto-rebase / merge of approved PRs (you do that)

These are tractable, just not v1.

## Status

v0.1 — scaffold complete, untested against a live queue.
