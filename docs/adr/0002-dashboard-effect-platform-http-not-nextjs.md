# Dashboard UI: Effect Platform HTTP, not Next.js

The runway dashboard is served by an Effect Platform HTTP server rendering
server-side HTML with htmx (SSE for the detail pane, polling for the list),
not Next.js. This is a deliberate deviation from the Valesco standard stack
(Next.js + RSC) on the grounds that the dashboard is an internal, single-
operator tool whose surface area doesn't justify a full React build pipeline.

## Status

Accepted (2026-05-13).

## Considered options

- **Next.js (Valesco standard).** Familiar, RSC fits the list-and-detail
  shape. Rejected for this surface: an internal tool bound to `127.0.0.1`
  doesn't need a SPA, and the Docker image bloats with the Next.js runtime.
- **Plain Node + Express + a template engine.** Lowest-tech. Rejected because
  it diverges from the rest of the runway codebase's Effect-first style for
  no real gain.

## Consequences

- Dashboard code reuses runway's existing Effect idioms (Layer, Effect.gen,
  Schema for parsing OTLP payloads), so a runway contributor can read both
  sides of the boundary without context-switching.
- The dashboard container stays slim — no React, no bundler, no build step.
- "Live tail" interactivity uses htmx + SSE rather than client React state.
  This is sufficient for log streaming and span-state transitions; the
  ceiling is lower than a SPA, but the ceiling matches the product surface.
- This decision is **scoped to the runway dashboard only**. New
  product-facing surfaces — anything in front of a customer — still default
  to the Valesco standard stack (Next.js + Supabase + shadcn/ui).
