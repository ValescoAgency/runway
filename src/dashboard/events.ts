/**
 * VA-391: in-process pub/sub for live dashboard updates. The OTLP
 * ingest path publishes events when storage rows change; SSE
 * handlers subscribe and stream matching events to the browser.
 * No external broker — single-process, single-listener-set, fan-out
 * happens here.
 *
 * Two event shapes today; more can be added by extending the union:
 *
 *   issueProcessChanged — a new or upserted issue_processes row.
 *                         The list view polls every 3s and doesn't
 *                         strictly need this, but the SSE detail
 *                         pane uses it to refresh phase-timeline
 *                         data when an iteration lands.
 *
 *   logRecordAppended   — a new log_records row. The SSE detail
 *                         pane consumes this to live-tail logs into
 *                         the Logs section.
 *
 * Subscribers pass a filter so the SSE handler at
 * `/issue-processes/:id/stream` only sees events tied to that issue
 * process's trace_id. The bus does the matching inside `publish` so
 * an inactive subscription costs nothing on the hot path beyond a
 * comparison.
 */

export type DashboardEvent =
  | {
      readonly kind: "issueProcessChanged";
      readonly traceId: string;
      readonly issueProcessSpanId: string;
    }
  | {
      readonly kind: "logRecordAppended";
      readonly traceId: string;
      readonly spanId: string;
    };

export interface EventFilter {
  /**
   * Restrict subscription to events whose `traceId` matches. SSE
   * detail handlers pass the issue process's trace_id; the list view
   * (when later wired) might pass undefined to see everything.
   */
  readonly traceId?: string;
}

export interface Subscription {
  /**
   * Stop receiving events. Idempotent — repeated calls are no-ops.
   * Called by the SSE handler when the client connection closes.
   */
  unsubscribe(): void;
}

export type EventListener = (event: DashboardEvent) => void;

export interface EventBus {
  publish(event: DashboardEvent): void;
  subscribe(filter: EventFilter, listener: EventListener): Subscription;
  /**
   * Test affordance: count of active subscriptions. Production code
   * doesn't rely on this — it's exposed so tests can assert that
   * `Subscription.unsubscribe()` actually frees the listener slot.
   */
  subscriberCount(): number;
}

interface Entry {
  readonly filter: EventFilter;
  readonly listener: EventListener;
}

/**
 * Construct a fresh in-process event bus. Each dashboard server gets
 * one; storage stays oblivious — the server is the publish boundary.
 */
export function createEventBus(): EventBus {
  // Set semantics: every subscribe returns a fresh `Entry`, so unsub
  // can `Set.delete` the exact slot without comparing listeners. A
  // duplicate subscribe with the same listener registers a second
  // entry on purpose — the SSE handler doesn't, but we don't want a
  // future caller's bug masked by silent dedup.
  const entries = new Set<Entry>();

  return {
    publish(event) {
      for (const e of entries) {
        if (e.filter.traceId !== undefined && e.filter.traceId !== event.traceId) {
          continue;
        }
        try {
          e.listener(event);
        } catch {
          // A misbehaving subscriber must not break the publish loop —
          // SSE handlers stream over the network and can fail in any
          // number of ways. Swallow and continue; the next iteration
          // delivers to other subscribers.
        }
      }
    },
    subscribe(filter, listener) {
      const entry: Entry = { filter, listener };
      entries.add(entry);
      let removed = false;
      return {
        unsubscribe() {
          if (removed) return;
          entries.delete(entry);
          removed = true;
        },
      };
    },
    subscriberCount() {
      return entries.size;
    },
  };
}
