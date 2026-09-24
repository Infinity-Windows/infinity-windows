import { describe, expect, it } from "vitest";
import { stableId } from "./stableId";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("stableId", () => {
  it("gives the same id for the same seed, every time", async () => {
    const a = await stableId("client-key-1:media:0");
    const b = await stableId("client-key-1:media:0");
    expect(a).toBe(b);
  });

  it("is shaped like the ids the server's uuid column accepts", async () => {
    expect(await stableId("anything")).toMatch(UUID);
  });

  it("tells two media items of one install apart", async () => {
    expect(await stableId("key:media:0")).not.toBe(await stableId("key:media:1"));
  });

  it("still answers, and still deterministically, without crypto.subtle", async () => {
    // A plain-http webview: `crypto.subtle` is undefined there, and the
    // migration must not throw on the one phone that needs it most.
    const real = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { subtle: undefined },
    });
    try {
      const a = await stableId("seed");
      const b = await stableId("seed");
      expect(a).toBe(b);
      expect(a).toMatch(UUID);
      expect(a).not.toBe(await stableId("other"));
    } finally {
      Object.defineProperty(globalThis, "crypto", { configurable: true, value: real });
    }
  });
});
