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
