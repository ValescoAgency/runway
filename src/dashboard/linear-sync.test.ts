import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  startLinearSync,
  type LinearAdapter,
  type LinearSnapshot,
  type LinearSyncHandle,
} from "./linear-sync.js";
import { createStorage, type Storage } from "./storage.js";

// VA-390: Linear sync tests use a handwritten fake adapter (per AC).
// No vitest mocking framework — each test wires up the adapter shape
// directly so the contract between poller and adapter stays explicit.

interface FakeAdapter extends LinearAdapter {
  readyQueueCalls: number;
  refreshStatusCalls: ReadonlyArray<readonly string[]>;
  /** Queue returned by the next `getReadyQueue` invocation. */
  nextQueue: readonly LinearSnapshot[];
  /** Snapshots returned by the next `refreshStatus` invocation. */
  nextRefresh: readonly LinearSnapshot[];
  /** When true, the next `getReadyQueue` rejects. */
  failGetReadyQueue: boolean;
  /** When true, the next `refreshStatus` rejects. */
  failRefreshStatus: boolean;
}

function makeFakeAdapter(): FakeAdapter {
  // VA-390: keep the fake minimal and inspectable. Tests reach into
  // `readyQueueCalls` / `refreshStatusCalls` to assert call shape,
  // and set `nextQueue` / `nextRefresh` to drive return values.
  const state: FakeAdapter = {
    readyQueueCalls: 0,
    refreshStatusCalls: [],
    nextQueue: [],
    nextRefresh: [],
    failGetReadyQueue: false,
    failRefreshStatus: false,
    async getReadyQueue() {
      state.readyQueueCalls += 1;
      if (state.failGetReadyQueue) throw new Error("linear getReadyQueue boom");
      return state.nextQueue;
    },
    async refreshStatus(ids) {
      state.refreshStatusCalls = [...state.refreshStatusCalls, ids];
      if (state.failRefreshStatus) throw new Error("linear refreshStatus boom");
      return state.nextRefresh;
    },
  };
  return state;
}

let storage: Storage;
let handle: LinearSyncHandle | null = null;

beforeEach(() => {
  storage = createStorage(":memory:");
});

afterEach(() => {
  handle?.stop();
  handle = null;
  storage.close();
});

function silentLogger(): (
  level: "info" | "error",
  msg: string,
  err?: unknown,
) => void {
  return () => {};
}

// Helper: long interval so the timer never fires in the test's wall
// clock. Tests call `handle.tick()` directly to drive the poll cycle
// deterministically.
const LONG_INTERVAL = 3600;

describe("startLinearSync — getReadyQueue tick (VA-390)", () => {
  it("stores the Todo queue with sequential queue_position values", async () => {
    const adapter = makeFakeAdapter();
    adapter.nextQueue = [
      { identifier: "VA-1", title: "First", status: "Todo", labels: ["bug"] },
      {
        identifier: "VA-2",
        title: "Second",
        status: "Todo",
        labels: ["feature"],
      },
    ];

    handle = startLinearSync({
      adapter,
      storage,
      intervalSeconds: LONG_INTERVAL,
      logger: silentLogger(),
      recentIdentifiers: () => [],
    });
    await handle.initialTick;

    const queue = storage.listLinearTodoQueue();
    expect(queue.map((q) => q.issueIdentifier)).toEqual(["VA-1", "VA-2"]);
    expect(queue.map((q) => q.queuePosition)).toEqual([0, 1]);
    expect(queue[0]).toMatchObject({
      title: "First",
      status: "Todo",
      labels: ["bug"],
    });
  });

  it("clears prior queue_position so issues that left Todo drop out of the preview", async () => {
    const adapter = makeFakeAdapter();
    adapter.nextQueue = [
      { identifier: "VA-1", title: "stale", status: "Todo", labels: [] },
      { identifier: "VA-2", title: "stays", status: "Todo", labels: [] },
    ];
    handle = startLinearSync({
      adapter,
      storage,
      intervalSeconds: LONG_INTERVAL,
      logger: silentLogger(),
      recentIdentifiers: () => [],
    });
    await handle.initialTick;
    expect(storage.listLinearTodoQueue().map((q) => q.issueIdentifier)).toEqual([
      "VA-1",
      "VA-2",
    ]);

    // VA-1 moved to In Progress between polls. The next getReadyQueue
    // returns only VA-2, and VA-1 must vanish from the queue preview
    // even though we never explicitly deleted its row.
    adapter.nextQueue = [
      { identifier: "VA-2", title: "stays", status: "Todo", labels: [] },
    ];
    await handle.tick();
    const queue = storage.listLinearTodoQueue();
    expect(queue.map((q) => q.issueIdentifier)).toEqual(["VA-2"]);
    // VA-1 is still in linear_snapshots (so its status badge still
    // resolves), just no longer flagged with a queue_position.
    const all = storage.listLinearSnapshots();
    expect(all.find((s) => s.issueIdentifier === "VA-1")?.queuePosition).toBeNull();
  });

  it("survives a getReadyQueue error and still calls refreshStatus on the same tick", async () => {
    const adapter = makeFakeAdapter();
    adapter.failGetReadyQueue = true;
    adapter.nextRefresh = [
      {
        identifier: "VA-7",
        title: "fresh",
        status: "In Review",
        labels: [],
      },
    ];

    handle = startLinearSync({
      adapter,
      storage,
      intervalSeconds: LONG_INTERVAL,
      logger: silentLogger(),
      recentIdentifiers: () => ["VA-7"],
    });
    await handle.initialTick;

    expect(adapter.readyQueueCalls).toBe(1);
    expect(adapter.refreshStatusCalls).toEqual([["VA-7"]]);
    const snap = storage
      .listLinearSnapshots()
      .find((s) => s.issueIdentifier === "VA-7");
    expect(snap?.status).toBe("In Review");
  });
});

describe("startLinearSync — refreshStatus tick (VA-390)", () => {
  it("upserts snapshots for the supplied identifiers with queue_position=null", async () => {
    const adapter = makeFakeAdapter();
    adapter.nextRefresh = [
      {
        identifier: "VA-10",
        title: "in review",
        status: "In Review",
        labels: ["bug"],
      },
    ];

    handle = startLinearSync({
      adapter,
      storage,
      intervalSeconds: LONG_INTERVAL,
      logger: silentLogger(),
      recentIdentifiers: () => ["VA-10"],
    });
    await handle.initialTick;

    const snap = storage
      .listLinearSnapshots()
      .find((s) => s.issueIdentifier === "VA-10");
    expect(snap).toMatchObject({
      issueIdentifier: "VA-10",
      title: "in review",
      status: "In Review",
      labels: ["bug"],
      queuePosition: null,
    });
  });

  it("skips refreshStatus entirely when the recent-identifiers list is empty", async () => {
    const adapter = makeFakeAdapter();
    handle = startLinearSync({
      adapter,
      storage,
      intervalSeconds: LONG_INTERVAL,
      logger: silentLogger(),
      recentIdentifiers: () => [],
    });
    await handle.initialTick;
    expect(adapter.refreshStatusCalls).toEqual([]);
  });

  it("survives a refreshStatus error without affecting prior queue snapshot", async () => {
    const adapter = makeFakeAdapter();
    adapter.nextQueue = [
      { identifier: "VA-1", title: "queued", status: "Todo", labels: [] },
    ];
    adapter.failRefreshStatus = true;

    handle = startLinearSync({
      adapter,
      storage,
      intervalSeconds: LONG_INTERVAL,
      logger: silentLogger(),
      recentIdentifiers: () => ["VA-99"],
    });
    await handle.initialTick;

    expect(storage.listLinearTodoQueue().map((q) => q.issueIdentifier)).toEqual([
      "VA-1",
    ]);
    // Failed refresh produced no snapshot for VA-99.
    expect(
      storage
        .listLinearSnapshots()
        .find((s) => s.issueIdentifier === "VA-99"),
    ).toBeUndefined();
  });

  it("preserves queue_position when an identifier is in both getReadyQueue and recentIdentifiers", async () => {
    // VA-390: an issue in Todo can also be in the recent-touched list
    // (the dashboard just opened it). The refreshStatus save path must
    // not clobber the queue_position that getReadyQueue set on the same
    // tick — otherwise the issue vanishes from the Todo queue preview
    // even though Linear still has it in Todo.
    const adapter = makeFakeAdapter();
    adapter.nextQueue = [
      { identifier: "VA-1", title: "queued", status: "Todo", labels: ["bug"] },
    ];
    adapter.nextRefresh = [
      {
        identifier: "VA-1",
        title: "queued (refreshed)",
        status: "Todo",
        labels: ["bug"],
      },
    ];
    handle = startLinearSync({
      adapter,
      storage,
      intervalSeconds: LONG_INTERVAL,
      logger: silentLogger(),
      recentIdentifiers: () => ["VA-1"],
    });
    await handle.initialTick;

    // Queue preview still lists VA-1 with its queue_position intact.
    const queue = storage.listLinearTodoQueue();
    expect(queue.map((q) => q.issueIdentifier)).toEqual(["VA-1"]);
    expect(queue[0]?.queuePosition).toBe(0);
    // The original queue snapshot fields are preserved — refreshStatus
    // did not overwrite the row with queue_position: null.
    expect(queue[0]).toMatchObject({
      title: "queued",
      status: "Todo",
      labels: ["bug"],
    });
  });

  it("pulls recent identifiers from storage.listIssueProcesses by default (dedup + most-recent first)", async () => {
    // VA-390: by default the poller asks storage for the most recent
    // distinct issue identifiers. Seed a few issue_processes rows so
    // we can assert the integration without a `recentIdentifiers`
    // override.
    for (const [i, ident] of ["VA-1", "VA-2", "VA-2"].entries()) {
      storage.saveIssueProcess({
        traceId: `trace-${i}`.padEnd(32, "0"),
        spanId: `span-${i}`.padEnd(16, "0"),
        parentSpanId: null,
        issueIdentifier: ident,
        issueId: null,
        issueTitle: null,
        issueLabels: [],
        branch: null,
        outcomeKind: "opened",
        outcomeDetail: null,
        prUrl: null,
        hitlReason: null,
        startTimeUnixNano: "0",
        endTimeUnixNano: "0",
        statusCode: null,
        statusMessage: null,
      });
    }
    const adapter = makeFakeAdapter();
    handle = startLinearSync({
      adapter,
      storage,
      intervalSeconds: LONG_INTERVAL,
      logger: silentLogger(),
      // No `recentIdentifiers` override — exercise the default path.
    });
    await handle.initialTick;

    expect(adapter.refreshStatusCalls).toHaveLength(1);
    // De-duped: VA-2 appears once.
    expect([...adapter.refreshStatusCalls[0]!].sort()).toEqual(["VA-1", "VA-2"]);
  });
});

describe("startLinearSync — graceful degradation (VA-390)", () => {
  // VA-390 AC: "When LINEAR_API_KEY is absent: poller does not start
  // ... no errors logged." Graceful degradation lives at the call
  // site (server.ts's main()); the poller's own contract is that it
  // never throws synchronously and never crashes on adapter errors.
  // The test here exercises the poller's no-throw guarantee under
  // both an error and a success path.

  it("a tick where both adapter methods reject still resolves without throwing", async () => {
    const adapter = makeFakeAdapter();
    adapter.failGetReadyQueue = true;
    adapter.failRefreshStatus = true;
    handle = startLinearSync({
      adapter,
      storage,
      intervalSeconds: LONG_INTERVAL,
      logger: silentLogger(),
      recentIdentifiers: () => ["VA-1"],
    });
    await expect(handle.initialTick).resolves.toBeUndefined();
  });

  it("stop() prevents the next scheduled tick from firing", async () => {
    const adapter = makeFakeAdapter();
    handle = startLinearSync({
      adapter,
      storage,
      // Short interval so the next tick would fire quickly without
      // stop(). The initial tick runs immediately on `startLinearSync`,
      // so awaiting `initialTick` then stop()'ing means the second
      // tick never fires.
      intervalSeconds: 1,
      logger: silentLogger(),
      recentIdentifiers: () => [],
    });
    await handle.initialTick;
    handle.stop();
    handle = null;
    const seen = adapter.readyQueueCalls;
    expect(seen).toBe(1);
    await new Promise((r) => setTimeout(r, 1100));
    expect(adapter.readyQueueCalls).toBe(seen);
  });
});
