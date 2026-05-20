# Runway — Domain Context

Runway is a Linear-driven orchestrator that drives coding agents on Sandcastle
(Docker sandboxes). One `runway run` invocation drains a Linear queue: it picks
ready issues, runs an agent against each, and opens a PR (or flags HITL).

## Glossary

### Drain
A single `runway run` invocation. Bounded in code by the `drainQueue` Effect
span. A drain contains zero or more **issue processes**. When the drain exits,
runway is gone — there is no resident daemon.

### Issue process
The unit of work for one Linear issue, attempted once within a drain. Bounded
by the `processIssue` span. Each issue process is composed of phases
(implement → review → finalize, with optional HITL routing) and terminates in
an **outcome** (`opened`, `hitl`, `errored`, etc. — see `IssueOutcome`).

The issue process is the primary unit users reason about: "what happened with
VA-355?" The dashboard is organised around issue processes — one row per
issue process, drains group them, agent iterations are children.

### Agent iteration
A single sandcastle (Docker) invocation inside an issue process. Bounded by
the `impl-iter-N` span. Multiple iterations can occur if an implement pass
needs another pass after review. Surfaced in the dashboard's detail view only,
not the top-level list.

### Outcome
The terminal verdict of an issue process. Today: `opened` (PR opened),
`hitl` (handed to a human), `errored` (a phase failed). Each outcome has a
detail string for human consumption. Outcomes are emitted on the
`processIssue` span as attributes and on the per-drain exit summary.

### HITL (Human-in-the-loop)
The escape hatch when the agent's work needs a human verdict — e.g., review
rejected, deps unsatisfied, label routing miss. The issue process terminates
with a `hitl` outcome and a reason; the human is expected to pick it up in
Linear directly.

### Todo queue
The set of Linear issues in the configured "ready" status (typically `Todo`)
that runway is eligible to pick on the next drain. Distinct from issues
currently being processed (`In Progress`) or already terminal. The dashboard
surfaces the Todo queue alongside runway-touched issues so the operator can
see "what's coming" without leaving the dashboard.

### Shepherd
The post-finalize loop that drives an opened PR toward merge by reacting to
mergeability conflicts, CI failures, and reviewer feedback. Initial
implementation (VA-459 epic) runs **inline** in the drain that opened the PR
— the loop ends when the PR merges, the iteration budget exhausts, or any
subscription emits a non-actionable signal. May later be subsumed by the
**Planner**.

### Planner
A proposed always-on host daemon (target host: a Mac mini reachable via
Tailscale) that owns queue selection and cross-PR coordination — the parts of
runway's workflow that benefit from a persistent, cross-time, cross-process
view a one-shot CLI can't maintain. The Planner is a **deterministic state
machine** that consults Claude as a tool at specific decision points
(priority tie-breaking, ambiguous reviewer feedback, slow PR progress
judgments), not a Claude-in-a-loop agent.

The Planner is **recommendation-led** by default: each capability has a
toggle (`manual` / `suggest` / `auto`); `suggest` is the default. The
operator nods or rejects recommendations from the dashboard UI or via the
Planner's HTTP API (reachable from laptop or phone over Tailscale).

The Planner emits its decisions as OTLP events; the dashboard's projector
writes them to SQLite alongside drain events. The dashboard remains the
**sole SQLite writer**; the Planner's in-flight reasoning lives in memory.

Distinct from the Shepherd: the Shepherd is the inline-in-drain loop that
ships first; the Planner is the long-running daemon that may eventually
subsume both queue selection and shepherding once the inline version has
taught us which decisions matter.
