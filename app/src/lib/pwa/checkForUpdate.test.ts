import { describe, expect, it, vi } from "vitest";
import { createHiddenClock, fetchPublishedVersion } from "./checkForUpdate";

describe("createHiddenClock", () => {
  it("reports nothing when the app has been visible all along", () => {
    const clock = createHiddenClock(() => 1_000);
    expect(clock.takeHiddenDuration()).toBeNull();
  });

  it("measures how long the app was out of sight", () => {
    let now = 1_000;
    const clock = createHiddenClock(() => now);
    clock.markHidden();
    now = 61_000;
    expect(clock.takeHiddenDuration()).toBe(60_000);
  });

  it("consumes the reading so a past absence cannot be reused", () => {
    // Without this, a phone that spent ten minutes in a pocket would keep
    // looking safe to reload for the rest of the session — and an update that
    // arrived while somebody was working would reload under their thumb.
    let now = 0;
    const clock = createHiddenClock(() => now);
    clock.markHidden();
    now = 600_000;
    expect(clock.takeHiddenDuration()).toBe(600_000);
    expect(clock.takeHiddenDuration()).toBeNull();
  });

  it("measures each absence separately", () => {
    let now = 0;
    const clock = createHiddenClock(() => now);
    clock.markHidden();
    now = 5_000;
    expect(clock.takeHiddenDuration()).toBe(5_000);
    clock.markHidden();
    now = 100_000;
    expect(clock.takeHiddenDuration()).toBe(95_000);
  });
});

describe("fetchPublishedVersion", () => {
  const ok = (body: unknown) =>
    vi.fn().mockResolvedValue({ ok: true, json: async () => body });

  it("returns the published build", async () => {
    const fetchImpl = ok({ buildId: "abc123", builtAt: "2026-07-29T00:00:00Z" });
    await expect(fetchPublishedVersion(fetchImpl as never)).resolves.toEqual({
      buildId: "abc123",
      builtAt: "2026-07-29T00:00:00Z",
    });
  });

  it("bypasses the HTTP cache", async () => {
    // GitHub Pages serves assets with a max-age, so without no-store the
    // browser would answer from its own cache and the app would never learn
    // about a new build — the exact staleness this exists to defeat.
    const fetchImpl = ok({ buildId: "abc123" });
    await fetchPublishedVersion(fetchImpl as never);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("version.json"),
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("reads a non-200 as unknown", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    await expect(fetchPublishedVersion(fetchImpl as never)).resolves.toBeNull();
  });

  it("reads a network failure as unknown rather than throwing", async () => {
    // Offline is normal on a job site.
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(fetchPublishedVersion(fetchImpl as never)).resolves.toBeNull();
  });

  it("reads an unparseable body as unknown", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error("not json");
      },
    });
    await expect(fetchPublishedVersion(fetchImpl as never)).resolves.toBeNull();
  });

  it("reads a body that is not a version file as unknown", async () => {
    const fetchImpl = ok({ nope: true });
    await expect(fetchPublishedVersion(fetchImpl as never)).resolves.toBeNull();
  });
});
