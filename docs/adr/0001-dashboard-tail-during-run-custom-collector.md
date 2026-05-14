# Dashboard architecture: tail-during-run with custom collector

The runway dashboard is a custom OTLP collector + SQLite + Effect-Platform HTTP
UI, fed by runway emitting OTel traces and logs during each one-shot `runway
run` invocation. Runway stays a CLI; "live" means "during an active drain,"
and history is a side-effect of persisting the same event stream the live view
subscribes to.

## Status

Accepted (2026-05-13).

## Considered options

- **Daemonize runway.** Turn `runway run` into a long-running service so the
  dashboard always has a live source. Rejected: large architectural shift for
  a benefit (continuous live view) that doesn't fit how a solo operator uses
  runway today. Can be promoted later if usage patterns change.
- **Point runway at a generic OTel backend (Jaeger / Tempo / Honeycomb).** Zero
  new code. Rejected because the dashboard's job is *runway lens on Linear* —
  every screen is shaped around the issue process, not the span tree. A
  generic trace viewer would be a debugging tool, not an operations dashboard.
- **Local collector → Grafana.** Middle ground. Rejected for the same reason —
  Grafana panels are general-purpose, and modelling "issue process with HITL
  reason and PR link" inside Grafana fights the tool.
- **Side-channel events outside OTel.** Have runway write domain-shaped events
  to a separate transport. Rejected because it duplicates the emit path for
  no real gain — the OTel pipeline already exists in `telemetry.ts`.

## Consequences

- The dashboard's "live" tab is empty between drains — the last drain stays
  pinned at the top instead, which is honest about how the system works.
- The collector must outlive any single drain. It runs as an always-on Docker
  container; v1 ships as `docker-compose.yml` at the repo root, v2 ships as a
  published image plus a `runway dash up/logs/stop` subcommand.
- Runway gains a dependency on `@opentelemetry/sdk-logs` so `Effect.logInfo`
  calls reach the collector over OTLP rather than only stdout.
- Schema lives in SQLite as denormalised typed tables (`drains`,
  `issue_processes`, `agent_iterations`, `log_records`, `linear_snapshots`)
  with a `raw_spans` JSON escape hatch for debugging.
- Promotion path to a daemon (or to a remote collector behind a tunnel for
  runway running on Vercel Sandbox / similar) is open — OTLP HTTP is
  network-native, and the schema is independent of where runway runs.
