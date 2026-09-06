import { describe, expect, it } from "vitest";
import {
  MAX_PLANSET_ENTRIES,
  hasPlansetBytes,
  memoryPlansetBlobStore,
  plansetBlobKey,
  readPlansetBytes,
  writePlansetBytes,
} from "./plansetBlobCache";

const bytes = (n: number) => new ArrayBuffer(n);

describe("plansetBlobCache", () => {
  it("keys on the planset AND the path, so a re-uploaded sheet is a new entry", () => {
    expect(plansetBlobKey("p1", "a/b.pdf")).not.toBe(plansetBlobKey("p1", "a/c.pdf"));
    expect(plansetBlobKey("p1", "a/b.pdf")).not.toBe(plansetBlobKey("p2", "a/b.pdf"));
  });

  it("round-trips bytes and reports presence", async () => {
    const s = memoryPlansetBlobStore();
    const k = plansetBlobKey("p1", "b.pdf");
    expect(await hasPlansetBytes(k, s)).toBe(false);
    expect(await readPlansetBytes(k, s)).toBeNull();
    await writePlansetBytes(k, "p1", bytes(10), s);
    expect(await hasPlansetBytes(k, s)).toBe(true);
    expect((await readPlansetBytes(k, s))?.byteLength).toBe(10);
  });

  it("drops the least-recently-used sheets past the entry cap", async () => {
    const s = memoryPlansetBlobStore();
    for (let i = 0; i < MAX_PLANSET_ENTRIES + 3; i++) {
      await writePlansetBytes(`p${i}:x.pdf`, `p${i}`, bytes(1), s, 1000 + i);
    }
    const rows = await s.getAll();
    expect(rows.length).toBe(MAX_PLANSET_ENTRIES);
    // The three oldest went.
    expect(rows.find((r) => r.key === "p0:x.pdf")).toBeUndefined();
    expect(rows.find((r) => r.key === "p2:x.pdf")).toBeUndefined();
    expect(rows.find((r) => r.key === "p3:x.pdf")).toBeDefined();
  });

  it("ignores empty bytes and a missing store", async () => {
    const s = memoryPlansetBlobStore();
    await writePlansetBytes("k", "p", bytes(0), s);
    expect(await s.getAll()).toEqual([]);
    await expect(writePlansetBytes("k", "p", bytes(1), null)).resolves.toBeUndefined();
    expect(await readPlansetBytes("k", null)).toBeNull();
    expect(await hasPlansetBytes("k", null)).toBe(false);
  });

  it("a store that throws reads as empty and never breaks a write", async () => {
    const bad = {
      get: async () => { throw new Error("quota"); },
      put: async () => { throw new Error("quota"); },
      getAll: async () => { throw new Error("quota"); },
      delete: async () => { throw new Error("quota"); },
    };
    expect(await readPlansetBytes("k", bad)).toBeNull();
    await expect(writePlansetBytes("k", "p", bytes(1), bad)).resolves.toBeUndefined();
  });
});
