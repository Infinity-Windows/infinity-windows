import { describe, expect, it, vi } from "vitest";
import { createTakeoverReload, type TakeoverClient } from "./takeover";

function clientsWith(entries: Record<string, TakeoverClient | undefined>) {
  return { get: vi.fn(async (id: string) => entries[id]) };
}

describe("createTakeoverReload", () => {
  it("brings the page that asked for the switch onto the new build, at its own URL", async () => {
    const navigate = vi.fn(async () => undefined);
    const clients = clientsWith({ "tab-1": { url: "https://app.test/clock?x=1", navigate } });
    const takeover = createTakeoverReload(clients);
    takeover.asked({ id: "tab-1" });
    expect(await takeover.finish()).toBe(true);
    expect(navigate).toHaveBeenCalledWith("https://app.test/clock?x=1");
  });

  it("leaves every page alone when nobody asked — a natural activation after the app was closed", async () => {
    const clients = clientsWith({ "tab-1": { url: "https://app.test/", navigate: vi.fn() } });
    const takeover = createTakeoverReload(clients);
    expect(await takeover.finish()).toBe(false);
    expect(clients.get).not.toHaveBeenCalled();
  });

  it("consumes the ask: a second activation with no new ask reloads nobody", async () => {
    const navigate = vi.fn(async () => undefined);
    const takeover = createTakeoverReload(clientsWith({ "tab-1": { url: "https://app.test/", navigate } }));
    takeover.asked({ id: "tab-1" });
    await takeover.finish();
    expect(await takeover.finish()).toBe(false);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a page that has since closed", async () => {
    const takeover = createTakeoverReload(clientsWith({}));
    takeover.asked({ id: "gone" });
    expect(await takeover.finish()).toBe(false);
  });

  it("does nothing in a browser that will not let a worker navigate a page", async () => {
    const takeover = createTakeoverReload(clientsWith({ "tab-1": { url: "https://app.test/" } }));
    takeover.asked({ id: "tab-1" });
    expect(await takeover.finish()).toBe(false);
  });

  it("swallows a navigation the browser refuses, so activation never fails on it", async () => {
    const navigate = vi.fn(async () => {
      throw new Error("not allowed");
    });
    const takeover = createTakeoverReload(clientsWith({ "tab-1": { url: "https://app.test/", navigate } }));
    takeover.asked({ id: "tab-1" });
    await expect(takeover.finish()).resolves.toBe(false);
  });

  it("reads a message with no source as no ask", async () => {
    const navigate = vi.fn(async () => undefined);
    const takeover = createTakeoverReload(clientsWith({ "tab-1": { url: "https://app.test/", navigate } }));
    takeover.asked(null);
    expect(await takeover.finish()).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});
