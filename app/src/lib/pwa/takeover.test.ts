import { describe, expect, it, vi } from "vitest";
import { createTakeoverReload, SELF_RELOAD_GRACE_MS, TAKEOVER_DEADLINE_MS, type TakeoverClient } from "./takeover";

function clientsWith(entries: Record<string, TakeoverClient | undefined>) {
  return { get: vi.fn(async (id: string) => entries[id]) };
}

/** Active at once, no real waiting: the default for tests that are not about timing. */
const now = { activated: async () => undefined, sleep: async () => undefined };

describe("createTakeoverReload", () => {
  it("brings a page that did not reload itself onto the new build, at its own URL", async () => {
    const navigate = vi.fn(async () => undefined);
    const clients = clientsWith({ "tab-1": { url: "https://app.test/clock?x=1", navigate } });
    const takeover = createTakeoverReload(clients, now);
    expect(takeover.asked({ id: "tab-1" })).toBe(true);
    expect(await takeover.finish()).toBe(true);
    expect(navigate).toHaveBeenCalledWith("https://app.test/clock?x=1");
  });

  it("leaves a page that is reloading itself alone — a second navigation would cancel it (2026-09-28)", async () => {
    const navigate = vi.fn(async () => undefined);
    const clients = clientsWith({ "tab-1": { url: "https://app.test/", navigate } });
    // The page's own reload reaches the worker during the grace period, carrying its own (the asker's) client id.
    const takeover = createTakeoverReload(clients, {
      activated: async () => undefined,
      sleep: async () => takeover.navigationSeen("tab-1"),
    });
    takeover.asked({ id: "tab-1" });
    expect(await takeover.finish()).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("a same-URL navigation from a DIFFERENT tab does not suppress the asker's fallback", async () => {
    // Two tabs on the identical URL: only clientId identifies which one asked
    // (real Chromium 151 measurement, pr675-navigation-identity-probe.mjs —
    // URL alone cannot tell them apart).
    const navigate = vi.fn(async () => undefined);
    const clients = clientsWith({ "tab-1": { url: "https://app.test/same", navigate } });
    const takeover = createTakeoverReload(clients, now);
    takeover.asked({ id: "tab-1" });
    // An ordinary navigation in another tab on the same URL, e.g. it also reloaded.
    takeover.navigationSeen("tab-2");
    expect(await takeover.finish()).toBe(true);
    expect(navigate).toHaveBeenCalledWith("https://app.test/same");
  });

  it("a slow in-flight self-reload arriving right at the end of the grace period still suppresses the fallback", async () => {
    const navigate = vi.fn(async () => undefined);
    const clients = clientsWith({ "tab-1": { url: "https://app.test/", navigate } });
    const takeover = createTakeoverReload(clients, {
      activated: async () => undefined,
      // The asker's own reload is slow but still lands before finish() checks it.
      sleep: async () => {
        await Promise.resolve();
        takeover.navigationSeen("tab-1");
      },
    });
    takeover.asked({ id: "tab-1" });
    expect(await takeover.finish()).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("a navigation with missing/unknown clientId fails safe by suppressing the fallback", async () => {
    // Real Chromium also produced an empty clientId (an initial, pre-controller
    // navigation). Treating "unknown" as "might be the asker" costs the
    // fallback on that rare shape rather than risking a duplicate navigation.
    const navigate = vi.fn(async () => undefined);
    const clients = clientsWith({ "tab-1": { url: "https://app.test/", navigate } });
    const takeover = createTakeoverReload(clients, now);
    takeover.asked({ id: "tab-1" });
    takeover.navigationSeen(undefined);
    expect(await takeover.finish()).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("a duplicate SKIP_WAITING from the SAME source while an ask is in flight does not own anything", async () => {
    const navigate = vi.fn(async () => undefined);
    const clients = clientsWith({ "tab-1": { url: "https://app.test/", navigate } });
    const takeover = createTakeoverReload(clients, now);
    expect(takeover.asked({ id: "tab-1" })).toBe(true);
    expect(takeover.asked({ id: "tab-1" })).toBe(false);
    expect(await takeover.finish()).toBe(true);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("a duplicate SKIP_WAITING from ANOTHER source while an ask is in flight does not steal or reset it", async () => {
    const navigateA = vi.fn(async () => undefined);
    const navigateB = vi.fn(async () => undefined);
    const clients = clientsWith({
      "tab-1": { url: "https://app.test/", navigate: navigateA },
      "tab-2": { url: "https://app.test/other", navigate: navigateB },
    });
    const takeover = createTakeoverReload(clients, now);
    expect(takeover.asked({ id: "tab-1" })).toBe(true);
    // A second tab asks while the first is still in flight — it owns nothing.
    expect(takeover.asked({ id: "tab-2" })).toBe(false);
    expect(await takeover.finish()).toBe(true);
    expect(navigateA).toHaveBeenCalledTimes(1);
    expect(navigateB).not.toHaveBeenCalled();
  });

  it("checks the deadline again after a slow client lookup, and does not navigate a page whose decision window has closed", async () => {
    const navigate = vi.fn(async () => undefined);
    let time = 0;
    const clients = {
      get: vi.fn(async () => {
        // The lookup itself is what carries the clock past the deadline.
        time += TAKEOVER_DEADLINE_MS + 1;
        return { url: "https://app.test/", navigate } as TakeoverClient;
      }),
    };
    const takeover = createTakeoverReload(clients, {
      activated: async () => undefined,
      sleep: async () => undefined,
      now: () => time,
    });
    takeover.asked({ id: "tab-1" });
    expect(await takeover.finish()).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not navigate once the absolute deadline from the ask has passed, even with no navigation seen", async () => {
    const navigate = vi.fn(async () => undefined);
    const clients = clientsWith({ "tab-1": { url: "https://app.test/", navigate } });
    let time = 0;
    const takeover = createTakeoverReload(clients, {
      activated: async () => undefined,
      sleep: async () => {
        time += TAKEOVER_DEADLINE_MS + 1;
      },
      now: () => time,
    });
    takeover.asked({ id: "tab-1" });
    expect(await takeover.finish()).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("gives the page its grace period only once the worker is active, when its reload can first arrive", async () => {
    const order: string[] = [];
    let activate: () => void = () => {};
    const activated = new Promise<void>((resolve) => {
      activate = resolve;
    });
    const sleep = vi.fn(async (ms: number) => {
      order.push(`grace ${ms}`);
    });
    const navigate = vi.fn(async () => {
      order.push("navigate");
    });
    const takeover = createTakeoverReload(clientsWith({ "tab-1": { url: "https://app.test/", navigate } }), {
      activated: () => activated,
      sleep,
    });
    takeover.asked({ id: "tab-1" });
    const done = takeover.finish();
    await Promise.resolve();
    expect(sleep).not.toHaveBeenCalled();
    order.push("activated");
    activate();
    expect(await done).toBe(true);
    expect(order).toEqual(["activated", `grace ${SELF_RELOAD_GRACE_MS}`, "navigate"]);
  });

  it("waits the real grace period by default", async () => {
    vi.useFakeTimers();
    try {
      const navigate = vi.fn(async () => undefined);
      const takeover = createTakeoverReload(clientsWith({ "tab-1": { url: "https://app.test/", navigate } }), {
        activated: async () => undefined,
      });
      takeover.asked({ id: "tab-1" });
      const done = takeover.finish();
      // Let it reach the grace period (after the activation it awaits).
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(SELF_RELOAD_GRACE_MS - 1);
      expect(navigate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await done).toBe(true);
      expect(navigate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing for a page that reloaded itself already — a reloaded page is a new client", async () => {
    const takeover = createTakeoverReload(clientsWith({}), now);
    takeover.asked({ id: "old-document" });
    expect(await takeover.finish()).toBe(false);
  });

  it("a navigation seen before a fresh ask does not count against it", async () => {
    const navigate = vi.fn(async () => undefined);
    const takeover = createTakeoverReload(clientsWith({ "tab-1": { url: "https://app.test/", navigate } }), now);
    takeover.navigationSeen("tab-1");
    takeover.asked({ id: "tab-1" });
    expect(await takeover.finish()).toBe(true);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("leaves every page alone when nobody asked — a natural activation after the app was closed", async () => {
    const clients = clientsWith({ "tab-1": { url: "https://app.test/", navigate: vi.fn() } });
    const activated = vi.fn(async () => undefined);
    const takeover = createTakeoverReload(clients, { activated, sleep: async () => undefined });
    expect(await takeover.finish()).toBe(false);
    expect(clients.get).not.toHaveBeenCalled();
    expect(activated).not.toHaveBeenCalled();
  });

  it("consumes the ask: a second activation with no new ask reloads nobody", async () => {
    const navigate = vi.fn(async () => undefined);
    const takeover = createTakeoverReload(clientsWith({ "tab-1": { url: "https://app.test/", navigate } }), now);
    takeover.asked({ id: "tab-1" });
    await takeover.finish();
    expect(await takeover.finish()).toBe(false);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("rejects a delayed duplicate after finishing, so one worker cannot navigate twice", async () => {
    const navigate = vi.fn(async () => undefined);
    const takeover = createTakeoverReload(clientsWith({ "tab-1": { url: "https://app.test/", navigate } }), now);
    expect(takeover.asked({ id: "tab-1" })).toBe(true);
    await takeover.finish();
    expect(takeover.asked({ id: "tab-1" })).toBe(false);
    expect(takeover.asked({ id: "tab-2" })).toBe(false);
    expect(await takeover.finish()).toBe(false);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("rejects a delayed duplicate after the page's own reload suppressed the fallback", async () => {
    const navigate = vi.fn(async () => undefined);
    const takeover = createTakeoverReload(clientsWith({ "tab-1": { url: "https://app.test/", navigate } }), now);
    expect(takeover.asked({ id: "tab-1" })).toBe(true);
    takeover.navigationSeen("tab-1");
    expect(await takeover.finish()).toBe(false);
    expect(takeover.asked({ id: "tab-1" })).toBe(false);
    expect(await takeover.finish()).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does nothing in a browser that will not let a worker navigate a page", async () => {
    const takeover = createTakeoverReload(clientsWith({ "tab-1": { url: "https://app.test/" } }), now);
    takeover.asked({ id: "tab-1" });
    expect(await takeover.finish()).toBe(false);
  });

  it("swallows a navigation the browser refuses, so nothing fails on it", async () => {
    const navigate = vi.fn(async () => {
      throw new Error("not allowed");
    });
    const takeover = createTakeoverReload(clientsWith({ "tab-1": { url: "https://app.test/", navigate } }), now);
    takeover.asked({ id: "tab-1" });
    await expect(takeover.finish()).resolves.toBe(false);
  });

  it("swallows an activation that failed", async () => {
    const navigate = vi.fn(async () => undefined);
    const takeover = createTakeoverReload(clientsWith({ "tab-1": { url: "https://app.test/", navigate } }), {
      activated: async () => {
        throw new Error("activation failed");
      },
      sleep: async () => undefined,
    });
    takeover.asked({ id: "tab-1" });
    await expect(takeover.finish()).resolves.toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("reads a message with no source as no ask", async () => {
    const navigate = vi.fn(async () => undefined);
    const takeover = createTakeoverReload(clientsWith({ "tab-1": { url: "https://app.test/", navigate } }), now);
    expect(takeover.asked(null)).toBe(false);
    expect(await takeover.finish()).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});
