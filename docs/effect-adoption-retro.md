# Effect adoption — retrospective (VA-356 → VA-360)

**Status:** Effect adoption is intentionally partial. Steps 1–4 shipped in full. Step 5 (VA-360) shipped its `@effect/schema` half (Linear SDK response validation + explicit "missing" review verdict). Layer-based DI for the gateways was closed as won't-do.
**Author:** Jason Kennemer
**Date:** 2026-05-11

## TL;DR

Steps 1–4 shipped useful infrastructure: typed errors at gateway boundaries, jittered exponential retries with timeouts, a single Effect program for the drain with structured logs and OTel spans, `Redacted<string>` secrets. That work is real and the costs were proportional.

Step 5 split cleanly into two halves:

- **`@effect/schema` for Linear SDK responses (shipped).** Real defensive value — an upstream field rename or type change now surfaces as a typed `LinearSchemaError` (non-retryable) at the gateway boundary instead of `cannot read property 'nodes' of undefined` deep in the call stack. The review-verdict half ended up as a typed-union refactor without a schema; the regex IS the parser, but the "no marker found" branch is now an explicit `missing` outcome with a distinct HITL reason instead of silently being bucketed as a rejection.
- **Layer-based DI for gateways (won't-do).** Overkill for a solo-dev project at this codebase size. The current `createLinearGateway(config, limiter)` constructor injection is fine; tests mock the interface directly. Layer DI is the right tool when there's plural ownership (multiple consumers, multiple environments, multiple test seams). Runway has one of each. Don't pay a refactor cost for shape we don't need.

## What got shipped

| PR  | Issue   | What                                                                                                                                                                                                                                                                                                          | Diff (+/-) |
| --- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| #41 | VA-356  | Typed error ADTs (`LinearError`, `GithubError`) at gateway boundaries; `Effect.tryPromise` wrappers; silent `.catch(() => undefined)` replaced with explicit `runSwallow` that logs.                                                                                                                          | +422/-153  |
| #42 | VA-357  | `Effect.timeoutFail` (30s default) + `Effect.retry` with `Schedule.exponential("1s").pipe(Schedule.compose(Schedule.recurs(5)), Schedule.jittered)`. Retry gated by typed `_tag` (only NetworkError / RateLimited / Timeout retry; NotFound / Unauthorized fail fast). 10 `TestClock`-driven specs.            | +620/-139  |
| #43 | VA-358  | `drainQueue: Effect<OrchestratorResult, never, never>`. `runExecaScoped` (Effect.acquireUseRelease + SIGKILL on interrupt) for git/gh. `Effect.withSpan` per pipeline stage. `Effect.log` + `Effect.annotateLogs` for structured fields. `TelemetryLive` (env-conditional OTLP). `RateLimiter` folded in.       | +1042/-424 |
| #44 | VA-359  | `Effect.Config` + `Redacted<string>` for `LINEAR_API_KEY` and `OP_SERVICE_ACCOUNT_TOKEN`. `ConfigLive` Layer + `ConfigTag`. `loadConfig()` kept as sync wrapper for `runway doctor`. 8 specs prove the secret never appears in `JSON.stringify` / `String()`.                                                  | +270/-72   |
| TBD | VA-360  | `@effect/schema` for Linear SDK responses (`Issue`, `WorkflowState`, `Team`, `IssueLabel`, `Project`) — validation at the gateway boundary, `LinearSchemaError` added to the ADT (non-retryable). Review verdict gets explicit `missing` kind; `processIssue` routes "missing" to HITL with a distinct reason. | TBD        |

**Test count:** 76 → 100 (+24 specs across the five PRs). All green at each step.
**Production code:** ~1.9k LOC of Effect-touched surface (orchestrator, gateways, config, subprocess, telemetry, git, commands/run).

## What is observable today

### Real value delivered

- **Typed errors at boundaries.** The orchestrator's `catch (err: unknown)` became `catch (err: LinearError | GithubError)`. `runSwallow` logs when it ignores a failure — the prior `.catch(() => undefined)` was invisible.
- **Retry survives transient Linear blips.** Before VA-357, a single Linear 5xx aborted the whole drain. Now: 5 jittered retries over ~31s on `NetworkError` / `RateLimited` / `Timeout`. This is the highest-value piece — Linear's GraphQL API does throw transient 5xx and 429s.
- **Subprocess cleanup on Ctrl-C.** `runExecaScoped` SIGKILLs in-flight git and `gh` children when the fiber is interrupted. Before this, an interrupted `gh pr create` could leave the process behind.
- **Secrets stay redacted on accidental log.** `String(config.linearApiKey)` returns `<redacted>`; `JSON.stringify(config)` does not contain the raw API key.
- **SDK drift fails fast and visibly (VA-360).** A renamed or removed Linear field surfaces as `LinearSchemaError: fetchReady: SDK response failed schema validation — Expected string, actual undefined` — non-retryable, clearly an operator-fix problem. Before VA-360 the symptom would have been `cannot read property 'identifier' of undefined` somewhere downstream.
- **"Review crashed" is now distinguishable from "review rejected" (VA-360).** The HITL reason for a truncated review pass is `Review pass ended without a REVIEW: marker (likely crashed or truncated): …`, not `Sub-agent review rejected: …`. The operator no longer has to argue with a verdict that wasn't actually made.
- **`gh pr create` deliberately not retried.** The typed-error surface made it natural to encode "this call is not idempotent" as `retryOn: undefined`. Pre-Effect this was just an implicit assumption.

### Real cost paid

- **Codebase growth.** `src/orchestrator.ts` went from 591 LOC to ~775 LOC. Some of that is structured-log annotations and `Effect.withSpan` decorations (genuinely useful), some is `Effect.gen` ceremony that the prior async/await accomplished in less code.
- **One sub-acceptance deferred.** Sandcastle's `run()` doesn't expose a kill handle, so an interrupt during a long agent pass abandons the Promise but the Docker container survives. Documented as a sandcastle-side limitation in PR #43.
- **`@effect/opentelemetry` brought in six OTel sub-deps.** ~290 lines in pnpm-lock. Worth it iff someone consumes the spans.
- **Optional fields needed to switch from `T | undefined` to `T?:`.** Slight friction for test fixtures (one-line fixes).
- **Five Linear-response schemas to maintain (VA-360).** Mechanical, but it is real maintenance — if Linear adds a field we care about, the schema needs an entry. Worth it for the drift signal; record the cost honestly.

## What is NOT yet observable

These PRs all shipped on 2026-05-11. The retrospective questions in VA-360's acceptance ("did Steps 1–3 reduce production incidents or debug time?") assume a feedback period that hasn't elapsed.

- **No production data on retry firing.** No way to say "retries reduced incidents" — we haven't seen one in the wild yet.
- **No OTel collector currently consumes the spans.** `TelemetryLive` is env-conditional; until `OTEL_EXPORTER_OTLP_ENDPOINT` is set and a collector is wired up, the spans go nowhere.
- **No structured-log aggregator wired.** `RUNWAY_JSON_LOGS=1` produces JSON; nothing currently parses it.
- **No near-leak prevented (yet).** `Redacted` is a defensive measure. It hasn't been needed in anger.
- **No Linear API drift caught (yet).** `LinearSchemaError` is defensive against a future drift. Until Linear ships a breaking change, it sits there waiting.

This isn't a criticism — defensive infrastructure pays off over months, not days. But the retrospective questions in the VA-360 acceptance **can't be honestly answered yet**.

## The three decision-criteria questions, answered honestly

### 1. Did Steps 1–3 reduce production incidents or debug time?

Too early to say. The infrastructure is in place; whether it actually fires in practice is a 2–4 week question, not a same-day question.

What I *can* say: a class of incidents that previously would have aborted the drain (transient Linear 5xx, hung subprocess, missing label on a HITL path, malformed SDK response) will now be handled gracefully when they happen. The expected number of those events over the next month is non-zero. The retry/timeout work in particular has obvious value for a long-running drain loop hitting a third-party API.

### 2. How comfortable is the team with reading/writing Effect code?

"Team" here is one solo developer. From the five PRs in this session, the patterns that recurred:

- `Effect.gen(function* () { ... })` for sequential composition — straightforward.
- `Effect.tryPromise({ try, catch })` for Promise interop — straightforward.
- `Data.TaggedError` for typed errors — straightforward, ergonomic with `Effect.catchTag`.
- `Effect.retry({ schedule, while })` + `Schedule.exponential.pipe(Schedule.compose, Schedule.jittered)` — required docs lookups; the `Schedule.compose` placement to bound recurrence isn't intuitive.
- `Effect.acquireUseRelease` for subprocess scope — straightforward conceptually, required defensive types for vitest mocks.
- `Effect.scoped` + `RateLimiter.make` requiring `Scope` — non-obvious; required pulling gateway construction into Effect-land.
- `Context.Tag` + `Layer.effect` for `ConfigLive` — straightforward, but only because we kept the API surface small.
- `Schema.Struct` + `Schema.decodeUnknownSync` for SDK response validation — straightforward, ergonomic.
- `@effect/opentelemetry`'s `NodeSdk.layer` — required reading the `.d.ts` to find the config shape (docs site was unhelpful).
- `Either` for unwrapping `runPromise` in tests — needed once we wanted to assert on typed `_tag` (`toMatchObject` doesn't match non-plain-object instances cleanly).

Friction points clustered around: composing schedules, the interaction between `Scope` and Layer construction, OTel package wiring, and `Data.TaggedError` instances vs `toMatchObject`. None were blockers, but each required a docs detour.

**Honest read:** Effect is comfortable enough to ship working PRs, but the API surface is large and many patterns need lookup-by-example each time. For a project that touches Effect rarely, the cognitive load won't fade.

### 3. Is the additional indirection earning its keep, or just adding ceremony for a 1.1k-LOC CLI?

The Effect-touched surface is ~1.9k LOC of production code in a project where the operator-facing surface is straightforward.

**The pieces earning their keep:**
- Typed errors with `_tag` discrimination — *would* have been worth doing even without Effect, but Effect made it natural.
- Retries + timeouts via `Schedule` — hard to beat declarative.
- Structured logs + spans — instrumentation is genuinely useful when consumed.
- `Redacted<string>` — defense-in-depth, low ongoing cost.
- `@effect/schema` for SDK responses — small ongoing maintenance, catches a category of bug that's annoying to debug.

**The pieces that would have been ceremony (skipped):**
- Layer-based DI for the gateways. Worth doing if a second gateway implementation appears, a second consumer appears, or a much larger test seam emerges. None of those are true today.

For this codebase size, the cost-benefit landed at about the right place. Effect doesn't have to be all-or-nothing, and "use the parts that pay off" is a workable posture.

## Decision on VA-360

### `@effect/schema` validation at Linear SDK boundaries — **shipped**

Schemas for `Issue`, `WorkflowState`, `Team`, `IssueLabel`, `Project` live in `src/linear.ts`. Every SDK response that runway reads back goes through `decode…Node(raw)`. A drifted node throws `ParseError` synchronously, which `classifyLinearError` translates to `LinearSchemaError`. `LinearSchemaError` is **deliberately not** in `RETRYABLE_LINEAR_TAGS` — schema drift is an operator-fix problem, not a transient blip.

Five tests in `src/linear-schema.test.ts` prove this end-to-end: a malformed `issue` node, a wrong-type `title`, a state node missing `id`, the happy path, and the "schema errors don't retry" invariant.

### Review verdict parsing — **typed-union refactor, no schema**

The original VA-360 scope suggested using `@effect/schema` here, but the regex IS the parser — there's no upstream structured shape for the schema to validate. The valuable change was making "missing marker" a distinct outcome instead of silently bucketing it as rejected. `parseReviewVerdict` now returns `{ kind: "approved" | "rejected" | "missing"; reason: string }`, and `processIssue` routes "missing" to HITL with `Review pass ended without a REVIEW: marker (likely crashed or truncated): …`. The operator can now distinguish "agent reviewed and rejected my work" from "review crashed before it could decide".

### Layer-based DI for gateways — **won't-do**

The current constructor injection (`createLinearGateway(config, limiter)`, `createGithubGateway()`) is fine. Tests construct mocks that conform to the `LinearGateway` / `GithubGateway` interfaces directly — no `Context.Tag` machinery needed. Pulling gateways through Layers would:

- Move gateway construction from `commands/run.ts` to a layer file.
- Force test setup to use test-layers instead of direct mocks.
- Add `Context.Tag` boilerplate without solving a real problem.

The current pattern works. Layer DI is the right answer when there's plural ownership. Runway doesn't have it. Revisit if the team grows or a second `LinearGateway` implementation appears (e.g., for a different issue tracker).

## What we keep from Steps 1–4 (no change)

Everything that shipped. No rollback recommended.

## Open follow-ups (not part of VA-360)

- **Sandcastle kill handle.** Sandcastle's `run()` doesn't expose a way to terminate the in-flight agent. Today an interrupted drain abandons the Promise but the Docker container keeps going. A proper fix needs sandcastle-side API work — track as a sandcastle issue, not runway.
- **Bounded parallelism (`Effect.forEach({ concurrency })`).** Mentioned in VA-358's scope but not its acceptance. The seen-set logic assumes sequential drain. Doing this right means reworking dedup. Worth scoping as a separate issue if/when concurrent agents become a real need.
- **Wire an OTel collector.** The spans go nowhere until `OTEL_EXPORTER_OTLP_ENDPOINT` is configured. If we want trace data, the next step is choosing where to send it.

## Closing note

Effect adoption is partial. That's the right outcome for a project this size. The pieces that fit (typed errors, retries, structured logs, redacted secrets, scoped subprocesses, schema validation at SDK boundaries) are in place and worth keeping. The pieces that don't (Layer DI for one-of-each gateways) we're choosing to skip.

If the team grows, the codebase grows, or a specific incident makes one of the deferred items load-bearing, revisit. Effect doesn't have to be all-or-nothing.
