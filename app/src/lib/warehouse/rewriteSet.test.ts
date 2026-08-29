import { describe, expect, it } from "vitest";
import { groupExistingPackages, planRewrite, realityLine, type OldGroup } from "./rewriteSet";
import type { StoragePackage } from "../storage";

type Lite = Pick<StoragePackage, "status" | "part_type" | "piece_count">;

const pkg = (over: Partial<Lite>): Lite => ({
  status: "received",
  part_type: null,
  piece_count: null,
  ...over,
});

describe("groupExistingPackages", () => {
  it("splits arrived from expected, package rows counted by row, crate_pool by piece", () => {
    const groups = groupExistingPackages([
      pkg({ status: "received", part_type: "frame" }),
      pkg({ status: "stored", part_type: "frame" }),
      pkg({ status: "minted", part_type: "frame" }),
      pkg({ status: "minted", part_type: "glass", piece_count: 12 }),
      pkg({ status: "received", part_type: "glass", piece_count: 8 }),
      pkg({ status: "received", part_type: "crate" }), // sealed crate box — not a set line
    ]);
    expect(groups.size).toBe(2);
    expect(groups.get("package:frame")).toEqual({
      partType: "frame",
      packaging: "package",
      arrived: 2,
      expected: 1,
    });
    expect(groups.get("crate_pool:glass")).toEqual({
      partType: "glass",
      packaging: "crate_pool",
      arrived: 8,
      expected: 12,
    });
  });

  it("groups the untyped 'what is it?' rows on their own", () => {
    const groups = groupExistingPackages([pkg({ status: "minted", part_type: null })]);
    expect(groups.get("package:")).toMatchObject({ partType: null, expected: 1 });
  });
});

describe("planRewrite — grow", () => {
  it("mints the shortfall when a line grows past its expected count", () => {
    const old = new Map<string, OldGroup>([
      ["package:frame", { partType: "frame", packaging: "package", arrived: 1, expected: 1 }],
    ]);
    const plan = planRewrite(old, [{ partType: "frame", packaging: "package", count: 4 }]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error("expected ok");
    expect(plan.actions).toEqual([
      { key: "package:frame", partType: "frame", packaging: "package", arrivedCount: 1, toCount: 4, mint: 2, release: 0 },
    ]);
  });

  it("grows a line from nothing at all", () => {
    const plan = planRewrite(new Map(), [{ partType: "hardware", packaging: "package", count: 3 }]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error("expected ok");
    expect(plan.actions).toEqual([
      { key: "package:hardware", partType: "hardware", packaging: "package", arrivedCount: 0, toCount: 3, mint: 3, release: 0 },
    ]);
  });
});

describe("planRewrite — shrink, expected-only", () => {
  it("releases only the never-arrived surplus, arrived material untouched", () => {
    const old = new Map<string, OldGroup>([
      ["package:frame", { partType: "frame", packaging: "package", arrived: 2, expected: 3 }],
    ]);
    const plan = planRewrite(old, [{ partType: "frame", packaging: "package", count: 3 }]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error("expected ok");
    expect(plan.actions[0]).toMatchObject({ arrivedCount: 2, toCount: 3, mint: 0, release: 2 });
  });
});

describe("planRewrite — shrink below arrived refuses", () => {
  it("refuses atomically and names the exact numbers", () => {
    const old = new Map<string, OldGroup>([
      ["package:frame", { partType: "frame", packaging: "package", arrived: 6, expected: 0 }],
    ]);
    const plan = planRewrite(old, [{ partType: "frame", packaging: "package", count: 4 }]);
    expect(plan).toEqual({
      ok: false,
      reason:
        "6 frame already arrived — the new plan only holds 4. Un-arrive or delete pieces first, so nothing real disappears.",
    });
  });

  it("names pieces, not packages, for a crate_pool line", () => {
    const old = new Map<string, OldGroup>([
      ["crate_pool:glass", { partType: "glass", packaging: "crate_pool", arrived: 5, expected: 0 }],
    ]);
    const plan = planRewrite(old, [{ partType: "glass", packaging: "crate_pool", count: 2 }]);
    expect(plan).toEqual({
      ok: false,
      reason:
        "5 glass pieces already arrived — the new plan only holds 2. Un-arrive or delete pieces first, so nothing real disappears.",
    });
  });
});

describe("planRewrite — the Mad Moose case: packages become pieces in a crate", () => {
  it("splits one untyped 16-package line into 4 frame packages and 12 pieces of glass, nothing arrived yet", () => {
    // Manifest said mark #8 was 16 packages, all still on the way. The
    // truth on the truck was 4 frame packages and 12 pieces of glass in
    // one crate — a straight redeclaration with nothing real to protect.
    const old = new Map<string, OldGroup>([
      ["package:", { partType: null, packaging: "package", arrived: 0, expected: 16 }],
    ]);
    const plan = planRewrite(old, [
      { partType: "frame", packaging: "package", count: 4 },
      { partType: "glass", packaging: "crate_pool", count: 12 },
    ]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error("expected ok");
    const byKey = new Map(plan.actions.map((a) => [a.key, a]));
    expect(byKey.get("package:")).toMatchObject({ toCount: 0, mint: 0, release: 16 });
    expect(byKey.get("package:frame")).toMatchObject({ toCount: 4, mint: 4, release: 0 });
    expect(byKey.get("crate_pool:glass")).toMatchObject({ toCount: 12, mint: 12, release: 0 });
  });

  it("re-fits already-arrived frame packages into the new declaration when a line is unambiguously renamed", () => {
    // A subtler version: 2 of the "misc" packages already arrived before
    // anyone noticed the manifest was wrong. The new plan drops "misc"
    // entirely and introduces "frame" as the only new package line — the
    // arrived misc pieces clearly become frame.
    const old = new Map<string, OldGroup>([
      ["package:misc", { partType: "misc", packaging: "package", arrived: 2, expected: 2 }],
    ]);
    const plan = planRewrite(old, [{ partType: "frame", packaging: "package", count: 4 }]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error("expected ok");
    const frame = plan.actions.find((a) => a.key === "package:frame")!;
    // 2 already-arrived misc pieces re-fit as frame; 2 more get minted to
    // reach the declared 4. The old misc line's 2 never-arrived
    // placeholders are released, never re-fit (they weren't real yet).
    expect(frame).toMatchObject({ arrivedCount: 2, toCount: 4, mint: 2, release: 0 });
    expect(plan.actions.find((a) => a.key === "package:misc")).toMatchObject({
      arrivedCount: 0,
      toCount: 0,
      mint: 0,
      release: 2,
    });
  });
});

describe("planRewrite — type-change ambiguity refuses", () => {
  it("refuses when a removed line's arrived material could fit more than one new line", () => {
    const old = new Map<string, OldGroup>([
      ["package:misc", { partType: "misc", packaging: "package", arrived: 2, expected: 0 }],
    ]);
    const plan = planRewrite(old, [
      { partType: "frame", packaging: "package", count: 4 },
      { partType: "glass", packaging: "package", count: 4 },
    ]);
    expect(plan).toEqual({
      ok: false,
      reason:
        "Some arrived material doesn't clearly fit the new plan: 2 misc packages. Retype it one at a time first.",
    });
  });

  it("refuses when a removed line's arrived material has nowhere to go at all", () => {
    const old = new Map<string, OldGroup>([
      ["package:misc", { partType: "misc", packaging: "package", arrived: 2, expected: 0 }],
    ]);
    // The new declaration is empty — "misc" vanished and nothing new
    // replaces it, so its 2 arrived pieces have no candidate at all.
    const plan = planRewrite(old, []);
    expect(plan).toEqual({
      ok: false,
      reason:
        "Some arrived material doesn't clearly fit the new plan: 2 misc packages. Retype it one at a time first.",
    });
  });

  it("refuses when two different removed lines both carry arrived material", () => {
    const old = new Map<string, OldGroup>([
      ["package:misc", { partType: "misc", packaging: "package", arrived: 2, expected: 0 }],
      ["package:odd", { partType: "odd", packaging: "package", arrived: 1, expected: 0 }],
    ]);
    const plan = planRewrite(old, [{ partType: "frame", packaging: "package", count: 4 }]);
    expect(plan).toEqual({
      ok: false,
      reason:
        "Some arrived material doesn't clearly fit the new plan: 2 misc packages, 1 odd package. Retype it one at a time first.",
    });
  });

  it("does not require an exact count match — a bigger new line still absorbs it", () => {
    const old = new Map<string, OldGroup>([
      ["crate_pool:misc", { partType: "misc", packaging: "crate_pool", arrived: 3, expected: 0 }],
    ]);
    const plan = planRewrite(old, [{ partType: "glass", packaging: "crate_pool", count: 10 }]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error("expected ok");
    expect(plan.actions.find((a) => a.key === "crate_pool:glass")).toMatchObject({
      arrivedCount: 3,
      toCount: 10,
      mint: 7,
    });
  });
});

describe("planRewrite — atomicity", () => {
  it("a refusal describes no partial action at all", () => {
    const old = new Map<string, OldGroup>([
      ["package:frame", { partType: "frame", packaging: "package", arrived: 6, expected: 2 }],
      ["package:glass", { partType: "glass", packaging: "package", arrived: 1, expected: 0 }],
    ]);
    const plan = planRewrite(old, [
      { partType: "frame", packaging: "package", count: 4 }, // this line refuses…
      { partType: "glass", packaging: "package", count: 5 }, // …though this one alone would be fine
    ]);
    expect(plan.ok).toBe(false);
    // A refused plan is exactly { ok: false, reason }: no `actions` key
    // ships alongside it, so a caller cannot accidentally apply half a
    // plan — there is no half to find. The RPC's own transaction is the
    // authoritative guarantee; this is the client's mirror of it.
    expect(plan).not.toHaveProperty("actions");
  });
});

describe("realityLine", () => {
  it("reads the plain 'N of M arrived' preview against a declared line", () => {
    const old = new Map<string, OldGroup>([
      ["package:frame", { partType: "frame", packaging: "package", arrived: 2, expected: 2 }],
    ]);
    expect(realityLine({ partType: "frame", packaging: "package", count: 4 }, old)).toEqual({
      label: "frame",
      arrived: 2,
      count: 4,
    });
  });

  it("a brand-new line reads honestly as 0 arrived", () => {
    expect(realityLine({ partType: "screen", packaging: "package", count: 2 }, new Map())).toEqual({
      label: "screen",
      arrived: 0,
      count: 2,
    });
  });
});
