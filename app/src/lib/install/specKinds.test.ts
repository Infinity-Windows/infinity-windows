// Wave X (X1): which door is it, from the supplier's own words.
//
// Every string below is a REAL one off a job in this repo — Black Desert's
// spec fixture (app/e2e/fixtures/mark_specs.json, marks 1-39) and Mad Moose's
// cut sheet (app/src/lib/fitview/fixtures/madmoose-mm2.json). A rule that only
// works on invented text is a rule that has never met a spec sheet.

import { describe, expect, it } from "vitest";
import { doorKind, specKindColumns } from "./specKinds.mjs";

// ---- Black Desert (app/e2e/fixtures/mark_specs.json) ----------------------
const BD_FIXED_WINDOW =
  'Thermal Break Aluminum Fixed Window(1 3/8" Nail Fins)(Aluminum plate mull)';
const BD_FRENCH_DOOR =
  'Thermal break Aluminum French Door (Low track)(1 3/8" Nail Fins) (Outside View)';
const BD_FRENCH_WITH_WINDOW =
  'Thermal break Aluminum French Door with Thermal break Fixed Window (Low threshold)(1 3/8" Nail Fins) (Outside View)';
const BD_SLIDER =
  "2 Track Thermal break Aluminum Sliding Door (2 panel Fixed)(New Track)(Outside View)";
const BD_SLIDER_CORNER_WITH_FRENCH =
  "3 Track 3 Panel Thermal break Aluminum Sliding Door with Thermal break Aluminum French Door(Sliding door 90° Corner meet )(2 panel Fixed)(New Track)(Outside View)";
const BD_NARROW_FRENCH_INTERIOR =
  'Non-Thermal break Aluminum Narrow French Door with Non-Thermal break Narrow Fixed Window(Interior use)(No threshold)(one inch gap between door and floor)(1 3/8" Nail Fins) (Outside View)';

// ---- Mad Moose (app/src/lib/fitview/fixtures/madmoose-mm2.json) -----------
const MM_COMMERCIAL_DOOR =
  'Thermal break Aluminum Commercial style door(With threshold)(Outside View)(1 3/8" Nail Fins)';
const MM_STOREFRONT_WITH_DOOR =
  'Thermal Break Aluminum Storefront Fixed Window with Thermal break Aluminum Commercial style door (With threshold)(Outside View)(1 3/8" Nail Fins)( 32" clear opening when one door is opened)';

describe("doorKind", () => {
  it("reads French off Black Desert's door marks", () => {
    expect(doorKind(BD_FRENCH_DOOR, null)).toBe("french");
    expect(doorKind(BD_FRENCH_DOOR, "French door track(Inward opening)")).toBe(
      "french",
    );
    expect(doorKind(BD_FRENCH_WITH_WINDOW, "Fixed / French Door")).toBe("french");
    expect(doorKind(BD_NARROW_FRENCH_INTERIOR, null)).toBe("french");
  });

  it("reads a slider off the sliding-door marks", () => {
    expect(doorKind(BD_SLIDER, "Sliding (2 panel Fixed)")).toBe("slider");
  });

  it("gives mark #29 to the slider it is, not the French door on its end", () => {
    // "Sliding Door with … French Door": the supplier writes the unit first
    // and its neighbour after, so the first door word is the unit's own kind.
    expect(doorKind(BD_SLIDER_CORNER_WITH_FRENCH, "F / Sliding / F")).toBe(
      "slider",
    );
  });

  it("falls to the operation line when the style only says 'door'", () => {
    // Mad Moose: the style says "Commercial style door" and never says how it
    // opens; the operation line is where "Swing door" is written.
    expect(doorKind(MM_COMMERCIAL_DOOR, "Swing door, single leaf (panic hardware, closer)")).toBe(
      "swing",
    );
    expect(
      doorKind(MM_STOREFRONT_WITH_DOOR, "Fixed / double swing door pair (panic hardware, closers)"),
    ).toBe("swing");
  });

  it("keeps a word ahead of the operation letters", () => {
    // The Mad Moose bug this ordering exists to avoid (units.ts, 2026-09-02):
    // a French door must never be read as a slider because of its letters.
    expect(doorKind(BD_FRENCH_DOOR, "XO")).toBe("french");
  });

  it("reads the operation letters as the slider notation they are", () => {
    // docs/window-vendor-conventions.md, "Slider panel notation (OXXO)": X/O
    // is what a sliding unit's panels are written as and is used for nothing
    // else — X slides, O does not. So every letter string is a slider, not
    // just the four-panel OXXO. All 98 real spec rows carrying XO/OX say
    // "Sliding Door" on their style line, which is the same answer.
    expect(doorKind(null, "OXXO")).toBe("slider");
    expect(doorKind(null, "XO")).toBe("slider");
    expect(doorKind("", "OX")).toBe("slider");
    expect(doorKind(null, "OXO")).toBe("slider");
    // inferHardware draws a non-OXXO string as a hinged leaf because the
    // renderer has no slide arrow for an odd panel count. That is a drawing
    // fallback, and reading it as "this door swings" is the bug this guards.
    expect(doorKind(null, "XO")).not.toBe("swing");
  });

  it("reads a bifold when the sheet says bifold", () => {
    expect(doorKind("Thermal break Aluminum Bi-Fold Door (4 panel)", null)).toBe(
      "bifold",
    );
    expect(doorKind("Aluminum bifold door", null)).toBe("bifold");
    expect(doorKind("Aluminum bi fold door", null)).toBe("bifold");
  });

  it("says 'other' when nothing names the kind", () => {
    // Studio's custom marks (buildCustomMarkRegistrationPayload) send exactly
    // this: a human said "door" and nothing else is known yet.
    expect(doorKind(null, "Door")).toBe("other");
    expect(doorKind("", "")).toBe("other");
  });

  it("is never confused by 'indoor' or 'outdoor'", () => {
    expect(doorKind("Outdoor living room fixed panel", "Fixed")).toBe("other");
  });
});

describe("specKindColumns", () => {
  it("classifies Black Desert's windows and doors as the sheets read", () => {
    expect(specKindColumns({ style: BD_FIXED_WINDOW, operation: "Fixed" })).toEqual({
      unit_kind: "window",
      door_kind: null,
    });
    expect(specKindColumns({ style: BD_FRENCH_DOOR, operation: null })).toEqual({
      unit_kind: "door",
      door_kind: "french",
    });
    expect(
      specKindColumns({ style: BD_SLIDER, operation: "Sliding (2 panel Fixed)" }),
    ).toEqual({ unit_kind: "door", door_kind: "slider" });
  });

  it("counts a door-with-a-window as one door", () => {
    // A crew hangs mark #31 as a door, so it is a door — one unit, not two.
    expect(
      specKindColumns({ style: BD_FRENCH_WITH_WINDOW, operation: "Fixed / French Door" }),
    ).toEqual({ unit_kind: "door", door_kind: "french" });
  });

  it("takes the kind off the operation when the style is missing", () => {
    // Studio's custom marks carry no style line at all.
    expect(specKindColumns({ operation: "Door" })).toEqual({
      unit_kind: "door",
      door_kind: "other",
    });
    expect(specKindColumns({ operation: "Window" })).toEqual({
      unit_kind: "window",
      door_kind: null,
    });
  });

  it("says nothing rather than guessing when the paperwork does not", () => {
    expect(specKindColumns({ style: null, operation: null })).toEqual({
      unit_kind: null,
      door_kind: null,
    });
    expect(specKindColumns({ style: "Aluminum unit, clay", operation: "XO" })).toEqual({
      unit_kind: null,
      door_kind: null,
    });
  });

  it("never puts a door kind on a window", () => {
    // The stored check constraint says the same thing; this is the app half.
    const row = specKindColumns({
      style: 'Thermal Break Aluminum Fixed Window(laminated butt glaze)(1 3/8" Nail Fins)',
      operation: "Fixed",
    });
    expect(row.door_kind).toBeNull();
  });
});
