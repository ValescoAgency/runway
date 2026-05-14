# Changelog

All notable changes to runway are documented here. Versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); breaking
changes bump the major.

## 0.8.1 — 2026-05-14

Patch release fronting two Linear-gateway fixes that the 2026-05-14 PM drain surfaced. Both quietly degraded the HITL / prior-attempt-feedback loops in ways that only show up under real operator conditions.

### Fixed

- **`fetchComments` rejected comment nodes where `user` was absent from the payload** ([PR #69](https://github.com/ValescoAgency/runway/pull/69), VA-415). The schema declared `user: Schema.NullOr(...)` — accepting present-and-null, but not missing-entirely. Linear's API can omit `user` on system / integration / deleted-user comments, which made the decoder throw; the error was swallowed per VA-383's never-block AC and `priorReviewFeedback` quietly fell back to description-only. Net effect: a reviewer's rejection reason that should have reached the retry's impl agent never did, and the retry walked back into the same defect. Field shape is now `Schema.optional(Schema.NullOr(...))`; downstream code already null-coalesces.
- **`applyLabel` filtered `issueLabels` by team only, silently excluding workspace-scope labels** ([PR #69](https://github.com/ValescoAgency/runway/pull/69), VA-416). Linear labels can be scoped to either a single team OR the workspace; the default `ready-for-human` HITL label lives at workspace scope in most setups. The previous filter (`team: { id: { eq: team.id } }`) required a team match, so the label never resolved, `LinearNotFound` threw, and HITL routing emitted the "Note: could not apply" fallback comment instead of applying the label. Workspace-scope is the right shape for cross-team operational labels — runway now searches by name alone and prefers a team-scoped match when one exists (workspace-scoped is the fallback). The team-vs-workspace name-collision edge resolves to team-scoped.

### Internal — release stats

- **1 commit since 0.8.0** (1 fix bundling 2 Linear tickets).
- All 39 test files, 251 specs pass (4 new: missing-user decode, workspace-only label match, team-beats-workspace on tie, not-found-at-any-scope still throws LinearNotFound).

## 0.8.0 — 2026-05-14

Operator-tunable iteration budget, the first two slices of the operations dashboard ([VA-385](https://linear.app/valescoagency/issue/VA-385)), and two fixes that close round-trip loops with Linear. The headline is `--impl-turns` — the sandcastle inner turn budget per impl phase is no longer hardcoded to `1`, so harder issues can complete in a single attempt instead of round-tripping back to Todo. The headline fix is the `Closes` magic-word swap in `buildPrBody`, which finally lets a runway-generated PR auto-transition its Linear issue to Done on merge.

### Added

- **`--impl-turns` CLI flag + `RUNWAY_IMPL_TURNS` env var** ([PR #67](https://github.com/ValescoAgency/runway/pull/67), VA-414). New `RunwayConfig.implTurns: number` field, defaulting to `3`, validated as a positive integer. Replaces the hardcoded `maxIterations: 1` inside the implement loop's sandcastle call. Distinct from `RUNWAY_MAX_ITERATIONS` (the outer impl re-prompt loop, which only fires when the agent fails to signal `IMPL: DONE`/`IMPL: BLOCKED` at all); the help text and ENV section both spell out the difference. Both `--impl-turns N` and `--impl-turns=N` forms accepted; CLI override beats env value.
- **Operations dashboard — slice 1: tracer plumbing** ([PR #63](https://github.com/ValescoAgency/runway/pull/63), VA-386). End-to-end OTel trace plumbing from runway → custom collector → SQLite → minimal dashboard. `docker-compose.yml` + `Dockerfile.dashboard` at the repo root stand up a collector container exposing OTLP HTTP on `OTLP_PORT` (4318) and the dashboard on `DASHBOARD_PORT` (3001). `src/dashboard/projector.ts` projects `drainQueue` and `processIssue` spans into typed `Drain` / `IssueProcess` rows; `src/dashboard/storage.ts` writes them to SQLite (with a `raw_spans` escape hatch); `src/dashboard/server.ts` serves a list view at `/`. Wired to runway-run via `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`.
- **Operations dashboard — slice 4: agent iterations + phase timeline** ([PR #66](https://github.com/ValescoAgency/runway/pull/66), VA-389). `impl-iter-N` spans now project into an `agent_iterations` table keyed on the parent `processIssue` spanId; detail pane (`/issue/<traceId>/<spanId>`) renders a horizontal phase timeline showing implement → review → finalize durations, with implement expanding to per-iteration index / duration / exit status. Hitl-loop (review-rejected) iterations are covered at both projector and view layers.
- **`runway init` scaffold for self-hosted AFK runs** ([PR #61](https://github.com/ValescoAgency/runway/pull/61)). `runway init` now writes a `.sandcastle/Dockerfile` (vendored from `@ai-hero/sandcastle`'s `CLAUDE_CODE_DOCKERFILE`) and an `.env.schema` that wires `CLAUDE_CODE_OAUTH_TOKEN` and `GH_TOKEN` through varlock + 1Password CLI for in-container secret resolution. Removes the need to clone the runway repo to drive a drain against your own project.

### Fixed

- **`buildPrBody` emits `Closes VA-NNN` instead of `Refs VA-NNN`** ([PR #65](https://github.com/ValescoAgency/runway/pull/65), VA-412). Linear's GitHub integration only auto-transitions an issue to Done on merge when the PR body uses one of the magic words (`Closes`/`Fixes`/`Resolves`); `Refs` only attaches the PR. The previous body left every merged runway PR's Linear issue stuck In Progress until a human flipped it manually. `buildPrBody` is now exported and unit-tested with both a positive assertion and a paranoid negative regex against the old wording.
- **`loadConfig` no longer reads `process.env` directly in tests** ([PR #62](https://github.com/ValescoAgency/runway/pull/62), VA-411). The "minimal valid config" test asserted that optional `RUNWAY_*` env vars resolve to `undefined`, but it read from the inherited `process.env` — so any host shell exporting `RUNWAY_LINEAR_PROJECT` (e.g. via `.envrc` / direnv) broke the test locally even though CI passed. `loadConfig(env?)` and `makeConfigLive(env?)` now accept an explicit env map routed through `Effect.withConfigProvider`; the brittle `afterEach` + dynamic `await import("./config.js")` dance is gone. Production callers default to `process.env` so the public API is unchanged.
- **Security dep bump** ([PR #64](https://github.com/ValescoAgency/runway/pull/64)). `@opentelemetry/exporter-trace-otlp-http` 0.217.0 → 0.218.0 via Snyk auto-PR to reduce vulnerabilities surfaced on the default branch.

### Internal — release stats

- **7 commits since 0.7.1** (3 feat + 3 fix + 1 chore).
- All 39 test files, 247 specs pass.

## 0.7.1 — 2026-05-14

Patch release: tightens `fetchReady`'s queue-picker contract so runway only attempts issues it should actually pick up.

### Fixed

- **`fetchReady` ignored `blockedBy` and the HITL label** ([PR #58](https://github.com/ValescoAgency/runway/pull/58), VA-394). The queue picker previously returned every `Todo` issue regardless of dependency state or applied labels — so sequential dependency chains could advance out of order, and triage's `ready-for-human` flag (also applied by runway on prior HITL escapes) was silently overridden. Per-candidate eligibility now:
  - Skips any issue with at least one `blocks`-type `inverseRelation` whose blocker is in a non-terminal workflow state (anything other than `completed`/`canceled`).
  - Skips any issue carrying `config.hitlLabel` (default `ready-for-human`).
- Eligibility uses the SDK's chained `labels()` and `inverseRelations()` calls, both validated through narrow `effect/Schema` decoders. Non-`blocks` relation types (`duplicate`, `related`) do not gate pickup. Drift in either relation node surfaces as the usual `LinearSchemaError` rather than a downstream runtime crash.

### Internal — release stats

- **1 commit since 0.7.0** (1 fix).
- All 34 test files, 189 specs pass. New: `src/linear-filter.test.ts` (6 specs covering the eligibility filters); `src/linear-schema.test.ts` happy path updated to mock the new chained calls.

## 0.7.0 — 2026-05-14

Closes the **reject → comment → retry feedback loop** that was silently broken: when the sandcastle review agent rejected an issue and HITL posted the rejection reason as a Linear comment, the next runway pickup of that issue did not fetch those comments and the implementer would silently re-bug. One feat ([PR #56](https://github.com/ValescoAgency/runway/pull/56), VA-383) plus a dep-freshening pass — every dep ≥2 days old at publish time got bumped, including four majors (`@linear/sdk` 41→84, `typescript` 5→6, `zod` 3→4, `@types/node` 22→25). All 183 tests pass under the bumped tree.

### Added

- **Prior-attempt review feedback surfaced to the impl agent** ([PR #56](https://github.com/ValescoAgency/runway/pull/56), VA-383). `LinearGateway` gains `fetchComments(issueId)` and `viewer()`. The orchestrator resolves the viewer once per drain to seed the default comment-author allowlist, then per-issue fetches comments **before** posting "Runway picked up …" so the agent doesn't see its own bookkeeping. The new `formatPriorFeedback(comments, allowlist)` helper (exported from `src/prompts.ts`) filters by author **and** strips known runway bookkeeping prefixes (`Runway picked up`, `Runway opened a PR`, `Runway hit a startup failure`, `Note: could not apply`), then renders a `# Review feedback from prior attempts` block injected via the new `{{PRIOR_REVIEW_FEEDBACK}}` slot in `prompts/implement.md`. Block injects on every iteration of a run, not just iteration 1 — drift in iteration 3 still needs the original rejection context.
- **`RUNWAY_COMMENT_AUTHOR_ALLOWLIST` env var** ([PR #56](https://github.com/ValescoAgency/runway/pull/56), VA-383). Comma-separated Linear user names whose comments get surfaced. Unset → defaults to the Linear user the API key authenticates as (covers the solo-dev case where reviewer agent and repo owner share an account). Set this when the reviewer agent runs under a distinct service-account identity.

### Internal — dep bumps (no behavior change)

- `@linear/sdk` 41 → 84. 43-major-version jump caught up in one shot; typecheck against v84's TS types is clean for every call runway makes.
- `typescript` 5 → 6. Effect + Schema type machinery absorbs most of the strictness changes; codebase compiles unchanged.
- `zod` 3 → 4. Only used in `src/policy.ts` for the policy-file schema (basic `z.object`/`z.array`/`z.string` surface); none of v4's breaking changes touch it.
- `@types/node` 22 → 25. Engine pin remains `>=22`; types-only.
- Caret-range bumps: `vitest` 4.1.5→4.1.6, `@commitlint/cli` + `config-conventional` 21.0.0→21.0.1, `@opentelemetry/semantic-conventions` 1.40.0→1.41.1, `@types/node` 22.19.18→22.19.19 (later superseded by the major bump).
- Skipped: `@opentelemetry/exporter-trace-otlp-http` 0.217→0.218 (0.x minor = effectively major; published 2026-05-13, only 1 day old at release time, below the 2-day stability threshold this repo applies for proactive bumps).

### Internal — release stats

- **6 commits since 0.6.0** (1 feat + 5 chore-dep).
- All 33 test files, 183 specs pass under every intermediate dep state.

## 0.6.0 — 2026-05-12

Architectural decomposition release. The five-candidate architecture punch list (VA-361 → VA-365, plus follow-up VA-367) all land, bringing `commands/` to a uniformly thin wiring layer and pushing domain logic into focused modules in `src/`. One new public flag, one bug fix, and the agent default model bumps to Claude Opus 4.7. Seven PRs ([#47](https://github.com/ValescoAgency/runway/pull/47) → [#54](https://github.com/ValescoAgency/runway/pull/54)) plus three direct-master fixes (VA-368, VA-369 — paper-trail filed retroactively).

### Added

- **`runway doctor --check=NAME` flag** ([PR #50](https://github.com/ValescoAgency/runway/pull/50), VA-364). Diagnostic seam with 16 adapters under `src/diagnostics/`. Each adapter declares its name, section, and tier; the runner filters by `--check=NAME` (repeatable) and by the active tier. `--check=help` lists available names grouped by section. Default behavior unchanged — running `runway doctor` with no flags is bit-for-bit identical to the pre-0.6.0 output.
- **Claude Opus 4.7 is now the default agent model** ([commit `7a542bb`](https://github.com/ValescoAgency/runway/commit/7a542bb), VA-370). Both the implementation pass and the reviewer pass run on `claude-opus-4-7` from this release forward (was `claude-opus-4-6`). Same wire protocol, same pricing tiers.

### Fixed

- **Stale `agent/<issue>` branch reused on retry** ([PR #54](https://github.com/ValescoAgency/runway/pull/54), VA-366). When a prior attempt failed before any commits, the branch tip stayed at the old base — sandcastle would recreate the worktree on the stale tip instead of forking from current `baseBranch` HEAD. `processIssue` now calls `pruneStaleAgentBranch(cwd, base, branch)` after the Linear claim and before the implement loop: branch missing → no-op, branch with commits ahead → preserve, branch with zero commits ahead → `git branch -D`. Reuses `hasCommits` from VA-367.
- **`runway doctor` container probe always failed** ([commit `69ef540`](https://github.com/ValescoAgency/runway/commit/69ef540), VA-368). `docker run --rm <image> bash -lc ...` was passing `bash` as an arg to the image's `ENTRYPOINT` (`sleep infinity`); the probe never actually ran the shell. Adding `--entrypoint bash` makes the intent unambiguous. Also: workspace-level Linear labels (created without a team scope, like Flightplan's `ready-for-human`) were silently filtered out by the doctor's team-only label filter; the filter is now an OR of workspace + team scope.
- **`runway upgrade-repo` round-trip artifact `op://vault/item/credential/credential`** ([commit `6ed6ecd`](https://github.com/ValescoAgency/runway/commit/6ed6ecd), VA-369). The op:// item-capture regex used a greedy `[^"]+` that swallowed any trailing `/field`, so re-renders appended a second `/credential` to the already-captured path. The capture is now `([^/"]+)` (stops at first slash) with an optional `(?:/[^"]*)?` to absorb any trailing field. Tests updated to assert the new shape (commit `f107d9d`).

### Internal — architectural decomposition (no behavior change)

- **`orchestrator.ts` 781 → 280 LOC, phases extracted** ([PRs #47, #48](https://github.com/ValescoAgency/runway/pull/48), VA-363). New modules: `src/implement.ts` (`runImplementLoop` + `parseImplVerdict`), `src/review.ts` (`runReviewPass` + `parseReviewVerdict`), `src/finalize.ts` (`finalize`), `src/sandcastle.ts` (`runSandcastle`, `dockerEnv`, `stringifyResult`), `src/hitl.ts` (`flagHitl`, `handleProcessFailure`). `captureDiff` + `captureCommitLog` moved to `src/git.ts`. Each phase has its own narrow Deps interface. `orchestrator.test.ts` 857 → 503 LOC (−41%).
- **`commands/doctor.ts` 875 → 210 LOC, Diagnostic seam** ([PR #50](https://github.com/ValescoAgency/runway/pull/50), VA-364). 16 adapter files under `src/diagnostics/`, registry-driven runner, render layer in `src/diagnostics/render.ts`. Tier filtering happens at the registry level, not inline in each check.
- **`commands/init.ts` 554 → 141 LOC + `commands/upgrade-repo.ts` 497 → 103 LOC** ([PRs #51, #52](https://github.com/ValescoAgency/runway/pull/52), VA-365). New `src/scaffolder.ts` + 5 phase files (preflight/dockerfile/image/varlock/verify); new `src/repo-upgrade.ts` (orchestrator + parseOpRefs + renderers). Command files now do argv parsing + a single domain call each.
- **`prompts.ts` deepened from 6 leaves to 2 deep calls** ([PR #53](https://github.com/ValescoAgency/runway/pull/53), VA-361, also closes VA-362). `renderImplementPrompt({issue, policy, previousIterations})` and `renderReviewPrompt({issue, diff, commits})` replace the load + vars + render chain. `renderForbiddenPathsBullet` absorbed from `policy.ts` (which becomes a pure data module). `buildIterationSummary` + `tailOfMessage` move to `implement.ts` as private helpers. Tests rewritten as contract tests against the deep API.
- **`hasCommits` moved to `src/git.ts` + `HitlDeps` split** ([PR #49](https://github.com/ValescoAgency/runway/pull/49), VA-367). All git plumbing lives in one module. `HitlDeps = {config, linear}` for `flagHitl`; `FailureRoutingDeps = HitlDeps & {cwd, baseBranch}` for `handleProcessFailure` — each function's surface now matches what it actually uses.

### Internal — release stats

- **11 commits since 0.5.0** across 7 PRs + 3 direct-master fixes.
- **+4,815 / −2,609 lines** (net +2,206 — almost all of the addition is new focused test files).
- **176 Vitest specs across 33 files** (up from 100 across 11 files at 0.5.0). New: `src/diagnostics/*.test.ts` (×17), `src/implement.test.ts`, `src/review.test.ts`, `src/hitl.test.ts`, `src/scaffolder.test.ts`, `src/commands/doctor.test.ts`; `src/commands/upgrade-repo.test.ts` → `src/repo-upgrade.test.ts`.
- **`commands/` uniformly thin**: doctor 210, run 160, init 141, upgrade-repo 103; `upgrade.ts` 229 (self-upgrade — CLI orchestration only, no domain to extract).
- No new runtime deps. No removed deps.

## 0.5.0 — 2026-05-11

Effect adoption across the gateway and orchestrator layer. The CLI surface is unchanged; what changes is what happens inside `runway run` when something goes wrong, when a secret gets logged, when the Linear API changes shape, and when an operator wants to ask the orchestrator what it just did. Five PRs ([VA-356](https://github.com/ValescoAgency/runway/pull/41) → [VA-360](https://github.com/ValescoAgency/runway/pull/45)) landed in order, each independently reviewable; see [`docs/effect-adoption-retro.md`](./docs/effect-adoption-retro.md) for the retrospective.

### Added

- **Typed errors at gateway boundaries** ([PR #41](https://github.com/ValescoAgency/runway/pull/41), VA-356). Linear and GitHub gateway methods now return `Effect<T, LinearError | GithubError>` instead of throwing untyped exceptions. `LinearError` is a discriminated union of six tagged variants (`LinearNotFound`, `LinearUnauthorized`, `LinearRateLimited`, `LinearNetworkError`, `LinearTimeout`, `LinearSchemaError`); `GithubError` covers `GhCliMissing`, `PushFailed`, `PrCreateFailed`, `GithubTimeout`. Every gateway failure is now classified at the boundary it crossed rather than bubbling up as a generic `Error` for the orchestrator to introspect.
- **Jittered exponential retries + per-call timeouts on retryable gateway failures** ([PR #42](https://github.com/ValescoAgency/runway/pull/42), VA-357). `applyLinearPolicy` and `applyGithubPolicy` wrap each method with `Schedule.exponential("1 second")` ∘ `Schedule.recurs(5)` ∘ `Schedule.jittered`, gated by a typed `while` predicate so non-retryable variants (`LinearNotFound`, `LinearUnauthorized`, `LinearSchemaError`, `PrCreateFailed`) short-circuit on first failure rather than burning the retry budget. Timeouts (`Effect.timeoutFail`) map to the gateway's typed `Timeout` variant, themselves retryable. Ten `TestClock` specs in `src/gateway-policy.test.ts` pin the schedule shape.
- **OpenTelemetry spans + structured JSON logs over the full drain loop** ([PR #43](https://github.com/ValescoAgency/runway/pull/43), VA-358). `drainQueue` is now an `Effect` program; every issue is processed under an `Effect.withSpan("processIssue", { attributes: { "linear.issue.id", "linear.issue.identifier" } })` with child spans for branch creation, agent invocation, review, and PR open. Spans export to OTLP HTTP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set; otherwise the SDK uses a no-op layer (zero overhead, no env required). Logs go through `Logger.jsonLogger` with per-issue annotation, so a drain across N issues produces N greppable streams keyed by identifier.
- **Linear rate limit honored across the full drain** ([PR #43](https://github.com/ValescoAgency/runway/pull/43), VA-358). A scoped `RateLimiter.make({ limit: 30, interval: "1 minute" })` wraps every Linear gateway call. Before this, a long queue could trip Linear's API quota mid-drain; now requests queue at the rate limit's boundary regardless of how many issues are in flight or how aggressively retries fire.
- **Scoped subprocess lifecycle for git / gh / claude-code invocations** ([PR #43](https://github.com/ValescoAgency/runway/pull/43), VA-358). New `runExecaScoped` in `src/subprocess.ts` uses `Effect.acquireUseRelease` to guarantee subprocess termination on cancellation, error, or timeout. Previously a Ctrl-C during agent invocation could leave orphan claude-code processes; now the scope's release hook always fires.
- **Effect.Config + Redacted secrets** ([PR #44](https://github.com/ValescoAgency/runway/pull/44), VA-359). Replaces the Zod-based env loader with `Effect.Config`. `LINEAR_API_KEY` and `OP_SERVICE_ACCOUNT_TOKEN` are `Redacted<string>` — they render as `<redacted>` in `toString`, `JSON.stringify`, and structured log output, and are unwrapped via `Redacted.value` only at the SDK boundary (Linear client construction, docker env). Config consumers receive a typed `RunwayConfig` from `ConfigTag` (a `Context.Tag` + `Layer.effect`). `loadConfig()` retained as a sync escape hatch for code paths not yet inside the Effect graph.
- **Schema validation at Linear SDK response boundaries** ([PR #45](https://github.com/ValescoAgency/runway/pull/45), VA-360). Every Linear SDK response (`Issue`, `WorkflowState`, `Team`, `IssueLabel`, `Project`) is decoded via `Effect.Schema.decodeUnknownSync`. Drift (a missing `identifier`, a `title` that became a number) now surfaces as a typed `LinearSchemaError` with the gateway-method label attached, rather than as a downstream `cannot read property` crash that the operator has to trace by hand. Five specs in `src/linear-schema.test.ts` prove the drift detection and that `LinearSchemaError` is NOT in the retryable set (schema drift is operator-fix, not transient).
- **Explicit `missing` verdict on the review pass** ([PR #45](https://github.com/ValescoAgency/runway/pull/45), VA-360). `parseReviewVerdict` previously collapsed "no marker found" into `kind: "rejected"`, silently routing reviewer errors as approvals-with-rejection-reason. Now returns `kind: "approved" | "rejected" | "missing"`; the `missing` branch routes to HITL with a different reason (`Reviewer produced no verdict marker`) so operators can distinguish a missing reviewer pass from a substantive rejection.

### Internal

- **5 PRs, +2,782 / −600 lines, 100 Vitest specs across 11 files** (up from 76 across 8 files at 0.4.0). New test files: `gateway-policy.test.ts`, `config.test.ts`, `linear-schema.test.ts`.
- **New deps**: `effect@3.21.2`, `@effect/opentelemetry`, `@opentelemetry/sdk-trace-base`, `@opentelemetry/exporter-trace-otlp-http`. **Removed**: `zod` from `src/config.ts` (still in `src/policy.ts` for `.runway/policy.yml`).
- New exports from `src/linear.ts`: `LinearError` ADT, `applyLinearPolicy`, `LinearSchemaError`, the per-entity schemas.
- New module `src/telemetry.ts` (`TelemetryLive` layer), `src/subprocess.ts` (`runExecaScoped`).
- `RunwayConfig` optional fields changed from `T | undefined` to `T?:` so partial test fixtures compile without explicit `undefined`.
- Retrospective written at `docs/effect-adoption-retro.md`: what shipped, what's earning its keep, why Layer-based DI was closed as won't-do.

## 0.4.0 — 2026-05-11

Trust-pipeline release. Eight bugs that, in aggregate, let the agent produce real work while the operator saw an idle-looking Linear inbox: the reviewer's substantive rejections were silently swallowed, the iteration loop burned 3-5× the budget on already-converged issues, the queue could loop forever on a single broken issue, and the bundled denylist quietly skipped any AC that touched CI. All addressed.

### Added

- **`IMPL: DONE | BLOCKED — <reason> | CONTINUE` termination contract on the implementation pass** ([PR #28](https://github.com/ValescoAgency/runway/pull/28), VA-350). Mirrors the reviewer pass's `REVIEW: APPROVED | REJECTED — <reason>` contract. The impl agent ends every iteration with one of three markers. `DONE` → proceed to review; `BLOCKED — <reason>` → short-circuit straight to HITL with the reason attached to the Linear comment (reviewer pass does **not** run); `CONTINUE` or missing → run another iteration up to `maxIterations`. Wired through sandcastle's `completionSignal` so the loop stops early as soon as the agent emits a terminating marker.
- **Iteration memory between impl passes** ([PR #35](https://github.com/ValescoAgency/runway/pull/35), VA-349). Replaces the single sandcastle `run({ maxIterations: N })` call with an external loop. Iteration N+1 receives a `## Previous iterations` block at the top of its prompt — running commit log + tail of last iteration's final message — and an explicit instruction not to re-explore the repository. Before this every iteration was a fresh Claude Code invocation with no awareness of prior iterations; the agent re-ran 30+ exploration commands every time. Combined with VA-350, a converged issue now exits after 1–2 iterations instead of always running all `maxIterations`.
- **Configurable write-path policy + per-run override** ([PR #36](https://github.com/ValescoAgency/runway/pull/36), VA-352). Replaces the hardcoded denylist in `prompts/implement.md` with a policy rendered at agent-invocation time. Sources, in order: (1) conservative defaults (`.env*`, `*.pem`, `*.key`, `pnpm-lock.yaml`, `.sandcastle/**`, `.github/workflows/**`); (2) `.runway/policy.yml` in the target repo with `allowedPaths` / `forbiddenPaths`; (3) `runway run --allow-paths=<glob>[,glob]` for a one-off invocation. The rendered bullet now tells the agent: when an AC requires a forbidden path, emit `IMPL: BLOCKED — issue requires modifying <path>…` rather than silently skipping. `runway doctor` surfaces the active policy.
- **Per-issue verdict trail in `runway run`'s exit summary** ([PR #37](https://github.com/ValescoAgency/runway/pull/37), VA-355). Drains now end with a per-issue trail (`VA-312 APPROVED → PR opened https://…`, `VA-313 HITL Sub-agent review rejected: TOCTOU race in …`, `VA-314 REVERTED → Todo missing image`, `VA-315 INFRA_ERROR varlock validation failed`) so the operator can scan results without opening Linear.
- **`runway doctor` "Linear configuration" preflight** ([PR #38](https://github.com/ValescoAgency/runway/pull/38), VA-354). New required section validates the team key, the three workflow states, and the HITL label all exist on the workspace before any agent run. Failures show the workspace's actual available names so the operator can fix env or workspace without parsing log files.

### Fixed

- **`runway run` no longer loops forever on a deterministic startup failure** ([PR #27](https://github.com/ValescoAgency/runway/pull/27), VA-344). VA-342's revert-to-`Todo` on infra failure interacted badly with the queue loop: a broken `.env.schema`, missing image, or expired token caused `runway run --max N` to loop on the same issue until the user Ctrl-C'd — `--max` only counted successes, and every `fetchReady()` re-surfaced the just-reverted issue. Now `--max` bounds **attempts** (a reverted issue still consumes one), and a per-invocation `seen` set in `drainQueue` skips any issue already attempted so we roll forward to the next eligible one. `OrchestratorResult.processed` → `attempts`.
- **Reviewer rejections no longer silently swallowed when sandcastle appends wrapper output** ([PR #32](https://github.com/ValescoAgency/runway/pull/32), VA-353). The reviewer's `REVIEW: REJECTED — <reason>` line was present in the agent's stdout but the orchestrator reported "no completion signal" and never triggered the HITL path. Two root causes: (1) `stringifyResult` fell through to `JSON.stringify(result)`, turning real newlines into `\n` escapes and breaking the `^…$/m` line anchor in the verdict regex; (2) the regex was single-match against the whole output, but sandcastle appends its own wrapper lines (`Agent stopped`, `Capturing session`, `Run complete: …`) AFTER the agent's final message — so the marker is rarely near EOF. Now prefers `RunResult.stdout` and switches to `/gm` + `matchAll`, picking the last occurrence. Real-world receipts: VA-312's reviewer caught a TOCTOU race, a wide-open RLS policy, and an error-swallowing `withAudit` catch block — all three stranded in a log file before this fix.
- **Reviewer's rejection reason now lands as a Linear comment even if the HITL label apply fails** ([PR #37](https://github.com/ValescoAgency/runway/pull/37), VA-355). The HITL flow used to apply the label first; when the label didn't exist (Flightplan workspaces hitting the `needs-human` default — see below), the orchestrator's catch posted an infrastructure error instead of the substantive reason. Reordered to comment-first, then label best-effort; on full failure, dump the reason to stderr with a `===== REJECTION REASON FOLLOWS =====` banner so the operator sees it terminal-side.
- **Default `RUNWAY_HITL_LABEL` changes from `needs-human` to `ready-for-human`** ([PR #38](https://github.com/ValescoAgency/runway/pull/38), VA-354). Matches the Flightplan canonical state-label vocabulary used by Bedrock and other Valesco repos. The previous default did not exist on Flightplan-aligned workspaces; combined with the comment-after-label ordering it silently swallowed every reviewer rejection. Workspaces using a different label override via the env var.
- **Container env baked into the image — no more host-path leaks, missing pnpm, or unset `HOME`** ([PR #31](https://github.com/ValescoAgency/runway/pull/31), VA-351). Three defects in the vendored claude-code Dockerfile were inflating every agent run by 3-5× in tool-call count: `HOME`/`XDG_CACHE_HOME` unset caused turbo to fall back to a host path remembered at build time (`/Users/jkennemer/Developer/…` leaking into stderr); `pnpm` wasn't on PATH so the agent re-derived corepack setup every iteration; `TURBO_CACHE_DIR` unset caused silent cache misses, re-running tests every iteration. All baked into `templates/Dockerfile.claude-code.base` before `USER ${AGENT_UID}:${AGENT_GID}`, plus a `corepack enable && corepack prepare pnpm@10.0.0 --activate`. `runway doctor` gains a "container readiness" probe. Snapshot test pins the Dockerfile shape against future vendor refreshes.

### Internal

- `OrchestratorResult.processed` renamed to `attempts` (semantics changed; if you consume this shape, the rename is the breaking signal).
- New exports: `parseReviewVerdict`, `parseImplVerdict`, `validateLinearConfig`, `loadPolicy`, `renderForbiddenPathsBullet`, `buildIterationSummary`, `tailOfMessage`. All covered by Vitest.
- New `yaml` dependency to parse `.runway/policy.yml`.
- 76 Vitest tests across 8 files (up from 25 at 0.3.0).

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
