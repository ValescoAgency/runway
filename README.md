# runway

Linear-driven coding-agent orchestrator. Reads issues from Linear, runs
[Sandcastle](https://github.com/mattpocock/sandcastle) per issue
(Claude Code inside Docker), reviews the diff with a sub-agent, opens a
PR, and updates Linear. Built for the "kick off, walk away, come back
to a stack of PRs" workflow.

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
- Anthropic API key (set in the **target repo's** `.sandcastle/.env`,
  not in runway's env — Sandcastle reads it)

## One-time setup per target repo

```bash
cd /path/to/your/repo
npx sandcastle init
# fills .sandcastle/{Dockerfile, prompt.md, .env.example, config.json}
cp .sandcastle/.env.example .sandcastle/.env
# fill ANTHROPIC_API_KEY and GH_TOKEN there
```

Sandcastle owns the per-repo `.sandcastle/` directory. Runway never
writes to it.

## Setup runway itself

```bash
git clone git@github.com:ValescoAgency/runway.git
cd runway
pnpm install
pnpm link --global   # so `runway` is on your $PATH
```

Export runway's own env (in your shell rc, or wherever you keep API keys):

```bash
export LINEAR_API_KEY=lin_api_...
# Optional overrides:
# export RUNWAY_LINEAR_TEAM=VA
# export RUNWAY_READY_STATUS="Todo"
# export RUNWAY_IN_PROGRESS_STATUS="In Progress"
# export RUNWAY_IN_REVIEW_STATUS="In Review"
# export RUNWAY_HITL_LABEL="needs-human"
# export RUNWAY_MAX_ITERATIONS=5
```

## Usage

```bash
cd /path/to/the/repo/you/want/agents/working/on
runway              # drain the entire ready queue
runway --max 3      # process at most 3 issues then exit
runway --help
```

The CLI exits with 0 even if some issues hit HITL or errored — those
are normal outcomes. Check Linear for the `needs-human` label and the
per-issue comments for what happened.

## Linear conventions

Runway picks up issues that are:

- in team `RUNWAY_LINEAR_TEAM` (default `VA`)
- in workflow state `RUNWAY_READY_STATUS` (default `Todo`)

It transitions them through:

- `In Progress` while the agent is running
- `In Review` when the PR opens
- (label `needs-human`) if the agent or reviewer can't finish

These names are configurable per env var; the queries match by name so
your Linear workspace's actual state names need to line up with what
you set.

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
