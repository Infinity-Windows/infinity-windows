import { describe, expect, it } from "vitest";
import { isProvisional, realCatalogTypes } from "./catalogTypes";

const types = [
  { id: "1", type_code: "SH3252", provisional: false },
  { id: "2", type_code: "MARK1", provisional: true },
  { id: "3", type_code: "SL7248" },
];

describe("keeping planset leftovers out of the catalog", () => {
  it("spots a provisional row", () => {
    expect(isProvisional({ provisional: true })).toBe(true);
    expect(isProvisional({ provisional: false })).toBe(false);
    expect(isProvisional({})).toBe(false);
  });

  it("hides them from browsing without deleting anything", () => {
    expect(realCatalogTypes(types).map((t) => t.id)).toEqual(["1", "3"]);
  });

  it("still shows one that is already assigned, so nothing looks blank", () => {
    expect(realCatalogTypes(types, "2").map((t) => t.id)).toEqual(["1", "2", "3"]);
  });
});
