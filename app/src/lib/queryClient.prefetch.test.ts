import { describe, expect, it, vi } from "vitest";

/**
 * The warehouse pre-load is fired and forgotten — `void prefetchWarehousePack()`
 * at sign-in, with no `.catch()` on it, because the function's own contract
 * says it never rejects. That contract has to be true of every line in it, not
 * just the reads: the code it needs arrives as its own chunk over the network,
 * and a phone on one bar can fail to fetch that chunk exactly as easily as it
 * can fail a read. If those loads sit outside the guard, the first thing a bad
 * connection does at sign-in is throw a rejection nobody is listening for.
 */
vi.mock("./storage", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

const { prefetchWarehousePack } = await import("./queryClient");

describe("prefetchWarehousePack", () => {
  it("settles quietly when the code it needs cannot be fetched", async () => {
    await expect(prefetchWarehousePack()).resolves.toBeUndefined();
  });
});
