# Changelog

All notable changes to runway are documented here. Versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); breaking
changes bump the major.

## 0.14.0 — 2026-05-20

Minor release. Four PRs since 0.13.0 — two sandbox-side fixes that materially unblock autonomous drains (reviewer was launching against the wrong branch and idling out; lefthook inside the sandbox couldn't find pnpm), a dashboard observability addition that lights up the active-drain card within ~1s of `runway run` instead of waiting 5–15 minutes for the first issue to complete, and a sandcastle error-message improvement that surfaces the log-file tail inline.

### Added

- **Dashboard "active drain" card lights up immediately on drain start** ([PR #161](https://github.com/ValescoAgency/runway/pull/161), VA-455). Before this release, the active-drain card stayed Idle for 5–15+ minutes after `runway run` started: OTel's `BatchSpanProcessor` only exports spans on `.end()`, so the `drainQueue` span (and its row in `drains`) didn't land in the dashboard until every `processIssue` had finished — operators saw "Idle" on a healthy drain and couldn't distinguish that from an outage. runway now emits `Effect.logInfo("drain.started")` at the top of the `drainQueue` span body plus a forked heartbeat fiber that emits `drain.heartbeat` every 30 seconds while the drain runs. The dashboard projector's new `extractActiveDrainMarkers` recognises the marker and the storage layer's new `markDrainActive` upserts a `drains` row with `end_time NULL` and a fresh `last_seen_unix_nano`; every subsequent log record on the trace bumps `last_seen`. `getActiveDrain` becomes a UNION over (a) the new log-driven path (drains with `end_time IS NULL` and fresh `last_seen`) and (b) the legacy VA-391 fallback (issue_processes without a `drains` row), so older runway versions running against a 0.14 dashboard keep lighting up. The `drains.end_time_unix_nano` column relaxes its `NOT NULL` constraint via a PRAGMA-guarded table rebuild that fires only on legacy DBs; fresh installs use the new schema directly. Staleness floor is 90s (3× the heartbeat cadence) so a single dropped flush doesn't toggle the card to Idle.
- **Sandcastle error messages now include the tail of the most-recent `.sandcastle/logs/` file** ([PR #155](https://github.com/ValescoAgency/runway/pull/155), VA-454). When a sandcastle invocation fails (idle timeout, infra error, container crash), the thrown error used to carry only the wrapper's high-level message — operators had to manually `tail .sandcastle/logs/<latest>.log` to see what the agent inside the container was doing. The error message now embeds the last ~30 lines of the most-recently-modified log file inline, so a `runway run` failure surfaces the actual agent output in the operator's terminal without a second-step hunt. This is exactly the affordance that let VA-456 get diagnosed in minutes rather than hours — those tails showed `Branch: main` and "Agent idle for 600 seconds" right in the error stream.

### Fixed

- **Reviewer sandbox now checks out the impl agent's branch explicitly** ([PR #158](https://github.com/ValescoAgency/runway/pull/158), VA-456). `runReviewPass` was passing `branchStrategy: { type: "head" }` to `runSandcastle`, which tells sandcastle to use the CURRENT HEAD of the cwd as the sandbox checkout. The impl phase already uses `{ type: "branch", branch }` and explicitly switches to e.g. `agent/va-447` before launching its container; the review phase did not — so the reviewer's container booted onto whatever branch the operator happened to be on in the main checkout (often `main`, sometimes a feature branch). The reviewer saw a working tree that didn't reconcile with the diff in its prompt, had nothing coherent to act on, and stayed silent until sandcastle's idle timeout fired (10 minutes of dead air, then `INFRA_ERROR`). The fix replaces `{ type: "head" }` with `{ type: "branch", branch }` so the reviewer always lands on the same branch the impl agent committed to. A regression test at `src/orchestrator.test.ts:352-360` asserts the contract: `sandcastleRunMock.mock.calls[1]?.[0]` must include `branchStrategy: { type: "branch", branch: "agent/va-312" }`. Filed VA-458 as a defense-in-depth followup to make the reviewer fail fast (~5s) instead of waiting on the 10-minute idle timeout if a wrong branch ever sneaks through again.
- **Sandbox Dockerfile pins `COREPACK_HOME` so git hooks can resolve pnpm** ([PR #160](https://github.com/ValescoAgency/runway/pull/160), VA-457). `templates/Dockerfile.claude-code.base` ran `corepack enable && corepack prepare pnpm@11.1.1 --activate` as **root**, before the `USER ${AGENT_UID}` directive switched the container's runtime user to the agent UID. Without an explicit `COREPACK_HOME`, corepack wrote the cached pnpm tarball to `/root/.cache/node/corepack` — unreadable from the agent UID. Anything resolving `pnpm` through the corepack shim **after** the user switch — lefthook in particular, when the impl agent invoked `git commit` — couldn't read corepack's data dir and either tried to refetch (slow) or hung (no network). The fix adds `ENV COREPACK_HOME=/home/agent/.cache/corepack` to the Dockerfile alongside the other XDG cache vars, includes the corepack dir in the pre-create mkdir line, and chowns the data dir after `corepack prepare` so the files root just wrote there are agent-owned. Four new assertions in `src/dockerfile-template.test.ts` pin the ENV, the mkdir, and the chown-before-USER ordering.

### Internal — release stats

- **4 PRs since 0.13.0** (2 feat, 2 fix).
- 59 test files, 810 specs pass (+22 — coverage for VA-455's log-driven active drain across the projector and storage layers, VA-457's Dockerfile shape assertions, VA-456's reviewer-branch contract pin, and VA-454's error-tail composition).

## 0.13.0 — 2026-05-20

Minor release. Three PRs since 0.12.0 — all dashboard ergonomics: a one-shot `runway dash upgrade` verb so operators don't have to learn the docker-rm dance on every release; clickable Linear identifiers from the dashboard out to the source issue; and a Todo queue that no longer lists `completed`/`canceled` issues (with the same filter applied to the drain itself, so a stale `ready-for-agent` label on a Done ticket no longer burns a sandcastle run).

### Added

- **`runway dash upgrade` — one-shot pull + replace preserving the SQLite volume** ([PR #148](https://github.com/ValescoAgency/runway/pull/148), VA-451). Before this release, `runway dash up` only pulled when the container didn't exist (running → no-op, stopped → `docker start` against the baked image), so picking up a freshly-published image required `runway dash stop && docker rm runway-dashboard && runway dash up` — easy to fat-finger `--purge` and nuke the SQLite history. The new verb runs the pull FIRST so a failed pull (network, auth, manifest mismatch) leaves the existing container untouched, then stops + removes the old container and starts a new one against the same named volume (`runway-dashboard-data`). The storage layer's idempotent `ALTER TABLE ADD COLUMN` migration pattern (the same one VA-450/VA-453 used for the project/status_type columns) handles schema changes on the new container's first boot — no manual intervention. When no container is present, `upgrade` collapses to the same pull + create that `up` does, so it's safe to run on a clean machine.
- **Dashboard identifiers link out to Linear via `↗` glyph** ([PR #150](https://github.com/ValescoAgency/runway/pull/150), VA-452). Every Linear identifier on the dashboard (Todo queue rows, issue-process list rows, detail view header) gains a small `↗` that opens the issue in Linear in a new tab. The existing issue-process list link to the local detail view (`/issue-processes/<spanId>`) is preserved; the `↗` sits alongside it so neither nav path breaks. Workspace slug is read from a new `RUNWAY_LINEAR_WORKSPACE` env var, forwarded into the dashboard container by `runway dash up` / `runway dash upgrade` automatically. When the env var is unset, the dashboard renders identifiers exactly as before — no broken affordance, no half-empty link.
- **Todo queue filters out cancelled/done states and shows Linear workflow status** ([PR #152](https://github.com/ValescoAgency/runway/pull/152), VA-453). Issues whose Linear `WorkflowState.type` is `completed` or `canceled` are saved without a queue position, so they drop from the "Todo queue (next up)" preview even when they still carry `ready-for-agent`. The snapshot row stays in `linear_snapshots` so per-row Linear status badges on the issue-process list continue to resolve. The same `isTerminalStateType` check (reused from VA-394's blocker-relation filter) is also applied to `src/linear.ts:fetchReady` — the drain itself now skips terminal-state candidates, so a forgotten label on a Done ticket no longer burns a sandcastle run. Filtering by type (not display name) means a team renaming "Cancelled" to "Won't fix" doesn't silently disable the filter. The queue table also gains a new Status column between Labels and Project showing the workflow state display name, so the operator can spot stale-label issues without leaving the dashboard.

### Internal — release stats

- **3 PRs since 0.12.0** (3 feat).
- 58 test files, 788 specs pass (+10 — coverage for the new dash upgrade verb, the Linear-link affordance at all three render sites, the queue filter behavior with both `completed` and `canceled` workflow types, the new Status column, the drain-side `fetchReady` filter, and the storage round-trip for the new `status_type` column).

## 0.12.0 — 2026-05-20

Minor release. Three PRs since 0.11.1: one dashboard feature (Linear project Name + UUID in the Todo queue), one telemetry startup fix that blocked any `runway run` with OTLP enabled, and one CI fix that makes the published dashboard image run on Apple Silicon out of the box.

### Added

- **Dashboard Todo queue shows the Linear project Name + UUID** ([PR #145](https://github.com/ValescoAgency/runway/pull/145), VA-450). The "Todo queue (next up)" section now carries a `Project` column with the project name on top and the UUID muted underneath in the same cell — narrow column, copy-pasteable UUID, no extra row height. Unprojected issues render with an em-dash rather than being hidden (the drain still picks them up, so hiding would diverge from the actual queue). Backed by two new nullable columns on `linear_snapshots` (`project_id`, `project_name`) added via the existing idempotent `ALTER TABLE ADD COLUMN` migration pattern — existing dashboard databases pick the columns up on next boot without operator intervention. `createLinearAdapter.snapshotFromIssue` resolves Linear's `Issue.project` alongside `state` + `labels` in the same `Promise.all` so the extra round-trip costs nothing.

### Fixed

- **`runway run` no longer crashes at startup when `OTEL_EXPORTER_OTLP_ENDPOINT` is set** ([PR #143](https://github.com/ValescoAgency/runway/pull/143)). Setting the OTLP endpoint to wire traces + logs into the local dashboard immediately raised `Service not found: @effect/opentelemetry/Logger/OtelLoggerProvider` at runtime startup, blocking the entire drain. Root cause was a layer composition in `src/telemetry.ts` that wrapped `Logger.layerLoggerReplace` around `NodeSdk.layer`, expecting `NodeSdk.layer` to expose `OtelLoggerProvider`. It doesn't — `NodeSdk.layer` consumes the provider via `Layer.provide(layerLoggerAdd, layerLoggerProvider)` internally, and `Layer.provide(target, source)` hides `source`'s services from the result. The fix drops the redundant outer `layerLoggerReplace` and relies on the OTLP logger that `NodeSdk.layer` already wires via `layerLoggerAdd` when a `logRecordProcessor` is configured. Trade-off documented inline: the default stderr logger is no longer silenced, so `Effect.log` calls now fan out to both stderr and OTLP — for a CLI, keeping visible operator progress beats silence.
- **Published `runway-dashboard` image now runs natively on Apple Silicon** ([PR #142](https://github.com/ValescoAgency/runway/pull/142)). `runway dash up` on a Mac with Docker Desktop failed with `no matching manifest for linux/arm64/v8 in the manifest list entries`. The GHA workflow used `docker/build-push-action@v6` without a `platforms:` input, so the published image only carried a `linux/amd64` variant. Added `platforms: linux/amd64,linux/arm64` and registered QEMU via `docker/setup-qemu-action@v3` so the arm64 build stage can execute Node + pnpm under emulation on the amd64 runner. The next published `ghcr.io/valescoagency/runway-dashboard:latest` carries both architectures and Docker selects the native one automatically.

### Internal — release stats

- **3 PRs since 0.11.1** (1 feat, 1 fix, 1 ci).
- 58 test files, 778 specs pass (+3 — 2 view tests covering the new Project column for projected vs. unprojected rows, 1 storage round-trip test confirming the new columns persist correctly through SQLite for both shapes).

## 0.11.1 — 2026-05-16

Patch release. One bugfix closing a regression that surfaced the moment 0.11.0 was used in anger — `runway upgrade-repo` on any tier-2 target repo last scaffolded before VA-413 failed mid-build because the rendered Dockerfile referenced a vendored shim that the upgrade path forgot to write.

### Fixed

- **`runway upgrade-repo` writes `.sandcastle/runway-claude-shim` on tier-2 upgrade** ([PR #117](https://github.com/ValescoAgency/runway/pull/117), VA-426). Surfaced upgrading bedrock from 0.10.x to 0.11.0: `upgrade-repo` re-rendered the Dockerfile with the post-VA-413 `COPY runway-claude-shim …` line but never materialised the shim file alongside it, so the post-render `docker build` verification step failed on the missing source and left the operator stuck. The `init` path already wrote the shim via `applyVarlockLayer`; `upgrade-repo` (written pre-VA-413) only knew about the Dockerfile + `.env.schema` re-render. The fix extracts `writeShim(cwd)` as a shared helper that both paths call, threads a `runway-claude-shim` `FileChange` through `upgrade-repo`'s existing drift/check/write pipeline so `--check` reports missing-shim drift, and routes the shim through the helper (not `writeFileSync`) so the 0755 mode is correct. Also closes a latent footgun in the helper itself: `writeFileSync({mode})` only sets the mode on file creation, not on overwrite, so the helper now does an explicit `chmodSync(path, 0o755)` after the write — a stale 0644 shim from a manual `cp` would otherwise silently survive a re-render and break the docker COPY's execute-bit propagation. Sibling fix to `src/scaffolder-verify.ts`: the post-render verify step previously grepped the Dockerfile for the legacy inline `varlock run --env-file` pattern, which post-VA-413 lives inside the vendored shim — replaced with checks for `COPY runway-claude-shim` on the Dockerfile, shim present on disk, and shim wraps varlock around `claude.real`. Without this fix even a successful re-render would VERIFY FAIL on the new layout.

### Internal — release stats

- **1 PR since 0.11.0** (1 fix).
- 58 test files, 775 specs pass (+9 new — 6 `writeShim` helper-level tests, 3 `composeAndApplyScaffoldChanges` composition tests covering the pre-0.11.0 → 0.11.1 upgrade path, `--check` drift, and already-up-to-date branches).

## 0.11.0 — 2026-05-16

Big minor release. Twenty-two PRs since 0.10.1 — the entire IRA chain (VA-400 PRD, slices VA-401 through VA-410) lands together, alongside the remaining operations-dashboard slices (VA-388 / VA-390 / VA-391 / VA-392 / VA-393), SSH-signed agent commits (VA-413), the validation-library consolidation (VA-397), three drain-resilience fixes (VA-424 / VA-425 / VA-385), and the queue-contract switch from status-gated to label-gated (VA-423).

### ⚠️ Operator action required — `ready-for-agent` label contract (VA-423)

[PR #108](https://github.com/ValescoAgency/runway/pull/108). Runway no longer drains by `status = Todo`; it drains by `labels contains ready-for-agent`. Linear's GitHub integration auto-mutates issue **status** whenever a PR cross-references the issue (`Triage` / `Backlog` / `Todo` → `In Progress`), so a status-gated queue silently lost issues every time someone mentioned them from a PR. Labels are not touched by the integration; flightplan v1.1.0 ships the label-based contract and runway is the consumer that adapts.

What you need to do before upgrading:

- **Backfill** — apply the `ready-for-agent` label to every existing `Todo` issue you want runway to drain. The status alone no longer matters.
- **Triage** — any issue you want runway to skip must NOT carry `ready-for-agent`. An issue carrying both `ready-for-agent` and `ready-for-human` is treated as HITL (skipped).
- **Env vars removed** — `RUNWAY_READY_STATUS`, `RUNWAY_IN_PROGRESS_STATUS`, and `RUNWAY_IN_REVIEW_STATUS` are gone. The new knob is `RUNWAY_READY_LABEL` (default `ready-for-agent`); `RUNWAY_HITL_LABEL` (default `ready-for-human`) is unchanged.
- **`runway doctor`** now validates the two labels exist on your team and stopped validating workflow states.
- **Pickup is now a `removeLabel(ready-for-agent)` claim** (atomic against re-drains); finalize stops touching status entirely. Linear's GitHub integration drives status from PR events (`In Progress` on open, `Done` on merge via `Closes <issue>`).

The VA-421 `remoteAgentBranchExists` In-Progress-with-no-remote-branch workaround is also removed — it existed solely to compensate for the status auto-mutation problem and is unnecessary under the label contract.

### Added — IRA chain (VA-400 PRD, slices 1–10)

A standalone, end-to-end retrospective grading pipeline: every drain's per-issue work is graded ~18 hours after the drain finishes, every drain receives a structured composition / sequencing review, and a weekly pass promotes corroborated themes into actionable runway-repo issues with predicted effects that the next week grades against.

- **Structured agent + reviewer reports** ([PR #103](https://github.com/ValescoAgency/runway/pull/103), VA-401). `prompts/implement.md` and `prompts/review.md` now require a fenced JSON `runway-agent-report` / `runway-reviewer-report` block (template_version `1.0.0`) before their existing `IMPL:` / `REVIEW:` marker lines. Captured durably onto OTel spans at exit so a downstream crash leaves the upstream report intact. Forward-compatible inside a major; major-version drift fails loudly as a typed `version-mismatch` error.
- **`runway review run --drain <trace-id> --issue <id>`** ([PR #104](https://github.com/ValescoAgency/runway/pull/104), VA-402). Per-issue Run Review pipeline tracer. Reads the structured reports off the dashboard's event store, calls Anthropic (`claude-sonnet-4-6` default via `RUNWAY_META_REVIEW_MODEL`), persists a v1.0.0 Run Review to a `runway-meta` Linear project + the dashboard's `meta_reviews` table. Stub-and-continue on every failure mode; the parsed review is preserved in the stub so manual re-runs don't double-charge.
- **Async delay gate + hindsight signals** ([PR #106](https://github.com/ValescoAgency/runway/pull/106), VA-403). Bumps Run Review to v1.1.0 with a populated `hindsight_signals` section (PR merge state, human-comment sentiment, follow-up issues filed in the past 48h). Drain-age delay gate (default 18h, env `RUNWAY_REVIEW_DELAY_HOURS`, file override `metaReviewDelayHours`, CLI `--force`) short-circuits the pass on drains too fresh for hindsight to land. Per-source graceful degradation: a failing GitHub or Linear gateway projects to null hindsight and the pass still grades.
- **Heuristic pre-filter — skip uneventful runs** ([PR #105](https://github.com/ValescoAgency/runway/pull/105), VA-404). Trip conditions: iteration count ≥ 3, retry triggered, HITL escape, revert outcome, reviewer-rejection proxy, infra-error outcome. Skip path writes a `meta-skipped` row and short-circuits — no Anthropic call, no Linear write. Thresholds configurable via env (`RUNWAY_META_FILTER_THRESHOLDS`, JSON) or `.runway/config.yml#metaFilterThresholds`.
- **Rolling norms + relative-axis grading** ([PR #107](https://github.com/ValescoAgency/runway/pull/107), VA-405). Bumps Run Review to v1.2.0. Each grading dimension now carries both an absolute axis (`STRONG / ADEQUATE / WEAK / FAILED`) and a relative axis (`BETTER / STEADY / WORSE`) vs. category-scoped recent norms (median / p95 / rate, default 30-drain window) sourced from VA-399's evaluator-aggregates SQL. Forward-compatible: v1.0.0 / v1.1.0 payloads still parse.
- **Per-drain review pass + severity-critical escalation** ([PR #109](https://github.com/ValescoAgency/runway/pull/109), VA-406). New `runway review drain --id <trace-id>` verb plus an in-process event trigger that fires the moment every Run Review for a drain has landed. Files a v1.0.0 Drain Review in `runway-meta` covering composition / sequencing / cross-issue patterns. On `severity: critical`, also files a `Bug` + `runway-meta-promoted` issue into the runway-repo project (set `RUNWAY_REPO_PROJECT_NAME` to scope; otherwise team-level), bypassing the Weekly Review cadence.
- **Weekly Review + promoter + loud-fail handling** ([PR #110](https://github.com/ValescoAgency/runway/pull/110), VA-408). Sunday-22:00-local cadence verb `runway review weekly [--start <iso>] [--end <iso>]`. Mechanical promoter groups Run Review recommendations by `target` taxonomy, requires ≥2 corroborating reviews per theme, filters `.out-of-scope/` overlaps, defers themes whose key already has an open promoted issue, ranks by `confidence × corroboration`, caps at top 5. LLM authors the narrative + falsifiable predicted-effect blocks; ranking math never reaches it. Asymmetric vs Run / Drain Review: 2 retries (exponential 5s base) then **loud fail** (`exit 1`, no stub) — cron MAILTO / GitHub Actions step failure is the signal. Stamps a `<!-- runway-meta-theme-key: ... -->` marker on every promotion for next week's queue-defer pass.
- **Attribution loop — "What we shipped" verdicts** ([PR #111](https://github.com/ValescoAgency/runway/pull/111), VA-409). Weekly Review v1.1.0. Grades each promoted runway-repo issue that completed since the prior Weekly Review against its stamped predicted effect. Verdict alphabet: `HELD` / `PARTIAL` / `MISSED` / `PENDING` / `QUALITATIVE`. Verdict computed mechanically by `computeVerdict` before the LLM is called; LLM only authors the per-row sentence and any verdict / observed-value drift it tries to slip past gets overwritten by `reconcileShippedPromotions`.
- **`/meta-reviews` dashboard surface** ([PR #112](https://github.com/ValescoAgency/runway/pull/112), VA-407). Paginated list view (20/page, filterable by `kind` chip strip — `run` / `drain` / `weekly` / `skipped` / `failed`), per-kind detail renderer that walks `content_json` with optional chaining (older `template_version` rows render without crashing), cross-links: Run Review → `/issue-processes/:spanId`, Drain Review → `/?drain=<traceId>`, Weekly Review promotions → runway-meta Linear URL. Includes the VA-409 verdict pill on shipped promotions.
- **`/triage` IRA-promoted addendum** ([PR #113](https://github.com/ValescoAgency/runway/pull/113), VA-410). Operator-side skill (`.claude/skills/triage/SKILL.md`) that recognizes `runway-meta-promoted` labels on incoming Linear issues, loads the source meta-reviews + predicted-effect block before grilling, and warns about wording overlap with rejected `.out-of-scope/` themes. Closes out the VA-400 PRD chain.

### Added — operations dashboard (final slices)

- **OTLP logs path + correlated log detail pane** ([PR #97](https://github.com/ValescoAgency/runway/pull/97), VA-388). Bridges Effect's logger over OTLP logs end-to-end. Runway emits via `BatchLogRecordProcessor(OTLPLogExporter)` gated on `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` (or the existing `OTEL_EXPORTER_OTLP_ENDPOINT`); the dashboard receives at `POST /v1/logs`, persists to `log_records(trace_id, span_id, timestamp_unix_nano, level, message, attributes_json)`, surfaces them in a Logs section on the per-issue detail pane. Annotated context (e.g. `Effect.annotateLogs({ issue })`) flows as log-record attributes with no call-site changes anywhere in the orchestrator.
- **Live updates via SSE + drain summary strip** ([PR #98](https://github.com/ValescoAgency/runway/pull/98), VA-391). Typed in-process pub/sub (`src/dashboard/events.ts`) fires `IssueProcessChanged` / `LogRecordAppended` after each storage write. New SSE route `GET /issue-processes/:id/stream` and a fragment endpoint `GET /issue-processes` back htmx-driven live updates on the detail and list pages. List page gets a drain summary strip — `Drain started <time>, X/N issues, Y HITL, Z errors` when active; `Idle — no active drain` otherwise.
- **Filter chips + explicit bind env vars** ([PR #99](https://github.com/ValescoAgency/runway/pull/99), VA-392). List view gains outcome / range / drain filter chips with shareable URL state (`?outcome=opened,hitl&range=7d&drain=<traceId>`). Garbage / unknown values silently fall through to "no filter" so stale bookmarks still render. Polling preserves filter state. `DASHBOARD_BIND` and `OTLP_BIND` env vars now configurable independently (legacy `DASHBOARD_HOST` honored as fallback).
- **`runway dash` CLI + published dashboard image** ([PR #100](https://github.com/ValescoAgency/runway/pull/100), VA-393). New top-level verb (`up` / `logs` / `stop`) wraps `docker run` so any runway-using project can bring up the dashboard without cloning runway. Loopback bind enforced; named volume preserves the SQLite db across restarts; idempotent `up`; `stop --purge` drops the volume. Image published to `ghcr.io/valescoagency/runway-dashboard` via `.github/workflows/dashboard-image.yml` on every push to `master` and on `v*.*.*` tags, tagged `:latest`, `:<sha>`, plus `:<semver>` / `:<major>.<minor>` / `:<major>` on releases. README "Dashboard" section documents the v2 (`runway dash`) flow alongside the legacy compose path.
- **Linear sync — Todo queue preview + per-row status badges** ([PR #94](https://github.com/ValescoAgency/runway/pull/94), VA-390). `LinearAdapter`-wrapped poller polls every `LINEAR_POLL_INTERVAL_SECONDS` (default 300) for the queue and recently-touched issues when `LINEAR_API_KEY` is set; results land in a `linear_snapshots` table. List view renders a "Ready queue (next up)" section (renamed under VA-423 from "Todo queue"). Absent `LINEAR_API_KEY` → poller doesn't start, queue section hidden, badges fall back to the outcome cell.

### Added — agent commit signing (VA-413)

- **SSH-signed agent commits via 1Password bot key** ([PR #101](https://github.com/ValescoAgency/runway/pull/101)). Runway-generated commits arrive on PRs with a **Verified** badge when opted in. Strategy: Ed25519 SSH signing with a dedicated bot keypair stored under `op://<vault>/runway-signing-ssh`; the in-container `claude` shim materialises the key at run time and `git config --global` flips signing on. Off when any of the four `RUNWAY_SIGNING_*` `op://` refs is unset (partial configs treated as off, surfaced as a `fail` from `runway doctor` so unsigned commits can't slip through). ADR-0003 documents the design choice + future GitHub-App migration trigger. Setup walkthrough in the README's "Signed agent commits (optional)" section.

### Added — review prompt scaffolding

- **`prompts/pr-review.md`** ([PR #102](https://github.com/ValescoAgency/runway/pull/102)). Draft reviewer prompt scoped to a published PR (Linear as spec of record, MCP-aware, AC-level grading, standard PR-review verdicts). Not wired into the orchestrator yet — saved for a future PR-review step.

### Changed

- **Drop `zod`, consolidate on Effect Schema** ([PR #114](https://github.com/ValescoAgency/runway/pull/114), VA-397). Three sites migrated: `src/policy.ts`, `src/runway-config-file.ts`, and `src/meta/templates.ts` (the entire IRA chain's schemas). `zod` removed from `package.json`; `pnpm why zod` returns empty. `summariseZodIssues` → `summariseSchemaError` via `ParseResult.ArrayFormatter`; same compact `"path: tag"` line trace attributes already expect.

### Fixed

- **Drain-rebase outcome split: `conflict` vs `failure`** ([PR #95](https://github.com/ValescoAgency/runway/pull/95), VA-424). VA-419's pre-PR rebase step previously collapsed every non-zero `git rebase` exit into a single `conflict` outcome with a fabricated "Upstream base advanced" HITL message that pointed operators at VA-417 — which hard-resets the agent branch and discards approved work. Now `RebaseResult` distinguishes `ok` / `conflict` (exit non-zero AND `git diff --diff-filter=U` reports unmerged files) / `failure` (exit non-zero with no unmerged files — dirty host worktree, signing hook, lock contention, etc.; stderr captured). HITL messages drop the "let VA-417 handle it on the next drain" wording. Surfaced live by the 2026-05-15 drain that HITL'd VA-385 / VA-388 / VA-390 with approved diffs.
- **`fetchReady` skips parent issues with children** ([PR #96](https://github.com/ValescoAgency/runway/pull/96), VA-425). Parent PRDs and umbrella tickets describe scope across multiple deliverables; the right unit of agent work is the leaf ticket. Before this change, an agent picking up a PRD would latch onto one user story and — if a `Closes <parent>` magic word ever landed — false-close the umbrella while siblings went untouched. New `hasChildIssues` helper in `src/linear.ts` calls `issue.children()` and `fetchReady` skips any candidate with `nodes.length > 0`. README "Linear conventions" section documents the rule + authoring guidance.
- **Dashboard binds to `127.0.0.1` by default** ([PR #92](https://github.com/ValescoAgency/runway/pull/92), VA-385). Stand-alone `node dist/dashboard/server.js` (and `runway dash`) now binds loopback-only per the dashboard ADR's explicit security commitment ("Binds to `127.0.0.1` only. No auth in v1."). The previous `host ?? "0.0.0.0"` default made the dashboard reachable from the LAN whenever an operator started it outside the Docker compose path. Container still binds `0.0.0.0` inside (via `DASHBOARD_HOST` in `Dockerfile.dashboard`) so Docker's port-forward reaches the listener; `docker-compose.yml` then re-gates the host port to loopback via the `127.0.0.1:` prefix on the published port.

### Internal — release stats

- **22 PRs since 0.10.1** (10 IRA-chain slices + 5 dashboard slices + 1 signing feature + 1 prompt scaffold + 1 validation refactor + 1 queue-contract change + 3 drain-resilience fixes).
- 58 test files, 766 specs pass (up from 39 / 320 at 0.10.1 — +19 files, +446 specs). Most growth in `src/meta/` for the IRA pipeline and `src/dashboard/` for the live-update + filter-chip + meta-reviews surfaces.

## 0.10.1 — 2026-05-14

Patch release. One bugfix closing the last hole in runway's queue-management story — discovered immediately after 0.10.0 shipped, on the same drain that surfaced VA-417/418/419/420.

### Fixed

- **`fetchReady` accepts In-Progress issues whose `agent/<id>` branch isn't on origin yet** ([PR #87](https://github.com/ValescoAgency/runway/pull/87), VA-421). Linear's GitHub integration auto-transitions an issue to `In Progress` when its identifier is mentioned in an unrelated PR body. The previous `fetchReady` filtered strictly on `state == config.readyStatus`, so an issue that no real drain ever touched could silently fall out of the queue — observed on VA-417 during the 2026-05-14 PM drain, where PRs #78 and #80 both said "Sibling to VA-417" in their bodies, Linear flipped VA-417 to In-Progress, and the next `fetchReady` missed it. The fix: a new `git ls-remote --heads origin agent/<id>` check (`src/git.ts:remoteRefExists`) is the authoritative "no drain attempt in flight" signal. `createLinearGateway` gains an optional `remoteAgentBranchExists` predicate; when provided, `fetchReady` queries In-Progress alongside Todo and skips In-Progress candidates whose remote ref already exists. Todo path unchanged (no extra git call). Help text under `RUNWAY_IN_PROGRESS_STATUS` notes the broadened scope.

### Internal — release stats

- **1 PR since 0.10.0** (1 fix).
- All 39 test files, 320 specs pass (8 new — 5 VA-421 in `linear-filter.test.ts`, 3 `remoteRefExists` in `git.test.ts`).

## 0.10.0 — 2026-05-14

Minor release. Seven PRs since 0.9.0, weighted toward orchestrator resilience under retry and the dashboard's first observability slices. Drains that previously stalled on rebase-conflicts at PR-creation time, mis-ordered queues, stale agent branches on HITL retry, or hung Node processes after the work was logically done now self-resolve. The dashboard read-model and per-issue detail pane move from "drain trace exists in SQLite" to "operator can actually inspect a run."

### Added

- **In-run review-rejection retry loop** ([PR #80](https://github.com/ValescoAgency/runway/pull/80), VA-418). Reviewer can now signal `REVIEW: REJECTED-RETRY — <reason>` for mechanically fixable issues. Runway re-runs the impl agent with the rejection threaded into `{{IN_RUN_REVIEWER_FEEDBACK}}` and re-runs review, up to `--review-retries` (default 1, env `RUNWAY_REVIEW_RETRIES`). `REJECTED-HITL` still routes straight to a human. Closes the previous "one strike, you're out" reviewer behavior that wasted impl effort on cosmetically wrong but recoverable diffs.
- **Pre-PR rebase onto base branch** ([PR #78](https://github.com/ValescoAgency/runway/pull/78), VA-419). `finalize` now runs `git fetch origin <base>` and `git rebase origin/<base>` before `git push`, so PRs open on a fast-forward and avoid the "GitHub thinks this needs a rebase" badge on the very first view. On rebase conflict, the issue is routed to HITL with the conflicted-file list — the reviewer's prior verdict is preserved so the operator sees that the diff was good before the conflict surfaced.
- **Dashboard: per-issue detail pane + processIssue span enrichment** ([PR #75](https://github.com/ValescoAgency/runway/pull/75), VA-387). The `processIssue` OTel span now carries `runway.outcome.kind`, `runway.outcome.detail`, `runway.pr.url` (on opened outcomes), `runway.hitl.reason` (on planned + failure-routed HITL), plus `runway.outcome.errored` to distinguish planned HITL from crash-routed HITL on the dashboard row. The detail pane renders these as structured fields with deep links into GitHub and Linear.
- **Dashboard: evaluator-facing aggregates read-model** ([PR #74](https://github.com/ValescoAgency/runway/pull/74), VA-399). Rolling-window aggregates over drains and issue processes — counts, outcome distributions, retry rates — exposed as SQL views the IRA Run Review pipeline will query directly. Underpins future rolling-norms grading (VA-405) without requiring per-pass recomputation.

### Fixed

- **`runway run` no longer hangs after the drain completes** ([PR #85](https://github.com/ValescoAgency/runway/pull/85), VA-422). `runCommand` now emits a parser-friendly completion marker (`[runway:exit] status=success attempts=N opened=N hitl=N errored=N`) and `process.exit(0)` after the existing summary. The hard exit kills any lingering handle — OTel `BatchSpanProcessor`'s interval when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, a Docker stream Sandcastle left open — that previously stranded background `runway run` invocations (Claude Code background tasks, CI steps) past the work's actual completion. The failure path in `cli.ts` mirrors the marker on stderr (`[runway:exit] status=failure`).
- **Stale agent branch reset on HITL retry** ([PR #83](https://github.com/ValescoAgency/runway/pull/83), VA-417). When an issue is HITL-flagged and later re-routed back to the queue, runway now resets `agent/<id>` to `origin/<base>` once at drain-pickup time, before the retry loop begins. Closes the failure mode where iteration 2 of the in-run retry loop would otherwise inherit iteration 1's rejected commits and conclude "the work is already done."
- **`fetchReady` queue ordering — priority DESC, then createdAt ASC** ([PR #81](https://github.com/ValescoAgency/runway/pull/81), VA-420). Linear's priority encoding is non-monotonic (1=Urgent, 2=High, 3=Medium, 4=Low, 0=No-priority). The previous sort treated 0 as below 4 lexically but Urgent as below No-priority numerically — the result was Urgent issues sometimes draining after Low ones. The new sort orders strictly by descending semantic priority, with `createdAt` ascending as the tiebreaker so older Urgent issues drain first.

### Closed without separate work

- **VA-384** (applyLabel filter excludes workspace-scoped labels) — already resolved in master under VA-416's commit in 0.9.0 (`src/linear.ts:553-572`). Closed as duplicate during release prep; no code change needed.

### Internal — release stats

- **7 PRs since 0.9.0** (4 features + 3 fixes).
- All 39 test files, 312 specs pass.

## 0.9.0 — 2026-05-14

Minor release. Drops Node 22 support in favor of Node 24, bumps the agent runtime container to pnpm 11.1.1, and patches the impl-agent prompt so it no longer treats yesterday's rejected commits as authoritative on retry. Two PRs since 0.8.1.

### Changed — minor-bumping

- **Node 22 → Node 24 across containers, workflows, and the package's `engines` pin** ([PR #72](https://github.com/ValescoAgency/runway/pull/72)). `templates/Dockerfile.claude-code.base` (the canonical template `runway init` writes from) and the runway repo's dogfooded `.sandcastle/Dockerfile` both move to `node:24-bookworm`; `Dockerfile.dashboard` to `node:24-slim` in both stages; `.github/workflows/{ci,release}.yml` to `node-version: 24`. `package.json#engines.node` bumps from `>=22` to `>=24` — anyone installing `@valescoagency/runway` now needs Node 24+. Use `runway upgrade-repo` to refresh existing scaffolded target repos against the new template.
- **pnpm 10.x → pnpm 11.1.1 across containers, CI runners, and corepack** ([PR #72](https://github.com/ValescoAgency/runway/pull/72)). `corepack prepare pnpm@10.0.0 --activate` → `pnpm@11.1.1` in the agent Dockerfile templates; `pnpm/action-setup@v4 with: version: 10` dropped from both workflows so the action reads `packageManager` from `package.json` (now pinned to `"packageManager": "pnpm@11.1.1"`). `actions/checkout@v4` → `@v6` and `pnpm/action-setup@v4` → `@v6` in the same pass.

### Added

- **pnpm 11 build-script approval via `pnpm-workspace.yaml`** ([PR #72](https://github.com/ValescoAgency/runway/pull/72)). pnpm 11 promotes `ERR_PNPM_IGNORED_BUILDS` from a warning to a hard install failure; the four packages whose install scripts runway depends on (`@parcel/watcher`, `esbuild`, `lefthook`, `msgpackr-extract`) are now allowlisted via the new `pnpm-workspace.yaml#allowBuilds` map (the legacy `package.json#pnpm.onlyBuiltDependencies` field is recognized but silently ignored under v11).

### Fixed

- **Impl agent acknowledges retry case instead of verifying stale rejected commits** ([PR #71](https://github.com/ValescoAgency/runway/pull/71), partial fix for VA-417). The previous `prompts/implement.md` framed the agent branch as unconditionally clean — on a retry, the agent saw existing rejected commits and concluded "the work is already done," signaling `IMPL: DONE` without addressing the reviewer feedback that put the issue back in the queue. The rewrite explicitly distinguishes first-attempt (clean branch) from retry (may carry rejected prior commits), and instructs the agent to replace existing commits if they would re-introduce a rejected design. Also threads `{{BASE_BRANCH}}` as a real template variable so `main` vs. `master` vs. anything else reflects the actual base branch instead of a hardcoded "main". The structural-fix half of VA-417 (orchestrator-side prune of `agent/X` before the impl phase on HITL retry) is **not** in this release — that's a future drain.

### Internal — pnpm v11 footgun sweep

Surveyed [pnpm's migration guide](https://pnpm.io/migration) for every documented breaking change and audited the repo against the full list. Two items needed action ([PR #72](https://github.com/ValescoAgency/runway/pull/72), final commit):

- **`npm_config_cache` → `pnpm_config_cache` in the agent Dockerfile.** pnpm 11 no longer reads `npm_config_*` env vars; the agent container's baked cache redirect (VA-351) became a silent no-op. Renamed the env var and aligned the directory path from `~/.cache/npm` to `~/.cache/pnpm`; updated the corresponding `dockerfile-template.test.ts` pin.
- **`pnpm install -g <pkg>` → `pnpm add -g <pkg>` in the README.** v11 deprecated the no-argument form and the `install -g <pkg>` form is now ambiguous; `add -g` is the canonical install path.

Items audited and confirmed not present in the repo: `neverBuiltDependencies` / `ignoredBuiltDependencies` / `onlyBuiltDependenciesFile`, `useNodeVersion`, scripts shadowing v11 built-ins (`clean`/`setup`/`deploy`/`rebuild`), `auditConfig.ignoreCves`, `pnpm server`, `pnpm link <name>`, `allowNonAppliedPatches`, `managePackageManagerVersions` / `packageManagerStrict`. The only `.npmrc` content is the `@valescoagency:registry=` scope pin, which v11 still reads from `.npmrc`.

### Internal — release stats

- **2 commits since 0.8.1** (1 fix + 1 chore-alignment, with the chore-alignment PR carrying 6 commits internally).
- All 39 test files, 253 specs pass (2 new: `{{BASE_BRANCH}}` substitution + default fallback).

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
