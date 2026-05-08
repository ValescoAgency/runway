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
| Single-target-repo in v1 | Multi-repo (yet) |
| Sequential | Parallel (yet) |

## Architecture

```
Linear (Todo, assignee=agent)
  ↓ poll
runway (this CLI, on your Mac)
  ↓ for each issue
  │   sandcastle.run({ agent: claudeCode, sandbox: docker, ... })
  │   → branch agent/<issue-id>, commits, tests
  │
  │   sandcastle.run({ ..., prompt: review.md })
  │   → REVIEW: APPROVED  | REVIEW: REJECTED — <reason>
  │
  ├── approved  → git push → gh pr create → Linear "In Review"
  └── rejected  → Linear label "needs-human", comment with reason
  ↓ next issue
```

## Prerequisites

- macOS or Linux
- Docker Desktop (or Podman) — Sandcastle's `docker()` provider needs it
- Node 22+
- `gh` CLI authenticated against the org that hosts your target repo
- Linear API key with read+write on the team you're targeting
- Anthropic API key

## Setup

```bash
pnpm install
cp .sandcastle/.env.example .sandcastle/.env
# fill in the values
```

Required env (see [`.sandcastle/.env.example`](.sandcastle/.env.example)):

- `ANTHROPIC_API_KEY`
- `GH_TOKEN`
- `LINEAR_API_KEY`
- `RUNWAY_TARGET_REPO` — absolute path to a clean local clone of the
  target repo. Runway operates in this directory; Sandcastle creates
  worktrees off it.

Optional knobs are documented in the same file (status names, label
names, max iterations).

## Usage

```bash
# drain the entire queue
pnpm dev

# or via the bin
runway run

# process at most 3 issues then exit
runway run --max 3
```

The CLI exits with 0 even if some issues hit HITL or errored — those
are normal outcomes, not runway failures. Check Linear for the
`needs-human` label and the per-issue comments for what happened.

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
[`prompts/review.md`](.sandcastle/prompts/review.md). The reviewer reads the diff
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
- Multi-repo dispatch (single `RUNWAY_TARGET_REPO`)
- Vercel Sandbox provider (Docker only — swap to `vercel()` later)
- DAG / dependency awareness across issues
- Auto-rebase / merge of approved PRs (you do that)

These are tractable, just not v1.

## Status

v0.1 — scaffold complete, untested against a live queue. See
[CHANGELOG.md](CHANGELOG.md) once it exists.
