import { describe, expect, it } from "vitest";
import {
  BUILD_FACTS_PATCH_KEYS,
  EXTERIOR_FINISH_KEYS,
  FASTENER_TYPE_KEYS,
  FLASHING_SYSTEM_KEYS,
  MAX_EXTERIOR_LINES,
  SET_DEPTH_KEYS,
  WHO_KEYS,
  isBlankExteriorLine,
  normalizeExteriorLines,
  openGreenLightItems,
  pickListLabel,
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
    const sorted = sortOpenFirst([
      item({ item_key: "a", answered: true }),
      item({ item_key: "b", answered: false }),
      item({ item_key: "c", answered: true }),
      item({ item_key: "d", answered: false }),
    ]);
    expect(sorted.map((i) => i.item_key)).toEqual(["b", "d", "a", "c"]);
  });

  it("keeps each half in the server's own order (stable sort)", () => {
    const sorted = sortOpenFirst([
      item({ item_key: "plan_set", answered: true }),
      item({ item_key: "build_facts", answered: true }),
      item({ item_key: "materials_eta", answered: false }),
      item({ item_key: "gc_site", answered: false }),
    ]);
    expect(sorted.map((i) => i.item_key)).toEqual([
      "materials_eta",
      "gc_site",
      "plan_set",
      "build_facts",
    ]);
  });

  it("does not mutate the input array", () => {
    const input = [item({ item_key: "a", answered: true }), item({ item_key: "b" })];
    sortOpenFirst(input);
    expect(input.map((i) => i.item_key)).toEqual(["a", "b"]);
  });
});

describe("openGreenLightItems", () => {
  it("keeps only the unanswered rows", () => {
    const open = openGreenLightItems([
      item({ item_key: "a", answered: true }),
      item({ item_key: "b", answered: false }),
    ]);
    expect(open.map((i) => i.item_key)).toEqual(["b"]);
  });

  it("is empty when everything is answered", () => {
    expect(openGreenLightItems([item({ answered: true })])).toEqual([]);
  });
});

describe("seedFromGcCheckin", () => {
  it("is empty with no check-in on file", () => {
    expect(seedFromGcCheckin(null)).toEqual({});
  });

  it("turns the GC's set preference and exterior material into line one, plus the contact name", () => {
    const seed = seedFromGcCheckin({
      set_preference: "outset",
      exterior_material: "stucco",
      contact_name: "Dale",
    });
    expect(seed).toEqual({
      exterior_lines: [
        { exterior_finish: null, exterior_note: "stucco", set_depth: "outset", set_depth_inches: null },
      ],
      gc_contact_name: "Dale",
    });
  });

  it("leaves set depth open on the seeded line when the GC's preference is unknown", () => {
    const seed = seedFromGcCheckin({
      set_preference: "unknown",
      exterior_material: "brick",
      contact_name: null,
    });
    expect(seed.exterior_lines).toEqual([
      { exterior_finish: null, exterior_note: "brick", set_depth: null, set_depth_inches: null },
    ]);
    expect(seed.gc_contact_name).toBeUndefined();
  });

  it("seeds no line at all when the GC said nothing about the outside or the set", () => {
    const seed = seedFromGcCheckin({
      set_preference: "unknown",
      exterior_material: "   ",
      contact_name: "  ",
    });
    expect(seed).toEqual({});
  });
});

describe("normalizeExteriorLines", () => {
  it("reads a well-formed server list as-is", () => {
    const lines = normalizeExteriorLines([
      { exterior_finish: "brick", exterior_note: null, set_depth: "outset", set_depth_inches: 1 },
      { exterior_finish: "stucco", exterior_note: "sides", set_depth: "inset", set_depth_inches: 1.25 },
    ]);
    expect(lines).toEqual([
      { exterior_finish: "brick", exterior_note: null, set_depth: "outset", set_depth_inches: 1 },
      { exterior_finish: "stucco", exterior_note: "sides", set_depth: "inset", set_depth_inches: 1.25 },
    ]);
  });

  it("is empty for anything that is not a list", () => {
    expect(normalizeExteriorLines(null)).toEqual([]);
    expect(normalizeExteriorLines("brick")).toEqual([]);
    expect(normalizeExteriorLines({ exterior_finish: "brick" })).toEqual([]);
  });

  it("drops entries that are not objects and blanks values it does not recognise", () => {
    const lines = normalizeExteriorLines([
      "brick",
      null,
      { exterior_finish: "marble", set_depth: "sideways", set_depth_inches: "1.5", exterior_note: "" },
    ]);
    expect(lines).toEqual([
      { exterior_finish: null, exterior_note: null, set_depth: null, set_depth_inches: 1.5 },
    ]);
  });
});

describe("isBlankExteriorLine", () => {
  it("is true when nothing on the line is answered", () => {
    expect(
      isBlankExteriorLine({ exterior_finish: null, exterior_note: "  ", set_depth: null, set_depth_inches: null }),
    ).toBe(true);
  });

  it("is false as soon as one field is answered", () => {
    expect(
      isBlankExteriorLine({ exterior_finish: null, exterior_note: null, set_depth: null, set_depth_inches: 1 }),
    ).toBe(false);
  });
});

describe("pickListLabel", () => {
  it("uses what the foreman named when the answer is other", () => {
    expect(pickListLabel("Other", "other", " Tyvek FlexWrap ")).toBe("Tyvek FlexWrap");
  });

  it("falls back to the pick-list label when other has no name yet", () => {
    expect(pickListLabel("Other", "other", "   ")).toBe("Other");
    expect(pickListLabel("Other", "other", null)).toBe("Other");
  });

  it("ignores the custom name when the answer is a real pick-list value", () => {
    expect(pickListLabel("Butyl tape", "butyl_tape", "leftover text")).toBe("Butyl tape");
  });
});

describe("pick-list catalog keys", () => {
  const langs: Lang[] = ["en", "es"];
  const allMaps = [
    EXTERIOR_FINISH_KEYS,
    SET_DEPTH_KEYS,
    FLASHING_SYSTEM_KEYS,
    FASTENER_TYPE_KEYS,
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

  it("carries the thirteen writable columns the migration whitelists", () => {
    expect([...BUILD_FACTS_PATCH_KEYS].sort()).toEqual(
      [
        "exterior_lines",
        "flashing_system",
        "flashing_system_other",
        "flashing_note",
        "fastener_type",
        "fastener_type_other",
        "fastener_length_in",
        "fastener_spacing_in",
        "fastener_note",
        "site_rules",
        "gc_contact_name",
        "gc_contact_phone",
        "elevation_notes",
      ].sort(),
    );
  });

  it("matches the SQL whitelist and the line cap in the migration, word for word", () => {
    // The SQL function is the copy that runs; this reads it as text so the
    // two lists cannot drift apart without a red test.
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { resolve } = require("node:path") as typeof import("node:path");
    const sql = readFileSync(
      resolve(__dirname, "../../../../supabase/migrations/20261002000000_job_facts_lines.sql"),
      "utf8",
    );
    for (const key of BUILD_FACTS_PATCH_KEYS) {
      expect(sql, key).toContain(`'${key}'`);
    }
    expect(sql).toContain(`> ${MAX_EXTERIOR_LINES} then`);
    expect(sql).toContain(`jsonb_array_length(exterior_lines) <= ${MAX_EXTERIOR_LINES}`);
  });
});
