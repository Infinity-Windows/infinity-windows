// Pure logic behind the S5 unit-sheet job-facts card (ADR-0011): which
// elevation note belongs to THIS unit, and which set-depth answer wins when
// the unit's own spec disagrees with the job's default.

import { describe, expect, it } from "vitest";
import {
  deriveUnitElevation,
  elevationNotesFor,
  formatSetDepthValue,
  hasAnyUnitFact,
  joinFactLine,
  resolveSetDepthLine,
  specInsetOutsetOf,
} from "./unitFactsCard";
import type { BuildFacts } from "./buildFacts";
import type { ElevationViewLike } from "./elevationViews";

function view(mark: string, viewName: string | null, overrides: Partial<ElevationViewLike> = {}): ElevationViewLike {
  return {
    mark_code: mark,
    page_number: 1,
    region_index: 0,
    view_name: viewName,
    planset_id: "planset-1",
    ...overrides,
  };
}

function emptyFacts(overrides: Partial<BuildFacts> = {}): BuildFacts {
  return {
    project_id: "project-1",
    exterior_finish: null,
    exterior_note: null,
    set_depth: null,
    set_depth_inches: null,
    flashing_system: null,
    flashing_note: null,
    fastener_type: null,
    fastener_length_in: null,
    fastener_spacing_in: null,
    fastener_note: null,
    sill_pan: null,
    sill_pan_type: null,
    site_rules: null,
    gc_contact_name: null,
    gc_contact_phone: null,
    note_north: null,
    note_south: null,
    note_east: null,
    note_west: null,
    updated_by: null,
    updated_at: null,
    ...overrides,
  };
}

describe("deriveUnitElevation", () => {
  it("reads the compass off the mark's elevation caption", () => {
    const views = [view("1", "FRONT ELEVATION - SOUTH")];
    expect(deriveUnitElevation("1", views)).toBe("south");
  });

  it("normalizes a chained opening code to its base mark", () => {
    const views = [view("1", "REAR ELEVATION - NORTH")];
    expect(deriveUnitElevation("1-2", views)).toBe("north");
  });

  it("is null when nothing names a compass side for this mark", () => {
    const views = [view("1", "FRONT PROPERTY VIEW"), view("2", "REAR ELEVATION - NORTH")];
    expect(deriveUnitElevation("1", views)).toBeNull();
  });

  it("is null with no opening code or no views", () => {
    expect(deriveUnitElevation(null, [])).toBeNull();
    expect(deriveUnitElevation("1", [])).toBeNull();
  });

  it("prefers a straight elevation with a compass bearing over a property view of the same wall", () => {
    const views = [
      view("9", "FRONT PROPERTY VIEW", { region_index: 0 }),
      view("9", "FRONT ELEVATION - SOUTH", { region_index: 1 }),
    ];
    expect(deriveUnitElevation("9", views)).toBe("south");
  });
});

describe("elevationNotesFor", () => {
  it("returns only the unit's own note when the elevation is known", () => {
    const facts = emptyFacts({ note_south: "Stucco patched here", note_north: "Ignore this one" });
    expect(elevationNotesFor(facts, "south")).toEqual([{ elevation: "south", note: "Stucco patched here" }]);
  });

  it("returns nothing when the known elevation's own note is blank, even if others are set", () => {
    const facts = emptyFacts({ note_north: "Has a note" });
    expect(elevationNotesFor(facts, "south")).toEqual([]);
  });

  it("returns every non-empty note, labelled, when the elevation can't be determined", () => {
    const facts = emptyFacts({ note_north: "N note", note_east: "  ", note_west: "W note" });
    expect(elevationNotesFor(facts, null)).toEqual([
      { elevation: "north", note: "N note" },
      { elevation: "west", note: "W note" },
    ]);
  });

  it("returns nothing when no elevation is known and every note is blank", () => {
    expect(elevationNotesFor(emptyFacts(), null)).toEqual([]);
  });
});

describe("resolveSetDepthLine", () => {
  it("is null when the job hasn't answered set depth, regardless of the spec", () => {
    expect(resolveSetDepthLine(null, "inset")).toBeNull();
  });

  it("shows the job's own value when the spec agrees", () => {
    expect(resolveSetDepthLine("outset", "outset")).toEqual({ value: "outset", disagrees: false });
  });

  it("shows the job's own value when the spec says nothing", () => {
    expect(resolveSetDepthLine("outset", null)).toEqual({ value: "outset", disagrees: false });
  });

  it("shows the spec's value and flags the disagreement when it differs", () => {
    expect(resolveSetDepthLine("inset", "outset")).toEqual({ value: "outset", disagrees: true });
  });

  it("does not disagree with itself when the job says unknown and the spec has a real call", () => {
    // "unknown" is a real answer distinct from "outset" — the spec's own
    // call is a genuine disagreement here, same as inset vs outset.
    expect(resolveSetDepthLine("unknown", "outset")).toEqual({ value: "outset", disagrees: true });
  });
});

describe("formatSetDepthValue", () => {
  it("appends the inch when one is on file", () => {
    expect(formatSetDepthValue("Outset", 1)).toBe('Outset 1"');
  });

  it("appends a fraction when the inch isn't whole", () => {
    expect(formatSetDepthValue("Inset", 0.5)).toBe('Inset 0½"');
  });

  it("is the bare label when no inch is recorded", () => {
    expect(formatSetDepthValue("Outset", null)).toBe("Outset");
  });
});

describe("specInsetOutsetOf", () => {
  it("reads a valid value", () => {
    expect(specInsetOutsetOf({ inset_outset: "inset" })).toBe("inset");
  });

  it("is null for anything else", () => {
    expect(specInsetOutsetOf(null)).toBeNull();
    expect(specInsetOutsetOf(undefined)).toBeNull();
    expect(specInsetOutsetOf({})).toBeNull();
    expect(specInsetOutsetOf({ inset_outset: "sideways" })).toBeNull();
  });
});

describe("joinFactLine", () => {
  it("joins non-empty parts with the card separator", () => {
    expect(joinFactLine(["Flange screw", "2½\"", "every 12\""])).toBe("Flange screw · 2½\" · every 12\"");
  });

  it("drops blank, null and undefined parts without doubling the separator", () => {
    expect(joinFactLine(["Stucco", null, "  ", undefined, "north side"])).toBe("Stucco · north side");
  });

  it("is null when nothing survives", () => {
    expect(joinFactLine([null, "  ", undefined])).toBeNull();
  });
});

describe("hasAnyUnitFact", () => {
  it("is false for a null row", () => {
    expect(hasAnyUnitFact(null, null)).toBe(false);
  });

  it("is false when every field and every reachable note is blank", () => {
    expect(hasAnyUnitFact(emptyFacts(), "south")).toBe(false);
  });

  it("is true when a plain field is answered", () => {
    expect(hasAnyUnitFact(emptyFacts({ exterior_finish: "stucco" }), null)).toBe(true);
  });

  it("is true when only an elevation note is answered", () => {
    expect(hasAnyUnitFact(emptyFacts({ note_east: "Watch the GC's fence line" }), "east")).toBe(true);
  });
});
