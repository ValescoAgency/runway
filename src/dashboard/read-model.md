# Evaluator-facing read-model (VA-399)

This file documents the stable read-model exposed by the dashboard's
SQLite store for the **Independent Review Agent** (IRA) and the
dashboard UI. The IRA grades each runway run on a relative axis —
"how does this run compare to recent typical runs of the same
kind?" — and that comparison needs aggregates that don't shift shape
underneath it every time the underlying event tables get a new column.

The read-model is a thin, versioned facade. The raw event tables
(`drains`, `issue_processes`, `agent_iterations`, `raw_spans`) can
evolve freely; only the read-model's field names + shapes are
contracted. IRA prompts will reference these by name, so a breaking
change (renamed column, dropped column, changed semantics) requires an
**explicit version bump** (new view name, e.g. `_v2`). The old view
stays in place until the IRA prompt has migrated.

## Versioning

Field names + shapes follow a semver-style contract:

- **Minor** (additive): adding a new column to the existing view is
  backwards-compatible. The IRA prompt won't break — old field names
  still resolve. No version bump needed.
- **Breaking** (renames, drops, semantics changes): bump the view name
  (`evaluator_aggregates_v1` → `evaluator_aggregates_v2`). Leave the
  old view in place for at least one IRA prompt revision so a rollback
  isn't a forced upgrade.

Don't repurpose an existing column — if the semantics of `revert_rate`
ever change, that's a breaking change. Add a new column instead.

## View: `evaluator_aggregates_v1`

One row per issue-category, computed over a rolling window of recent
drains.

| Column                       | Type    | Semantics |
|------------------------------|---------|-----------|
| `category`                   | TEXT    | Issue category — the prefix of `issue_identifier` before the first `-`. `VA-312` → `VA`. Acts as the comparison cohort. |
| `sample_size`                | INTEGER | Issue-process count contributing to this row. The IRA should ignore rows with `sample_size < 5` or surface them with a "small-sample" caveat — medians on 1-2 runs aren't signal. |
| `median_iteration_count`     | REAL    | Median count of `agent_iterations` rows per issue process. `NULL` only if `sample_size = 0` (i.e. no rows in the window). |
| `p95_iteration_count`        | REAL    | 95th-percentile iteration count (nearest-rank method). |
| `median_wall_time_ms`        | REAL    | Median wall-time per issue process in milliseconds, computed as `end_time_unix_nano - start_time_unix_nano`. |
| `p95_wall_time_ms`           | REAL    | 95th-percentile wall-time in milliseconds. |
| `reviewer_rejection_rate`    | REAL    | Fraction `[0, 1]` of issue processes where the sub-agent reviewer rejected. Detected by `outcome_kind = 'hitl' AND outcome_detail LIKE 'Sub-agent review rejected%'` (see `src/review.ts` for the marker). Subset of `hitl_escape_rate`. |
| `revert_rate`                | REAL    | Fraction where `outcome_kind = 'reverted'` (startup failure before any commits — runway returned the issue to `Todo` for retry). |
| `hitl_escape_rate`           | REAL    | Fraction where `outcome_kind = 'hitl'` (any reason — review rejection, max-iterations exhaustion, missing review marker). |
| `infra_error_rate`           | REAL    | Fraction where `outcome_kind = 'errored'` (crashed mid-run after producing commits — flagged for human review). |

### Percentile semantics

Median uses the standard "average of the two middle values when N is
even, the middle value when N is odd" definition.

P95 uses the **nearest-rank** method (PERCENTILE_DISC): the smallest
observed value whose rank meets-or-exceeds 95% of the sample. So for
N=20, p95 = the 19th value (sorted ascending). This is integer-friendly
and matches what most ops dashboards render.

### Outcome-kind mapping (source: `src/orchestrator.ts`, `src/hitl.ts`)

- `opened` — PR opened (success)
- `hitl` — handed off to human (review rejection, missing review
  marker, max-iterations, etc.)
- `reverted` — agent crashed before producing commits; issue
  transitioned back to `Todo` for retry
- `errored` — agent crashed after producing commits; flagged for human

The four rate columns are **non-orthogonal**:
`reviewer_rejection_rate ≤ hitl_escape_rate`. `revert_rate` +
`hitl_escape_rate` + `infra_error_rate` + (opened) = 1.0.

## Rolling window

The view aggregates over the last **N drains** (ordered by
`start_time_unix_nano DESC`). N defaults to 30 and is overridable via
`DASHBOARD_AGGREGATE_WINDOW` at dashboard startup. The view is
recreated with the new N each time the dashboard process starts —
in-flight evaluator queries against the old view will see the old N
until the process restarts.

Drains landing during the window become eligible immediately on
INSERT; there is no refresh delay (the view is live, not materialized).

## Access patterns

- **External evaluator** (IRA, ad-hoc scripts): open the SQLite file
  read-only and `SELECT * FROM evaluator_aggregates_v1`. The view name
  is the contract.
- **Dashboard UI / HTTP clients**: `GET /api/aggregates` returns a
  JSON-serialized snapshot:
  ```json
  {
    "view": "evaluator_aggregates_v1",
    "rows": [
      { "category": "VA", "sampleSize": 12, "medianIterationCount": 2, ... }
    ]
  }
  ```
  The row shape mirrors the column names (camelCase) so the same
  field references work from either side.

## Why category is the issue-identifier prefix

The IRA needs a comparison cohort that's stable across drains and
groups runs that "look the same." Linear team prefixes (`VA-`, `ENG-`,
`BUG-`, etc.) are the strongest signal that's already in the data
without dragging Linear-label sync into the dashboard.

If a workspace later wants finer-grained categories (e.g. by Linear
label or by commit-message scope), that's a *minor* version addition —
add a `subcategory` column, leave `category` alone.

## Testing contract

`storage.test.ts` seeds a fixture event store with known values and
asserts each aggregate matches a hand-computed expectation. The
fixtures are intentionally small (single-digit row counts) so a future
reader can verify by mental arithmetic — bigger fixtures lose that
property.
