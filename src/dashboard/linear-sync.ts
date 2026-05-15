import { LinearClient } from "@linear/sdk";
import type { LinearSnapshotRow, Storage } from "./storage.js";

/**
 * VA-390 (dashboard slice 6): Linear sync module.
 *
 * The dashboard is otherwise read-only — it ingests OTLP spans from
 * `runway run`. This module is the one place where it reaches back to
 * Linear to surface live workflow state: the Todo queue (so operators
 * see what's about to be picked up next) and the current status of
 * recently-touched issues (so a row's badge can reflect "actually
 * In Review now" rather than the runway-side outcome at emit time).
 *
 * The module is split in two:
 *
 *   1. `LinearAdapter` — narrow async interface (`getTodoQueue`,
 *      `refreshStatus`) so the poller can be unit-tested with a
 *      handwritten fake. The concrete `createLinearAdapter` wraps
 *      `@linear/sdk` and is the only spot in the dashboard that talks
 *      to Linear directly.
 *
 *   2. `startLinearSync` — the poller. Runs an immediate tick, then
 *      every N seconds. Errors are logged but never crash the loop.
 *      When `LINEAR_API_KEY` is absent the dashboard never calls
 *      this — graceful degradation lives at the call site, not inside
 *      the poller.
 */

/**
 * Trimmed-down view of a Linear issue, just the fields the dashboard
 * needs. Title + status + labels are surfaced in the UI; identifier
 * is the join key against `issue_processes.issue_identifier`.
 */
export interface LinearSnapshot {
  readonly identifier: string;
  readonly title: string;
  readonly status: string;
  readonly labels: readonly string[];
}

/**
 * Async surface tested via handwritten fakes (per AC). Intentionally
 * NOT an Effect interface — keeping it `Promise<...>` lets a test
 * stub be a plain object without pulling Effect into every fixture.
 *
 * - `getTodoQueue` returns issues currently in the configured ready
 *   status (defaults to "Todo"), ordered as Linear would pick them up
 *   next. The returned array order IS the queue order.
 *
 * - `refreshStatus` returns current snapshots for the requested
 *   identifiers. Identifiers that no longer exist in Linear are
 *   silently dropped (the dashboard renders no badge in that case).
 */
export interface LinearAdapter {
  getTodoQueue(): Promise<readonly LinearSnapshot[]>;
  refreshStatus(
    identifiers: readonly string[],
  ): Promise<readonly LinearSnapshot[]>;
}

export interface LinearAdapterOptions {
  readonly apiKey: string;
  /** Linear team key (e.g. "VA"). Defaults to "VA". */
  readonly team?: string;
  /** Workflow state name treated as "ready to pick up". Defaults to "Todo". */
  readonly readyStatus?: string;
}

/**
 * Concrete `@linear/sdk`-backed adapter. The dashboard's only direct
 * dependency on the SDK lives here — every other module talks to the
 * `LinearAdapter` interface, so swapping the SDK or stubbing in tests
 * stays a one-line change.
 *
 * The adapter is intentionally narrow: no retry, no rate limiting, no
 * schema validation. Linear-side errors propagate as plain rejected
 * promises and the poller catches them so the dashboard never goes
 * down on a transient API hiccup.
 */
export function createLinearAdapter(opts: LinearAdapterOptions): LinearAdapter {
  const client = new LinearClient({ apiKey: opts.apiKey });
  const teamKey = opts.team ?? "VA";
  const readyStatus = opts.readyStatus ?? "Todo";

  async function snapshotFromIssue(raw: {
    identifier: string;
    title: string;
    state?: Promise<{ name: string } | undefined>;
    labels: () => Promise<{ nodes: ReadonlyArray<{ name: string }> }>;
  }): Promise<LinearSnapshot> {
    const [state, labels] = await Promise.all([raw.state, raw.labels()]);
    return {
      identifier: raw.identifier,
      title: raw.title,
      status: state?.name ?? "",
      labels: labels.nodes.map((l) => l.name),
    };
  }

  return {
    async getTodoQueue() {
      const teams = await client.teams({ filter: { key: { eq: teamKey } } });
      const team = teams.nodes[0];
      if (!team) return [];
      const states = await client.workflowStates({
        filter: {
          team: { id: { eq: team.id } },
          name: { eq: readyStatus },
        },
      });
      const state = states.nodes[0];
      if (!state) return [];
      const issues = await client.issues({
        filter: {
          team: { id: { eq: team.id } },
          state: { id: { eq: state.id } },
        },
      });
      const out: LinearSnapshot[] = [];
      for (const i of issues.nodes) {
        out.push(await snapshotFromIssue(i));
      }
      return out;
    },

    async refreshStatus(identifiers) {
      if (identifiers.length === 0) return [];
      // Linear's `IssueFilter` doesn't expose an identifier-equality
      // comparator (only `id` against the UUID). The SDK's
      // `client.issue(...)` accessor is overloaded to accept either
      // the UUID or the human-readable identifier, though, so we
      // fan out one call per requested identifier. Missing or
      // archived issues throw — swallow individually so a single
      // bad id doesn't abort the whole refresh tick.
      const out: LinearSnapshot[] = [];
      for (const id of identifiers) {
        try {
          const raw = await client.issue(id);
          out.push(await snapshotFromIssue(raw));
        } catch {
          // Issue no longer accessible (deleted, permissions changed,
          // identifier renamed). The dashboard renders no badge.
        }
      }
      return out;
    },
  };
}

export interface LinearSyncOptions {
  readonly adapter: LinearAdapter;
  readonly storage: Storage;
  /** Poll interval in seconds. Defaults to 300 (5 minutes). */
  readonly intervalSeconds?: number;
  /**
   * Maximum identifiers to feed to `refreshStatus` per tick. Caps the
   * fan-out so a dashboard with thousands of historic issue processes
   * doesn't issue a single huge filter query every poll. Defaults to
   * 50, matching the dashboard list view's default page size.
   */
  readonly refreshLimit?: number;
  /**
   * Optional logger so the dashboard's stdout reflects poller activity
   * the same way the rest of `server.ts` does. Defaults to
   * `console.log` for ok messages and `console.error` for failures.
   */
  readonly logger?: (level: "info" | "error", msg: string, err?: unknown) => void;
  /**
   * Test seam: the recent-identifier list `refreshStatus` is called
   * with. In production this defaults to the most-recent N rows from
   * `storage.listIssueProcesses`; tests override to drive deterministic
   * input without seeding the issue-process table.
   */
  readonly recentIdentifiers?: () => readonly string[];
}

export interface LinearSyncHandle {
  /** Stop the poller. Idempotent. */
  stop(): void;
  /** Trigger a tick now; returns when the tick is done. Used by tests. */
  tick(): Promise<void>;
  /**
   * Resolves when the initial tick (the one fired on `startLinearSync`
   * to populate `linear_snapshots` immediately) has finished. Tests
   * await this before asserting against call counts so the immediate
   * tick is folded into a deterministic, reachable state.
   */
  readonly initialTick: Promise<void>;
}

const DEFAULT_INTERVAL_SECONDS = 300;
const DEFAULT_REFRESH_LIMIT = 50;

/**
 * Start the Linear sync poller. Returns a handle whose `stop()`
 * cancels the timer; `tick()` runs one cycle synchronously and is the
 * seam tests assert against.
 *
 * The first tick fires immediately (not after `intervalSeconds`), so
 * the dashboard has a populated `linear_snapshots` row set as soon as
 * the first poll completes — operators don't have to wait 5 minutes
 * for the queue preview to appear after a `docker compose up`.
 */
export function startLinearSync(opts: LinearSyncOptions): LinearSyncHandle {
  const intervalMs =
    Math.max(1, opts.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS) * 1000;
  const refreshLimit = Math.max(1, opts.refreshLimit ?? DEFAULT_REFRESH_LIMIT);
  const log =
    opts.logger ??
    ((level, msg, err) => {
      if (level === "error") console.error(msg, err);
      else console.log(msg);
    });

  const tick = async (): Promise<void> => {
    try {
      const queue = await opts.adapter.getTodoQueue();
      // Wipe queue positions before saving fresh ones so issues that
      // left Todo since the last poll stop appearing in the preview.
      opts.storage.clearLinearQueuePositions();
      const at = new Date().toISOString();
      queue.forEach((q, i) => {
        opts.storage.saveLinearSnapshot({
          issueIdentifier: q.identifier,
          snapshotAt: at,
          status: q.status,
          title: q.title,
          labels: q.labels,
          queuePosition: i,
        });
      });
      log(
        "info",
        `[runway dashboard] linear sync: refreshed Todo queue (${queue.length} issue${queue.length === 1 ? "" : "s"})`,
      );
    } catch (err) {
      log("error", "[runway dashboard] linear sync: getTodoQueue failed", err);
    }

    try {
      const recent =
        opts.recentIdentifiers?.() ?? defaultRecentIdentifiers(opts.storage, refreshLimit);
      if (recent.length > 0) {
        const refreshed = await opts.adapter.refreshStatus(recent);
        const at = new Date().toISOString();
        for (const r of refreshed) {
          opts.storage.saveLinearSnapshot({
            issueIdentifier: r.identifier,
            snapshotAt: at,
            status: r.status,
            title: r.title,
            labels: r.labels,
            queuePosition: null,
          });
        }
        log(
          "info",
          `[runway dashboard] linear sync: refreshed status for ${refreshed.length} of ${recent.length} recent issue${recent.length === 1 ? "" : "s"}`,
        );
      }
    } catch (err) {
      log("error", "[runway dashboard] linear sync: refreshStatus failed", err);
    }
  };

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick().finally(schedule);
    }, intervalMs);
  };
  // Kick off the first tick immediately. Schedule the next one off
  // its completion so a slow tick can't pile up calls.
  const initialTick = tick().finally(schedule);

  return {
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    tick,
    initialTick,
  };
}

/**
 * Pull the most-recent issue identifiers from the issue-process table.
 * The poller hands these to `refreshStatus` so the dashboard's badges
 * reflect Linear's current view of issues runway has touched.
 */
function defaultRecentIdentifiers(
  storage: Storage,
  limit: number,
): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ip of storage.listIssueProcesses({ limit })) {
    if (!ip.issueIdentifier) continue;
    if (seen.has(ip.issueIdentifier)) continue;
    seen.add(ip.issueIdentifier);
    out.push(ip.issueIdentifier);
  }
  return out;
}
