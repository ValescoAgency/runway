# Planner daemon architecture: long-running host daemon for queue selection and PR shepherding

Runway will grow a **planner** — an always-on host daemon (target: a
Mac mini reachable via Tailscale) that owns Linear queue selection and
cross-PR shepherding. The planner is a deterministic state machine
that consults Claude sparingly at specific decision points; it is
recommendation-led by default; it emits its decisions as OTLP events
that the existing dashboard projector writes to SQLite. The inline
shepherd (VA-459 epic, currently in flight) ships first and is later
re-platformed onto the planner.

## Status

Proposed (2026-05-20). Implementation deferred until the inline
shepherd epic (VA-459) has landed and produced operational feedback.

## Context

Runway today is a one-shot CLI: `runway run` drains a Linear queue,
opens PRs, and exits. ADR 0001 (`dashboard-tail-during-run...`)
considered and rejected daemonizing runway, on the grounds that the
benefit didn't fit how a solo operator uses runway today — but
explicitly left the door open: *"can be promoted later if usage
patterns change."*

VA-459's epic body added a parallel observation: cross-PR coordination
("PR #142 needs PR #138 to land first") is a genuinely
cross-process, cross-time concern that a one-shot drain cannot
maintain. The epic deferred the question by shipping shepherding
**inline in the drain** for the first version.

Two pressures pushed the question back open:

1. **Cross-PR coordination is in scope**, not aspirational. The
   inline shepherd serializes shepherding throughput inside a drain;
   a drain of 5 PRs that each take 30 min to ship blocks for 2.5h on
   shepherding alone.
2. **The dashboard is already a long-running container.** Operators
   running `runway dash up` on a Mac mini have already accepted the
   "always-on host" deployment shape. The trust + ops surface of
   "another long-running thing on the same host" is small.

The planner sits behind those two pressures. It does **not** subsume
runway entirely — `runway run` and the per-issue composer
(`processIssue`) stay where they are. The planner only owns
decisions that need a persistent, cross-time view.

## Decision

### Scope: A + C, not A + B + C

The planner owns:

- **A. Queue selection** — replaces today's FIFO-by-`queue_position`
  with priority-aware, dependency-aware picking. Reads
  `linear_snapshots`, `meta_reviews`, blocker relations.
- **C. Cross-PR shepherding** — drives open PRs toward merge
  (mergeability conflicts, CI failures, reviewer feedback) with a
  cross-PR view (rebase PR #142 before picking up VA-200; pause
  shepherd on PR #138 while VA-203 finishes).

The planner does **not** own:

- **B. Per-issue composer** (implement → review → finalize). That
  loop stays in `runway run` / `processIssue`. The planner spawns
  drains as ephemeral sub-processes targeting a specific Linear
  issue; each drain is otherwise unchanged.

### Smartness: Level 1 (deterministic + sparingly LLM)

The planner is a TypeScript state machine. Three explicit LLM
consultation points:

1. **Priority tie-breaking** when rules can't decide between two
   ready issues.
2. **Reviewer comment interpretation** when auto-parse of
   `REVIEW: CHANGES-REQUESTED — <fix>` doesn't match.
3. **Shepherd progress judgment** ("is this PR actually moving
   toward merge?") when the rule-based budget is ambiguous.

The IRA's Run/Drain Reviews (VA-403, VA-406) — already running as
offline LLM judgments — are an *input* to the planner's
deterministic logic, not a separate LLM loop.

### Placement: host daemon

The planner runs **on the host**, not in a container:

- The dashboard image stays minimal (no Docker socket, no `gh`, no
  `git`, no 1Password CLI). That property was hard-won and is worth
  defending.
- A sidecar worker container would put Docker socket access into a
  long-running container — a real attack surface for a self-hosted
  service.
- The host daemon shares all of runway's existing toolbox (gh, git,
  sandcastle, 1Password, host secrets) with zero new privilege
  debates. It is "another kind of `runway run` — a long-lived one."

On a Mac mini behind Tailscale, "laptop sleep pauses the planner" —
the original objection in ADR 0001 — disappears. Laptop and phone
reach the planner over the tailnet.

### UX: recommendation-led, per-capability auto-toggle

Default behavior is **recommendation-led**: the planner emits
recommendations ("rebase PR #142 — base moved"; "pick up VA-200
next — VA-198's PR just merged"); the operator nods or rejects from
the dashboard UI or via the planner's HTTP API.

Each capability has a `manual` / `suggest` / `auto` toggle.
`suggest` is the default. The operator promotes individual
capabilities to `auto` as trust accumulates. This avoids the trap
where "build it autonomous, then spend 6 months adding guardrails"
— guardrails are the default; autonomy is the opt-in.

### Writer model: event-emitting, not direct-writing

The planner emits OTLP events for its durable record:
`recommendation.proposed`, `recommendation.accepted`,
`recommendation.rejected`, `action.started`, `action.completed`,
`action.failed`. The dashboard's projector grows handlers for these
event types and writes them to new SQLite tables alongside drain
events.

**The dashboard remains the sole SQLite writer.** This is an
invariant worth defending: it means there's one schema migration
path, one transaction model, and no two-writer coordination
problem. The planner's in-flight reasoning (which actions are
running this tick) lives in memory.

The trade is a read-after-write gap — the planner can't
SELECT-back its own emissions during the same tick. The planner
keeps in-memory state for the in-flight work and only relies on
SQLite for state that survives a restart.

### HTTP API surface

The planner exposes a small REST API on the same host listener as
the dashboard (different path prefix). Endpoints land per
capability — e.g., `POST /planner/recommendations/:id/accept`,
`POST /planner/actions/spawn-drain { target: "VA-200" }`,
`POST /planner/shepherd/:pr/pause`.

Auth is **Tailscale ACL-gated**, not application-layer auth. Only
devices on the operator's tailnet can reach the API. This is a
deliberate choice for the solo-operator profile and would need
revisiting for a multi-operator deployment.

## Migration: inline shepherd first, then re-platform

The VA-459 epic continues unchanged. VA-461..463 implement the
three subscriptions (mergeability / CI / reviewer feedback) on the
existing inline harness. VA-464 (budget knobs) and VA-465
(dashboard sub-card) layer on top.

Once those land and have run for 4-6 weeks, a separate epic
re-platforms onto the planner:

- Subscription bodies port unchanged — their signature
  `(ctx) => Effect<SubscriptionSignal>` survives the move from
  drain-process to planner-process.
- The integration glue (where the loop runs, how state lives, how
  outcomes route) re-writes against the planner harness.
- Estimated ~1 week of porting work in exchange for 4-6 weeks of
  operational feedback that will inform the planner's prioritisation
  rules, recommendation cadence, and per-capability default toggles.

## Considered options

### Alternative 1: Don't build the planner at all

Keep shepherding inline forever. Accept the cross-PR coordination
limitation; address it manually when it bites. **Rejected**
because cross-PR coordination is the explicit driver of the user
ask, and "manually" doesn't scale past one or two open PRs.

### Alternative 2: Park inline work; pivot directly to the planner

Stop VA-461..465; design the planner from scratch. **Rejected**
because (a) the inline shepherd targets a real pain (VA-456) that
otherwise stays unaddressed during planner design, (b) operational
feedback from running the inline version is irreplaceable input to
the planner's design, and (c) the porting cost is bounded — most
subscription logic survives unchanged.

### Alternative 3: Run the planner in the dashboard container

Considered and rejected. The dashboard image is published, minimal,
and safe-to-pull-anywhere; adding Docker socket access + host secret
mounts to it would compromise those properties. The planner needs
host-side privileges, not dashboard-container privileges.

### Alternative 4: Sidecar worker container

A privileged worker container alongside the dashboard, with the
planner as a sidecar to the dashboard. **Rejected** because it
duplicates the host's existing toolbox in a long-running container
and adds ops surface (4 containers to manage instead of 1
dashboard + 1 host daemon).

### Alternative 5: Claude-in-a-loop planner (Level 2)

A Claude agent gets tools (read SQLite, post to PR, kick off
shepherd) and picks the next action via LLM reasoning each tick.
**Rejected** because: (a) the LLM becomes the control plane, which
breaks testability and restart-resilience, (b) every tick burns API
credits whether the world changed or not, and (c) the decisions the
planner actually needs to make are largely deterministic — priority
ordering, dependency reasoning, dirty-PR detection. LLM is the
right tool only at specific judgment points; Level 1 captures that.

### Alternative 6: Recommendation-only planner (no auto mode)

The planner only emits recommendations; the operator always nods
explicitly. **Rejected** as the *exclusive* mode but adopted as
the *default*: per-capability auto promotion is the long-term escape
hatch for the 80% case where the recommendation is always correct
("rebase PRs more than 24h behind base"). Forcing perpetual manual
confirmation is a constant low-grade tax.

## Consequences

### What changes

- A new long-running process on the host (planner daemon).
- New REST API endpoints on the existing dashboard listener
  (different path prefix).
- New OTLP event types and new SQLite tables (recommendations,
  actions) projected from them.
- The dashboard UI grows action buttons (Accept / Reject /
  Auto-approve) that POST to planner endpoints.
- The inline shepherd loop is retired and re-platformed onto the
  planner. The `shepherdEnabled` config flag becomes a transitional
  flag and is removed in a later release.

### What stays unchanged

- `runway run` continues to exist; the planner spawns it (with
  `--target <issue>`) rather than replacing it.
- `processIssue` (per-issue composer) is unchanged.
- The dashboard's existing read-projection model is unchanged —
  more event types, same projector pattern.
- Sandcastle, gh, git, 1Password, varlock, telemetry — all
  unchanged.

### Deferred questions

The grill that produced this ADR explicitly punted these to the
implementation epic:

- **Concurrency model**: can the planner run multiple drains in
  parallel? On a single Mac mini, probably 1-2 concurrent drains is
  the practical ceiling.
- **Crash recovery**: what state survives a daemon restart?
  (Recommendations live in SQLite via projection; in-flight actions
  are lost and would need to re-fire from re-evaluated state.)
- **Notification model**: phone push (ntfy.sh?), email, or just
  dashboard-checks-on-demand? Probably ntfy.sh as the
  self-hosted-friendly default.
- **Multi-operator auth**: Tailscale ACLs work for solo; a team
  deployment needs application-layer identity.
- **Authoritative claim model**: if the planner is running and an
  operator also runs `runway run` manually, who wins? Likely a
  Linear-label-based claim lock the planner respects.

## Promotion path back to ADR 0001

This ADR is the explicit "promote to daemon" path ADR 0001
contemplated. ADR 0001 is left as-is; this ADR is the supplement,
not the replacement. The "tail-during-run" pattern remains correct
for drain telemetry; the planner just adds a parallel emitter.
