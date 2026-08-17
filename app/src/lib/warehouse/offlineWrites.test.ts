// The one rule that matters: "no signal" queues, a REAL rejection does not.
// Queueing a genuine error would bury it in the dead-letter and the person
// standing in the conex would never learn they were wrong.

import { beforeEach, describe, expect, it, vi } from "vitest";

const storePackages = vi.fn();
const checkoutPackages = vi.fn();
const takeSupply = vi.fn();
const enqueueStorePackages = vi.fn(async () => "entry-1");
const enqueueCheckoutPackages = vi.fn(async () => "entry-2");
const enqueueTakeSupply = vi.fn(async () => "entry-3");

vi.mock("../storage", () => ({ storePackages, checkoutPackages }));
vi.mock("../ops", () => ({ takeSupply }));
vi.mock("../offline/outbox", () => ({
  enqueueStorePackages,
  enqueueCheckoutPackages,
  enqueueTakeSupply,
}));

const {
  checkoutPackagesOffline,
  storePackagesOffline,
  takeSupplyOffline,
  writeToast,
} = await import("./offlineWrites");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("with signal", () => {
  it("goes straight to the server and never queues", async () => {
    storePackages.mockResolvedValue(3);
    const r = await storePackagesOffline(["a", "b", "c"], "conex");
    expect(r).toEqual({ count: 3, queued: false });
    expect(enqueueStorePackages).not.toHaveBeenCalled();
  });
});

describe("no signal", () => {
  it("queues a check-in and reports the work as done", async () => {
    storePackages.mockRejectedValue(new TypeError("Failed to fetch"));
    const r = await storePackagesOffline(["a", "b"], "conex");
    expect(r).toEqual({ count: 2, queued: true });
    expect(enqueueStorePackages).toHaveBeenCalledWith(["a", "b"], "conex");
  });

  it("queues a check-out with its reason and job", async () => {
    checkoutPackages.mockRejectedValue(new Error("Network error"));
    const r = await checkoutPackagesOffline(["a"], "install day", "job-1");
    expect(r.queued).toBe(true);
    expect(enqueueCheckoutPackages).toHaveBeenCalledWith({
      packageIds: ["a"],
      reason: "install day",
      projectId: "job-1",
    });
  });

  it("queues a supply take", async () => {
    takeSupply.mockRejectedValue(new Error("failed to fetch"));
    const r = await takeSupplyOffline({ supplyId: "s", projectId: "j", qty: 3 });
    expect(r).toEqual({ count: 3, queued: true });
    expect(enqueueTakeSupply).toHaveBeenCalled();
  });
});

describe("a real rejection is NOT queued", () => {
  it("surfaces 'container not found' instead of burying it", async () => {
    storePackages.mockRejectedValue(new Error("container not found or inactive"));
    await expect(storePackagesOffline(["a"], "gone")).rejects.toThrow(
      "container not found",
    );
    expect(enqueueStorePackages).not.toHaveBeenCalled();
  });

  it("surfaces a missing reason", async () => {
    checkoutPackages.mockRejectedValue(
      new Error("pick a reason for taking the material"),
    );
    await expect(checkoutPackagesOffline(["a"], "", "job-1")).rejects.toThrow();
    expect(enqueueCheckoutPackages).not.toHaveBeenCalled();
  });

  it("surfaces a permission failure rather than retrying it forever", async () => {
    takeSupply.mockRejectedValue(new Error("permission denied for supplies"));
    await expect(
      takeSupplyOffline({ supplyId: "s", projectId: "j", qty: 1 }),
    ).rejects.toThrow("permission denied");
    expect(enqueueTakeSupply).not.toHaveBeenCalled();
  });
});

describe("what the person is told", () => {
  it("says plainly when it is only on the phone", () => {
    expect(writeToast({ count: 2, queued: true }, "2 packages checked in")).toBe(
      "2 packages checked in — not sent yet, no signal in here.",
    );
  });

  it("says nothing extra when it landed", () => {
    expect(writeToast({ count: 2, queued: false }, "2 packages checked in")).toBe(
      "2 packages checked in",
    );
  });
});
