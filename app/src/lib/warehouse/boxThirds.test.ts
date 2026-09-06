import { describe, expect, it } from "vitest";
import type { StoragePackage } from "../storage";
import { groupByThird, hasThirds, thirdOf } from "./boxThirds";

const pkg = (id: string, area: string | null): StoragePackage => ({
  id, serial: `PKG-${id}`, short_code: null, status: "stored", project_id: "j1", category: null,
  note: null, delivery_id: null, container_id: "c7", bound_at: null, bound_by: null,
  created_at: "2026-08-10T00:00:00Z", area,
});

describe("which third a pointer lands in", () => {
  it("reads the plain thirds and the finer left/right zones alike", () => {
    expect(thirdOf("front")).toBe("front");
    expect(thirdOf("back-left")).toBe("back");
    expect(thirdOf("Middle-Right")).toBe("middle");
  });
  it("a compass point is not a third", () => {
    expect(thirdOf("northeast")).toBeNull();
    expect(thirdOf(null)).toBeNull();
  });
});

describe("grouping a box's contents", () => {
  it("puts every stored package in one column, the unpointed in their own row", () => {
    const g = groupByThird([pkg("a", "front"), pkg("b", "back-right"), pkg("c", null), pkg("d", "middle")]);
    expect(g.front.map((p) => p.id)).toEqual(["a"]);
    expect(g.middle.map((p) => p.id)).toEqual(["d"]);
    expect(g.back.map((p) => p.id)).toEqual(["b"]);
    expect(g.unplaced.map((p) => p.id)).toEqual(["c"]);
  });
});

describe("which boxes have a door end", () => {
  it("everything that moves; the building keeps its compass", () => {
    expect(hasThirds("conex")).toBe(true);
    expect(hasThirds(undefined)).toBe(true);
    expect(hasThirds("crate")).toBe(true);
    expect(hasThirds("building")).toBe(false);
  });
});
