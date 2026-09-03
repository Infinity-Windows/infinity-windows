import { describe, it, expect, vi } from "vitest";
import { editableUnitConfig } from "./selectionConfig";
import type { UnitConfig } from "./units";

/**
 * Selection is read-only (owner, 2026-09-02, Mad Moose): tapping an Add on
 * the office glass wall was mirroring its label and re-splitting its panels.
 * `editableUnitConfig` is the whole item-facing effect of a selection now —
 * it derives what the editor shows and must NEVER re-seat or reshape the
 * unit. A fake item stands in for the StudioItem so we can spy every method
 * the old on-select rebuild used to call (getHeight/getWidth/placeInRoom).
 */
function fakeItem(unitConfig: UnitConfig | null) {
  return {
    unitConfig,
    placeInRoom: vi.fn(),
    getHeight: vi.fn(() => 95.5 * 2.54), // cm
    getWidth: vi.fn(() => 129.5 * 2.54), // cm
    position: { x: 12, y: 340, z: -7 },
    rotation: { y: Math.PI / 2 },
  };
}

const doorPlusFixed: UnitConfig = {
  kind: "door",
  heightMm: 2425.7,
  // Mirror of buildStudioPull's config for Add-1: a French-door leaf (op X ->
  // slider) plus two fixed panels.
  panels: [
    { widthMm: 1016, mechanism: "slider", direction: "right" },
    { widthMm: 1136.65, mechanism: "fixed" },
    { widthMm: 1136.65, mechanism: "fixed" },
  ],
  cornerAfterPanel: null,
};

describe("editableUnitConfig — selecting a unit changes nothing about it", () => {
  it("a door-plus-fixed unit is returned by identity and never touched", () => {
    const item = fakeItem(doorPlusFixed);
    const panelsBefore = item.unitConfig!.panels;
    const posBefore = { ...item.position };
    const rotBefore = { ...item.rotation };

    const editable = editableUnitConfig(item);

    // The editor edits the unit's OWN config, unchanged (same array, same
    // widths/mechanisms/direction) — no re-split.
    expect(editable).toBe(doorPlusFixed);
    expect(editable.panels).toBe(panelsBefore);
    expect(editable.panels.map((p) => [p.mechanism, p.direction, p.widthMm])).toEqual([
      ["slider", "right", 1016],
      ["fixed", undefined, 1136.65],
      ["fixed", undefined, 1136.65],
    ]);

    // Nothing re-seats or reshapes the item: no placeInRoom (the mirror), and
    // a unit with a real config isn't even measured.
    expect(item.placeInRoom).not.toHaveBeenCalled();
    expect(item.getHeight).not.toHaveBeenCalled();
    expect(item.getWidth).not.toHaveBeenCalled();
    expect(item.position).toEqual(posBefore);
    expect(item.rotation).toEqual(rotBefore);
  });

  it("a legacy generic with no panels gets editable inputs, still untouched", () => {
    const item = fakeItem(null);
    const posBefore = { ...item.position };
    const rotBefore = { ...item.rotation };

    const editable = editableUnitConfig(item);

    // Derived single fixed panel sized to the measured footprint, so W/H are
    // editable — but the physical unit is not rebuilt here.
    expect(editable.panels).toHaveLength(1);
    expect(editable.panels[0].mechanism).toBe("fixed");
    expect(editable.heightMm).toBe(Math.round(95.5 * 2.54 * 10));
    expect(editable.panels[0].widthMm).toBe(Math.round(129.5 * 2.54 * 10));

    // Reading its size is allowed; re-seating it is not.
    expect(item.placeInRoom).not.toHaveBeenCalled();
    expect(item.position).toEqual(posBefore);
    expect(item.rotation).toEqual(rotBefore);
    expect(item.unitConfig).toBeNull(); // heal happens on edit, not on select
  });
});
