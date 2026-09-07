import { describe, expect, it } from "vitest";
import {
  BUILD_FACTS_PATCH_KEYS,
  EXTERIOR_FINISH_KEYS,
  FASTENER_TYPE_KEYS,
  FLASHING_SYSTEM_KEYS,
  SET_DEPTH_KEYS,
  SILL_PAN_KEYS,
  SILL_PAN_TYPE_KEYS,
  WHO_KEYS,
  openGreenLightItems,
  seedFromGcCheckin,
  sortOpenFirst,
  type GreenLightItem,
} from "./buildFacts";
import { CATALOG, translate, type Lang } from "../i18n";

function item(over: Partial<GreenLightItem> = {}): GreenLightItem {
  return {
    item_key: "plan_set",
    label_en: "A planset is uploaded and its extraction has finished",
    answered: false,
    who: "supervisor",
    ...over,
  };
}

describe("sortOpenFirst", () => {
  it("puts unanswered items ahead of answered ones", () => {
    const items = [
      item({ item_key: "a", answered: true }),
      item({ item_key: "b", answered: false }),
      item({ item_key: "c", answered: true }),
      item({ item_key: "d", answered: false }),
    ];
    expect(sortOpenFirst(items).map((i) => i.item_key)).toEqual(["b", "d", "a", "c"]);
  });

  it("keeps each half in the server's own order (stable sort)", () => {
    const items = [
      item({ item_key: "plan_set", answered: false }),
      item({ item_key: "build_facts", answered: false }),
      item({ item_key: "materials_eta", answered: true }),
    ];
    expect(sortOpenFirst(items).map((i) => i.item_key)).toEqual([
      "plan_set",
      "build_facts",
      "materials_eta",
    ]);
  });

  it("does not mutate the input array", () => {
    const items = [item({ item_key: "a", answered: true }), item({ item_key: "b", answered: false })];
    const sorted = sortOpenFirst(items);
    expect(sorted).not.toBe(items);
    expect(items.map((i) => i.item_key)).toEqual(["a", "b"]);
  });

  it("handles an all-answered and an all-open list without reordering", () => {
    const allAnswered = [item({ item_key: "a", answered: true }), item({ item_key: "b", answered: true })];
    expect(sortOpenFirst(allAnswered).map((i) => i.item_key)).toEqual(["a", "b"]);
    const allOpen = [item({ item_key: "a", answered: false }), item({ item_key: "b", answered: false })];
    expect(sortOpenFirst(allOpen).map((i) => i.item_key)).toEqual(["a", "b"]);
  });
});

describe("openGreenLightItems", () => {
  it("keeps only the unanswered rows", () => {
    const items = [
      item({ item_key: "a", answered: true }),
      item({ item_key: "b", answered: false }),
    ];
    expect(openGreenLightItems(items).map((i) => i.item_key)).toEqual(["b"]);
  });

  it("is empty when everything is answered", () => {
    const items = [item({ answered: true }), item({ item_key: "b", answered: true })];
    expect(openGreenLightItems(items)).toEqual([]);
  });
});

describe("seedFromGcCheckin", () => {
  it("is empty with no check-in on file", () => {
    expect(seedFromGcCheckin(null)).toEqual({});
  });

  it("seeds set_depth, exterior_note and gc_contact_name from a full check-in", () => {
    expect(
      seedFromGcCheckin({
        set_preference: "outset",
        exterior_material: "Stucco, sand finish",
        contact_name: "Dave",
      }),
    ).toEqual({
      set_depth: "outset",
      exterior_note: "Stucco, sand finish",
      gc_contact_name: "Dave",
    });
  });

  it("leaves set_depth unseeded when the GC's preference is unknown", () => {
    expect(
      seedFromGcCheckin({
        set_preference: "unknown",
        exterior_material: "Lap siding",
        contact_name: "Dave",
      }),
    ).toEqual({ exterior_note: "Lap siding", gc_contact_name: "Dave" });
  });

  it("skips blank strings rather than seeding empty values", () => {
    expect(
      seedFromGcCheckin({ set_preference: "inset", exterior_material: "   ", contact_name: "" }),
    ).toEqual({ set_depth: "inset" });
  });
});

describe("pick-list catalog keys", () => {
  const langs: Lang[] = ["en", "es"];
  const allMaps = [
    EXTERIOR_FINISH_KEYS,
    SET_DEPTH_KEYS,
    FLASHING_SYSTEM_KEYS,
    FASTENER_TYPE_KEYS,
    SILL_PAN_KEYS,
    SILL_PAN_TYPE_KEYS,
    WHO_KEYS,
  ];

  it("every pick-list value has a real catalog entry in both languages", () => {
    for (const map of allMaps) {
      for (const key of Object.values(map)) {
        for (const lang of langs) {
          const text = translate(CATALOG, lang, key);
          expect(text, `${key} (${lang})`).not.toBe("");
        }
      }
    }
  });
});

describe("BUILD_FACTS_PATCH_KEYS", () => {
  it("has no duplicate column names", () => {
    expect(new Set(BUILD_FACTS_PATCH_KEYS).size).toBe(BUILD_FACTS_PATCH_KEYS.length);
  });

  it("carries the nineteen writable columns the migration whitelists", () => {
    expect([...BUILD_FACTS_PATCH_KEYS].sort()).toEqual(
      [
        "exterior_finish",
        "exterior_note",
        "set_depth",
        "set_depth_inches",
        "flashing_system",
        "flashing_note",
        "fastener_type",
        "fastener_length_in",
        "fastener_spacing_in",
        "fastener_note",
        "sill_pan",
        "sill_pan_type",
        "site_rules",
        "gc_contact_name",
        "gc_contact_phone",
        "note_north",
        "note_south",
        "note_east",
        "note_west",
      ].sort(),
    );
  });
});
