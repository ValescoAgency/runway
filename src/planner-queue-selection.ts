import { Effect } from "effect";
import { PLANNER_RECOMMENDATION_PROPOSED_LOG } from "./dashboard/projector.js";
import type { PlannerReadClient, ReadyForAgentRow } from "./planner-storage.js";

/**
 * VA-476: queue-selection capability. Each planner tick, picks the
 * top-of-queue ready issue and emits a `planner.recommendation.proposed`
 * marker — unless the same target already has an open recommendation
 * (proposed / accepted) or an in-flight action.
 *
 * v1 ordering: `queue_position ASC` then `issue_identifier ASC` as
 * a deterministic tiebreaker. Linear priority is deferred — it isn't
 * captured in `linear_snapshots` yet (a small follow-up extends
 * `linear-sync.ts` + the schema). Blocking-relation awareness is
 * also deferred for the same reason: the Linear SDK exposes
 * `blockedByRelations` but the dashboard doesn't sync that today.
 *
 * Recommendation ID is `queue-selection:<target>` — stable across
 * ticks so the dashboard's idempotent INSERT (VA-474) silently
 * absorbs duplicate emissions if a re-emit slips through the dedup
 * filter. The dedup is broad: ANY recommendation row for the target
 * (proposed, accepted, OR rejected) causes the planner to skip on
 * subsequent ticks. Rejected is treated as terminal — the operator
 * removes + re-adds the ready-for-agent label on Linear to retry.
 * This prevents OTLP noise for already-decided targets that the
 * dashboard would only `ON CONFLICT DO NOTHING` anyway. (Initial
 * cut filtered proposed|accepted only; PR #206 Cursor review
 * surfaced the comment/behavior disagreement.)
 */

export const QUEUE_SELECTION_CAPABILITY = "queue-selection";

export interface QueueSelectionContext {
  readonly readClient: PlannerReadClient;
  readonly readyLabel: string;
  /**
   * Wall-clock timestamp generator. Production passes
   * `() => String(Date.now() * 1_000_000)` so the OTLP marker carries
   * a sortable unix-nano string; tests inject a fixed value for
   * snapshot stability.
   */
  readonly now: () => string;
}

export interface QueueSelectionResult {
  readonly kind: "emitted" | "no-ready" | "all-pending";
  readonly target: string | null;
}

/**
 * One pass of queue-selection. Returns an effect that yields a
 * `QueueSelectionResult` describing what (if anything) was emitted —
 * useful for tests and for the tick loop's log annotations.
 */
export const evaluateQueueSelection = (
  ctx: QueueSelectionContext,
): Effect.Effect<QueueSelectionResult> =>
  Effect.gen(function* () {
    const ready = ctx.readClient.listReadyForAgent({
      readyLabel: ctx.readyLabel,
    });
    if (ready.length === 0) {
      return { kind: "no-ready" as const, target: null };
    }

    // Hash the known-recommendation + in-flight target sets into a
    // single skip set — a target can be in either bucket. SET reads
    // are O(N+M) with dashboard's typical N+M < 20, so no perf
    // concern. "Known" includes rejected so the planner respects the
    // operator's decision on subsequent ticks (see module doc).
    const known = new Set(ctx.readClient.listKnownRecommendationTargets());
    const inFlight = new Set(ctx.readClient.listInFlightActionTargets());

    const sorted = sortReady(ready);
    const pick = sorted.find(
      (r) => !known.has(r.issueIdentifier) && !inFlight.has(r.issueIdentifier),
    );
    if (!pick) {
      return { kind: "all-pending" as const, target: null };
    }

    const recommendationId = `${QUEUE_SELECTION_CAPABILITY}:${pick.issueIdentifier}`;
    const summary = pick.title
      ? `Pick up ${pick.issueIdentifier} — ${pick.title}`
      : `Pick up ${pick.issueIdentifier}`;
    const evidence = {
      queuePosition: pick.queuePosition,
      projectId: pick.projectId,
      projectName: pick.projectName,
    };

    yield* Effect.logInfo(PLANNER_RECOMMENDATION_PROPOSED_LOG).pipe(
      Effect.annotateLogs({
        recommendationId,
        capability: QUEUE_SELECTION_CAPABILITY,
        target: pick.issueIdentifier,
        summary,
        evidence: JSON.stringify(evidence),
        autoApproveEligible: "false",
        timestampUnixNano: ctx.now(),
      }),
    );

    return { kind: "emitted" as const, target: pick.issueIdentifier };
  });

/**
 * Deterministic sort: queue_position ASC; tiebreak on
 * issue_identifier ASC so reordering is stable across the
 * dashboard's snapshot writes. Mutates a copy of the input.
 */
function sortReady(rows: readonly ReadyForAgentRow[]): readonly ReadyForAgentRow[] {
  const copy = [...rows];
  copy.sort((a, b) => {
    if (a.queuePosition !== b.queuePosition) {
      return a.queuePosition - b.queuePosition;
    }
    return a.issueIdentifier.localeCompare(b.issueIdentifier);
  });
  return copy;
}
