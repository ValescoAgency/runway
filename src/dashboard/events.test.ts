import { describe, expect, it, vi } from "vitest";
import { createEventBus, type DashboardEvent } from "./events.js";

// VA-391: pub/sub semantics tests. The bus is dead simple but the
// failure modes here would cascade into the SSE path — silent
// dropped events on an SSE detail page would be impossible to
// debug post-hoc.

const issueProcessEvent: DashboardEvent = {
  kind: "issueProcessChanged",
  traceId: "trace-A",
  issueProcessSpanId: "span-A",
};

const logEvent: DashboardEvent = {
  kind: "logRecordAppended",
  traceId: "trace-A",
  spanId: "span-A",
};

describe("createEventBus — publish/subscribe (VA-391)", () => {
  it("delivers a published event to a matching subscriber", () => {
    const bus = createEventBus();
    const listener = vi.fn();
    bus.subscribe({ traceId: "trace-A" }, listener);

    bus.publish(issueProcessEvent);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(issueProcessEvent);
  });

  it("filters out events whose traceId doesn't match the subscription", () => {
    const bus = createEventBus();
    const listener = vi.fn();
    bus.subscribe({ traceId: "trace-A" }, listener);

    bus.publish({ ...issueProcessEvent, traceId: "trace-B" });

    expect(listener).not.toHaveBeenCalled();
  });

  it("delivers all events when the subscription has no traceId filter", () => {
    const bus = createEventBus();
    const listener = vi.fn();
    bus.subscribe({}, listener);

    bus.publish({ ...issueProcessEvent, traceId: "trace-A" });
    bus.publish({ ...logEvent, traceId: "trace-B" });

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("fans out a single publish to every matching subscriber", () => {
    const bus = createEventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe({ traceId: "trace-A" }, a);
    bus.subscribe({ traceId: "trace-A" }, b);

    bus.publish(issueProcessEvent);

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe stops further deliveries (and is idempotent)", () => {
    const bus = createEventBus();
    const listener = vi.fn();
    const sub = bus.subscribe({ traceId: "trace-A" }, listener);

    bus.publish(issueProcessEvent);
    sub.unsubscribe();
    sub.unsubscribe(); // idempotent — must not throw
    bus.publish(issueProcessEvent);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(bus.subscriberCount()).toBe(0);
  });

  it("a throwing subscriber doesn't break the publish loop for other subscribers", () => {
    const bus = createEventBus();
    const ok = vi.fn();
    bus.subscribe({}, () => {
      throw new Error("listener exploded");
    });
    bus.subscribe({}, ok);

    expect(() => bus.publish(issueProcessEvent)).not.toThrow();
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("publishes both event kinds to a wildcard subscriber", () => {
    const bus = createEventBus();
    const seen: DashboardEvent[] = [];
    bus.subscribe({}, (e) => seen.push(e));

    bus.publish(issueProcessEvent);
    bus.publish(logEvent);

    expect(seen.map((e) => e.kind)).toEqual([
      "issueProcessChanged",
      "logRecordAppended",
    ]);
  });

  it("two subscribes with the same listener register two slots — unsubscribe frees only one", () => {
    const bus = createEventBus();
    const listener = vi.fn();
    const subA = bus.subscribe({}, listener);
    bus.subscribe({}, listener);

    bus.publish(issueProcessEvent);
    expect(listener).toHaveBeenCalledTimes(2);

    subA.unsubscribe();
    listener.mockClear();
    bus.publish(issueProcessEvent);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(bus.subscriberCount()).toBe(1);
  });
});
