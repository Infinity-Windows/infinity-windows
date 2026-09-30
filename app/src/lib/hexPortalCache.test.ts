// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({ user: "owner-a" as string | null, changed: [] as Array<() => void> }));
vi.mock("./signedIn", () => ({
  signedInUserId: () => identity.user,
  subscribeSignedIn: (fn: () => void) => { identity.changed.push(fn); return () => {}; },
}));

import { clearPortalGuidanceCache, GUIDANCE_CACHE_MAX_AGE_MS, readOfflineGuidance, rememberVerifiedGuidance } from "./hexPortalCache";

const project = "6f718a92-6a20-42b8-91cf-16e60c3a91cd";
const lesson = {
  id: "42b054c6-6324-46fa-9244-4893500d1a2a", revision: 3,
  title: "Flashing at a sill", answer: "Check the approved detail.",
  applicability: "Unit W-14", evidence: "Reviewed photo", reviewBy: "2026-10-10",
};

beforeEach(() => {
  identity.user = "owner-a";
  clearPortalGuidanceCache();
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
});

describe("HexCore reviewed-guidance phone copy", () => {
  it("stores only guidance actually returned live, then labels the exact offline query and revision", async () => {
    await rememberVerifiedGuidance("owner-a", project, "How do I flash W-14?", [lesson], 1000);
    expect(await readOfflineGuidance("owner-a", project, "How do I flash W-14?", 1001)).toBeNull();
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    expect(await readOfflineGuidance("owner-a", project, "How do I flash W-14?", 1001)).toEqual({ items: [lesson], checkedAt: 1000 });
    expect(await readOfflineGuidance("owner-a", project, "How do I flash W-15?", 1001)).toBeNull();
  });

  it("expires within an hour and clears everything on reconnection", async () => {
    await rememberVerifiedGuidance("owner-a", project, "sill", [lesson], 1000);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    expect(await readOfflineGuidance("owner-a", project, "sill", 1000 + GUIDANCE_CACHE_MAX_AGE_MS + 1)).toBeNull();
    expect(await readOfflineGuidance("owner-a", project, "sill", 1001)).not.toBeNull();
    window.dispatchEvent(new Event("online"));
    expect(await readOfflineGuidance("owner-a", project, "sill", 1001)).toBeNull();
  });

  it("does not cross accounts or survive sign-out", async () => {
    await rememberVerifiedGuidance("owner-a", project, "sill", [lesson], 1000);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    identity.user = "crew-b";
    identity.changed.forEach((fn) => fn());
    expect(await readOfflineGuidance("crew-b", project, "sill", 1001)).toBeNull();
    identity.user = "owner-a";
    identity.changed.forEach((fn) => fn());
    expect(await readOfflineGuidance("owner-a", project, "sill", 1001)).toBeNull();
    identity.user = null;
    identity.changed.forEach((fn) => fn());
  });

  it("refuses malformed or oversized guidance", async () => {
    await rememberVerifiedGuidance("owner-a", project, "sill", [{ ...lesson, answer: "x".repeat(12_001) }], 1000);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    expect(await readOfflineGuidance("owner-a", project, "sill", 1001)).toBeNull();
  });
});
