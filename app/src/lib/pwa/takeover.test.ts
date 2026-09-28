import { describe, expect, it, vi } from "vitest";
import { createTakeoverReload, SELF_RELOAD_GRACE_MS, type TakeoverClient } from "./takeover";

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
    takeover.asked({ id: "tab-1" });
    expect(await takeover.finish()).toBe(true);
    expect(navigate).toHaveBeenCalledWith("https://app.test/clock?x=1");
  });

  it("leaves a page that is reloading itself alone — a second navigation would cancel it (2026-09-28)", async () => {
    const navigate = vi.fn(async () => undefined);
    const clients = clientsWith({ "tab-1": { url: "https://app.test/", navigate } });
    // The page's own reload reaches the worker during the grace period.
    const takeover = createTakeoverReload(clients, {
      activated: async () => undefined,
      sleep: async () => takeover.navigationSeen(),
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
    takeover.navigationSeen();
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
    takeover.asked(null);
    expect(await takeover.finish()).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});
