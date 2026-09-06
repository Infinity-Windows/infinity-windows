import { beforeEach, describe, expect, it } from "vitest";
import {
  RING_MAX,
  clearOfflineEvents,
  getOfflineEvents,
  logOfflineEvent,
  subscribeOfflineEvents,
  summarizeOfflineEvents,
} from "./telemetry";

describe("offline telemetry ring", () => {
  beforeEach(() => clearOfflineEvents());

  it("keeps the newest sixty, newest first", () => {
    for (let i = 0; i < RING_MAX + 5; i++) logOfflineEvent({ type: "timeout", count: i }, i);
    const events = getOfflineEvents();
    expect(events.length).toBe(RING_MAX);
    expect(events[0].count).toBe(RING_MAX + 4);
    expect(events[events.length - 1].count).toBe(5);
  });

  it("tells subscribers, and a throwing subscriber does not break the log", () => {
    let calls = 0;
    const off = subscribeOfflineEvents(() => { calls += 1; });
    subscribeOfflineEvents(() => { throw new Error("bad listener"); });
    logOfflineEvent({ type: "flush", count: 2 });
    expect(calls).toBe(1);
    off();
    logOfflineEvent({ type: "flush", count: 1 });
    expect(calls).toBe(1);
    expect(getOfflineEvents().length).toBe(2);
  });

  it("hands readers the same array until something changes", () => {
    logOfflineEvent({ type: "timeout" });
    const a = getOfflineEvents();
    expect(getOfflineEvents()).toBe(a);
    logOfflineEvent({ type: "timeout" });
    expect(getOfflineEvents()).not.toBe(a);
  });

  it("summarises by kind", () => {
    logOfflineEvent({ type: "timeout" });
    logOfflineEvent({ type: "timeout" });
    logOfflineEvent({ type: "saved-copy", scope: "jobs" });
    logOfflineEvent({ type: "flush", count: 3 });
    logOfflineEvent({ type: "flush", count: 2 });
    logOfflineEvent({ type: "save-job", count: 85 });
    logOfflineEvent({ type: "reload" });
    expect(summarizeOfflineEvents(getOfflineEvents())).toEqual({
      timeouts: 2, savedCopies: 1, flushes: 2, sent: 5, savedJobs: 1, reloads: 1,
    });
  });
});
