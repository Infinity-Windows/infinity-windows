// Pure logic behind the S5 unit-sheet job-facts card (ADR-0011): when the
// unit's own spec overrides the job's exterior situations, and when the card
// has anything to say at all.

import { describe, expect, it } from "vitest";
import {
  formatSetDepthValue,
  hasAnyUnitFact,
  joinFactLine,
  specInsetOutsetOf,
  specOverrideLine,
} from "./unitFactsCard";
import type { BuildFacts, ExteriorLine } from "./buildFacts";

function line(overrides: Partial<ExteriorLine> = {}): ExteriorLine {
  return {
    exterior_finish: null,
    exterior_note: null,
    set_depth: null,
    set_depth_inches: null,
    ...overrides,
  };
}

function emptyFacts(overrides: Partial<BuildFacts> = {}): BuildFacts {
  return {
    project_id: "project-1",
    exterior_lines: [],
    flashing_system: null,
    flashing_system_other: null,
    flashing_note: null,
    fastener_type: null,
    fastener_type_other: null,
    fastener_length_in: null,
    fastener_spacing_in: null,
    fastener_note: null,
    site_rules: null,
    gc_contact_name: null,
    gc_contact_phone: null,
    elevation_notes: null,
    updated_by: null,
    updated_at: null,
    ...overrides,
  };
}

const brickOutset = line({ exterior_finish: "brick", set_depth: "outset", set_depth_inches: 1 });
const stuccoInset = line({ exterior_finish: "stucco", set_depth: "inset", set_depth_inches: 1.25 });

describe("specOverrideLine", () => {
  it("is null when the unit's spec makes no call", () => {
    expect(specOverrideLine([brickOutset], null)).toBeNull();
  });

  it("is null when the job hasn't answered a set depth anywhere, regardless of the spec", () => {
    expect(specOverrideLine([], "inset")).toBeNull();
    expect(specOverrideLine([line({ exterior_finish: "brick" })], "inset")).toBeNull();
  });

  it("says nothing when some recorded situation already uses the spec's set depth", () => {
    expect(specOverrideLine([brickOutset, stuccoInset], "inset")).toBeNull();
    expect(specOverrideLine([brickOutset, stuccoInset], "outset")).toBeNull();
  });

  it("shows the spec's value when no recorded situation uses it", () => {
    expect(specOverrideLine([brickOutset], "inset")).toEqual({ value: "inset" });
  });

  it("treats a job that only says unknown as answered, so a real spec call wins over it", () => {
    expect(specOverrideLine([line({ set_depth: "unknown" })], "outset")).toEqual({ value: "outset" });
  });
});

describe("formatSetDepthValue", () => {
  it("appends the inch when one is on file", () => {
    expect(formatSetDepthValue("Outset", 1)).toBe('Outset 1"');
  });

  it("appends a fraction when the inch isn't whole", () => {
    expect(formatSetDepthValue("Inset", 1.25)).toBe('Inset 1¼"');
  });

  it("is the bare label when no inch is recorded", () => {
    expect(formatSetDepthValue("Outset", null)).toBe("Outset");
  });
});

describe("specInsetOutsetOf", () => {
  it("reads a valid value", () => {
    expect(specInsetOutsetOf({ inset_outset: "inset" })).toBe("inset");
    expect(specInsetOutsetOf({ inset_outset: "outset" })).toBe("outset");
  });

  it("is null for anything else", () => {
    expect(specInsetOutsetOf({ inset_outset: "flush" })).toBeNull();
    expect(specInsetOutsetOf({})).toBeNull();
    expect(specInsetOutsetOf(null)).toBeNull();
  });
});

describe("joinFactLine", () => {
  it("joins non-empty parts with the card separator", () => {
    expect(joinFactLine(["Flange screw", '2½"', 'every 12"'])).toBe('Flange screw · 2½" · every 12"');
  });

  it("drops blank, null and undefined parts without doubling the separator", () => {
    expect(joinFactLine(["Brick", "", null, undefined, "  ", "front only"])).toBe("Brick · front only");
  });

  it("is null when nothing survives", () => {
    expect(joinFactLine(["", null, "  "])).toBeNull();
  });
});

describe("hasAnyUnitFact", () => {
  it("is false for a null row", () => {
    expect(hasAnyUnitFact(null)).toBe(false);
  });

  it("is false when every field is blank and every line is empty", () => {
    expect(hasAnyUnitFact(emptyFacts({ exterior_lines: [line()] }))).toBe(false);
  });

  it("is true when a plain field is answered", () => {
    expect(hasAnyUnitFact(emptyFacts({ site_rules: "Hard hats." }))).toBe(true);
  });

  it("is true when only an exterior situation is answered", () => {
    expect(hasAnyUnitFact(emptyFacts({ exterior_lines: [brickOutset] }))).toBe(true);
  });

  it("is true when only the named 'other' flashing is on file", () => {
    expect(hasAnyUnitFact(emptyFacts({ flashing_system_other: "FlexWrap" }))).toBe(true);
  });
});
