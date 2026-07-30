import { describe, expect, it } from "vitest";
import {
  openingUnitKind,
  openingUnitKindResolver,
  unitKindFromDescription,
  type UnitKindOpening,
} from "./unitKind";

/** An opening whose window type says `category`, and nothing else useful. */
function opening(
  category: string | null,
  over: Partial<NonNullable<UnitKindOpening["window_types"]>> = {},
): UnitKindOpening {
  return {
    opening_code: "1",
    window_types: { category, type_code: null, name: null, ...over },
  };
}

describe("unitKindFromDescription", () => {
  it("reads the word off a real Black Desert spec line", () => {
    expect(
      unitKindFromDescription('Thermal Break Aluminum Fixed Window(1 3/8" Nail Fins)'),
    ).toBe("window");
    expect(
      unitKindFromDescription(
        'Thermal break Aluminum French Door (Low track)(1 3/8" Nail Fins) (Outside View)',
      ),
    ).toBe("door");
    expect(
      unitKindFromDescription(
        "2 Track Thermal break Aluminum Sliding Door (2 panel Fixed)(New Track)(Outside View)",
      ),
    ).toBe("door");
  });

  it("calls a door-plus-sidelight unit a door", () => {
    // Six of Black Desert's marks read like this. It is hung as a door.
    expect(
      unitKindFromDescription(
        "Thermal break Aluminum French Door with Thermal break Fixed Window (Low threshold)",
      ),
    ).toBe("door");
    expect(unitKindFromDescription("sliding glass door window wall")).toBe("door");
  });

  it("ignores case and matches plurals", () => {
    expect(unitKindFromDescription("FRENCH DOORS")).toBe("door");
    expect(unitKindFromDescription("fixed windows")).toBe("window");
  });

  it("matches whole words only", () => {
    // The trap: these contain "door"/"window" but describe neither.
    expect(unitKindFromDescription("Outdoor living room unit")).toBe(null);
    expect(unitKindFromDescription("Indoor shutter")).toBe(null);
    expect(unitKindFromDescription("Doorway header")).toBe(null);
  });

  it("says nothing when the description says nothing", () => {
    expect(unitKindFromDescription("Casement, tempered, argon filled")).toBe(null);
    expect(unitKindFromDescription("")).toBe(null);
    expect(unitKindFromDescription(null)).toBe(null);
    expect(unitKindFromDescription(undefined)).toBe(null);
  });

  it("finds the word next to a bracket, as the sheets write it", () => {
    expect(unitKindFromDescription("Fixed Window(Butt-Jointed Corner)")).toBe("window");
  });
});

describe("openingUnitKind", () => {
  it("believes the description over the category", () => {
    // Black Desert mark #2: filed as a door, its sheet says otherwise.
    expect(
      openingUnitKind(
        opening("door"),
        'Thermal Break Aluminum Fixed Window(1 3/8" Nail Fins)',
      ),
    ).toBe("window");
    // Black Desert mark #36: filed as a window, its sheet says otherwise.
    expect(
      openingUnitKind(opening("window"), "Thermal break Aluminum French Door (Low track)"),
    ).toBe("door");
  });

  it("falls back to the category when there is no description", () => {
    expect(openingUnitKind(opening("door"))).toBe("door");
    expect(openingUnitKind(opening("window"))).toBe("window");
    expect(openingUnitKind(opening("double-hung"))).toBe("window");
  });

  it("falls back to the category when the description decides nothing", () => {
    expect(openingUnitKind(opening("door"), "Tempered, argon filled")).toBe("door");
  });

  it("still reads a patio door out of the type code", () => {
    const patio = opening(null, { type_code: "6080", name: "XO Slider" });
    expect(openingUnitKind(patio)).toBe("door");
    expect(openingUnitKind(opening(null, { type_code: "DOOR-1" }))).toBe("door");
  });

  it("treats an unknown opening as a window, as before", () => {
    expect(openingUnitKind(opening(null))).toBe("window");
  });
});

describe("openingUnitKindResolver", () => {
  const specs = [
    { mark_code: "2", style: "Thermal Break Aluminum Fixed Window" },
    { mark_code: "36", style: "Thermal break Aluminum French Door (Low track)" },
  ];

  it("shares a mark's spec across every opening of that mark", () => {
    const kind = openingUnitKindResolver(specs);
    expect(kind({ ...opening("door"), opening_code: "2-1" })).toBe("window");
    expect(kind({ ...opening("door"), opening_code: "2-2" })).toBe("window");
    expect(kind({ ...opening("window"), opening_code: "36" })).toBe("door");
  });

  it("falls back for a mark the spec sheet is missing", () => {
    const kind = openingUnitKindResolver(specs);
    // Black Desert marks #7 and #8 have no spec row at all.
    expect(kind({ ...opening("window"), opening_code: "7" })).toBe("window");
    expect(kind({ ...opening("door"), opening_code: "7" })).toBe("door");
  });

  it("falls back for a job whose specs were never extracted", () => {
    const kind = openingUnitKindResolver([]);
    expect(kind({ ...opening("door"), opening_code: "C103" })).toBe("door");
    expect(kind({ ...opening("double-hung"), opening_code: "C101" })).toBe("window");
  });
});
