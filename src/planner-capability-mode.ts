import { Effect } from "effect";
import { PLANNER_RECOMMENDATION_ACCEPTED_LOG } from "./dashboard/projector.js";
import type {
  PlannerCapability,
  PlannerCapabilityMode,
} from "./dashboard/storage.js";
import type { PlannerReadClient } from "./planner-storage.js";

/**
 * VA-481: shared capability-mode helpers used by every planner
 * capability dispatcher. The mode-lookup defaults to `suggest` for
 * capabilities that have never been explicitly toggled — same as
 * ADR 0004 § UX ("`suggest` is the default; operators promote
 * individual capabilities to `auto` once trust accumulates").
 *
 * `autoAcceptIfEligible` is the auto-mode fast-forward: when a
 * capability emits `recommendation.proposed` with
 * `autoApproveEligible: true`, the dispatcher follows up immediately
 * with `recommendation.accepted` (source="auto") so the drain-spawn
 * capability picks it up on the next tick without waiting for an
 * operator click. Recommendations the capability self-flags as
 * NOT eligible (e.g., LLM-interpreted ambiguous human comments)
 * still require operator approval even in `auto`.
 */

export const DEFAULT_CAPABILITY_MODE: PlannerCapabilityMode = "suggest";

export function resolveCapabilityMode(
  readClient: PlannerReadClient,
  capability: PlannerCapability,
): PlannerCapabilityMode {
  const row = readClient.getCapabilityMode(capability);
  return row?.mode ?? DEFAULT_CAPABILITY_MODE;
}

export interface AutoAcceptArgs {
  readonly mode: PlannerCapabilityMode;
  readonly recommendationId: string;
  readonly autoApproveEligible: boolean;
  readonly now: () => string;
}

/**
 * Emit `recommendation.accepted` immediately if the capability is in
 * `auto` mode AND the recommendation is auto-approve-eligible. The
 * dashboard projection treats this exactly like an operator-clicked
 * accept — same UPDATE guard, same downstream lifecycle.
 *
 * Idempotent: if the capability is `manual` / `suggest` or the
 * recommendation is not eligible, this is a no-op.
 */
export const autoAcceptIfEligible = (
  args: AutoAcceptArgs,
): Effect.Effect<boolean> => {
  if (args.mode !== "auto" || !args.autoApproveEligible) {
    return Effect.succeed(false);
  }
  return Effect.logInfo(PLANNER_RECOMMENDATION_ACCEPTED_LOG).pipe(
    Effect.annotateLogs({
      recommendationId: args.recommendationId,
      source: "auto",
      timestampUnixNano: args.now(),
    }),
    Effect.as(true),
  );
};
