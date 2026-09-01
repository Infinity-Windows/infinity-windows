import { describe, expect, it } from "vitest";
import { displayMarkCode } from "../fitview/adapter";
import { inches } from "../fitview/fitviewRenderer";
import type { UnitConfig } from "./units";
import {
  unitMarkLabel,
  unitPaneSummary,
  unitSizeLabel,
  unitStyleColorLine,
  unitTypeLabel,
} from "./unitIdentity";

describe("unitMarkLabel", () => {
  it("re-spells a survey mark in work-order dialect, same as the map", () => {
    // Pinned to adapter.ts's own displayMarkCode — if that function's
    // behavior ever changes, this test changes with it rather than
    // silently drifting from the elevations view's vocabulary.
    expect(unitMarkLabel("1A")).toBe(displayMarkCode("1A"));
    expect(unitMarkLabel("13B")).toBe("13-2");
    expect(unitMarkLabel("201A@L3")).toBe("201-1@L3");
  });

  it("leaves an already-dashed mark unchanged", () => {
    expect(unitMarkLabel("16-1")).toBe("16-1");
  });

  it("leaves a plain digit mark unchanged", () => {
    expect(unitMarkLabel("16")).toBe("16");
  });

  it("degrades gracefully for a hand-typed catalog name", () => {
    expect(unitMarkLabel("Window 16")).toBe("Window 16");
    expect(unitMarkLabel("New window")).toBe("New window");
  });

  it("trims whitespace before converting", () => {
    expect(unitMarkLabel("  16A  ")).toBe("16-1");
  });

  it("is null for nothing to show", () => {
    expect(unitMarkLabel(null)).toBeNull();
    expect(unitMarkLabel(undefined)).toBeNull();
    expect(unitMarkLabel("")).toBeNull();
    expect(unitMarkLabel("   ")).toBeNull();
  });
});

describe("unitTypeLabel", () => {
  it("reads window/door straight off the config's kind", () => {
    expect(unitTypeLabel({ kind: "window" })).toBe("Window");
    expect(unitTypeLabel({ kind: "door" })).toBe("Door");
  });

  it("appends the spec's own operation string when there is one (mark 1)", () => {
    expect(unitTypeLabel({ kind: "door" }, "Fixed / Double Swing Door")).toBe(
      "Door · Fixed / Double Swing Door",
    );
    expect(unitTypeLabel({ kind: "window" }, "Fixed")).toBe("Window · Fixed");
  });

  it("drops the operation half of the chip when the sheet never printed one (mark 7)", () => {
    expect(unitTypeLabel({ kind: "door" }, null)).toBe("Door");
    expect(unitTypeLabel({ kind: "door" }, undefined)).toBe("Door");
    expect(unitTypeLabel({ kind: "door" }, "   ")).toBe("Door");
  });
});

describe("unitStyleColorLine", () => {
  it("cuts style and color at their first parenthetical (real mark 8 spec)", () => {
    expect(
      unitStyleColorLine({
        style: "Thermal Break Aluminum Storefront Fixed Window(1 3/8\" Nail Fins)",
        color: "TruLite Bronze(Aluminum profile Color)",
      }),
    ).toBe("Thermal Break Aluminum Storefront Fixed Window · TruLite Bronze");
  });

  it("drops the hardware-color aside the same way (real mark 1 spec)", () => {
    expect(
      unitStyleColorLine({
        style: null,
        color: "TruLite Bronze(Aluminum profile Color) ,Black(Hardware Color)",
      }),
    ).toBe("TruLite Bronze");
  });

  it("shows whichever field is present alone, and null when neither is", () => {
    expect(unitStyleColorLine({ style: "Fixed Window", color: null })).toBe("Fixed Window");
    expect(unitStyleColorLine({ style: null, color: null })).toBeNull();
    expect(unitStyleColorLine(null)).toBeNull();
    expect(unitStyleColorLine(undefined)).toBeNull();
  });
});

describe("unitSizeLabel", () => {
  it("formats W x L with the elevations view's own inches() tape reading", () => {
    const config: Pick<UnitConfig, "panels" | "heightMm"> = {
      panels: [{ widthMm: 914.4, mechanism: "fixed" }], // 36"
      heightMm: 1219.2, // 48"
    };
    expect(unitSizeLabel(config)).toBe(`W ${inches(914.4)} · L ${inches(1219.2)}`);
    expect(unitSizeLabel(config)).toBe('W 36" · L 48"');
  });

  it("sums every panel's width, the same total the Width field edits", () => {
    const config: Pick<UnitConfig, "panels" | "heightMm"> = {
      panels: [
        { widthMm: 914.4, mechanism: "fixed" }, // 36"
        { widthMm: 609.6, mechanism: "slider", direction: "left" }, // 24"
      ],
      heightMm: 1524, // 60"
    };
    expect(unitSizeLabel(config)).toBe('W 60" · L 60"');
  });

  it("shows a fraction the same way the elevations sheet does", () => {
    // 313.5" wide (BLACK22 mark 16's real spec width) -> 313 1/2".
    const config: Pick<UnitConfig, "panels" | "heightMm"> = {
      panels: [{ widthMm: 313.5 * 25.4, mechanism: "fixed" }],
      heightMm: 84 * 25.4,
    };
    expect(unitSizeLabel(config)).toBe('W 313 1/2" · L 84"');
  });
});

describe("unitPaneSummary", () => {
  // Mad Moose (project 08c60cce-29f6-4b52-bd0c-2bc2c02a79a9), owner report
  // 2026-09-01: marks 1, 7 and 8 all spec at 167.5x143.5in. Mark 7's own
  // `operation` field is NULL — the extractor read no overall operation off
  // the sheet — but Studio still showed "4 panes · 2× Fixed, 2× Slider" for
  // it. That text came from the CATALOG unit's config.panels (whatever
  // mechanisms a "Window 7"/"Door 7" catalog build happens to carry, or
  // specToUnitConfig's own single-fixed-panel default) — not from the CAD
  // spec sheet, which never said "slider" anywhere for this mark. Confirmed
  // via a live query against project_mark_specs: mark 7's `extra.panels` DOES
  // dimension four panels (F/X/X/F, 45.75/38/38/45.75 in) — the sheet is NOT
  // silent about panel layout, it just doesn't use catalog vocabulary
  // ("Slider") for what an "X" panel does. The fix: read the pane breakdown
  // off the SPEC (extra.panels), never off the placed/catalog config.
  const mark7Spec = {
    operation: null,
    extra: {
      panels: [
        { op: "F", width_in: 45.75 },
        { op: "X", width_in: 38 },
        { op: "X", width_in: 38 },
        { op: "F", width_in: 45.75 },
      ],
    },
  };
  // A catalog/placed config that does NOT match the spec at all — the
  // exact shape of the bug: whatever a Studio unit's own panels/mechanisms
  // say must be irrelevant to this function now that it reads the spec.
  const unrelatedCatalogConfig: Pick<UnitConfig, "kind"> = { kind: "door" };

  it("never invents a pane mechanism the spec sheet didn't state (mark 7 repro)", () => {
    const line = unitPaneSummary(unrelatedCatalogConfig, mark7Spec);
    expect(line).not.toMatch(/Slider/i);
    expect(line).not.toMatch(/Fixed/i);
    // The sheet's own letters, not the catalog's mechanism names.
    expect(line).toBe("4 panels · F · X · X · F");
  });

  it("reads mark 1's door leaf (op is null on a door-kind mark) as 'Door', not a fabricated mechanism", () => {
    // Real mark 1 row: 3 panels, F/F/null — the third is the swing-door
    // leaf itself, which the extractor's F/O/X vocabulary can't label.
    const mark1Spec = {
      operation: "Fixed / Double Swing Door",
      extra: {
        panels: [
          { op: "F", width_in: 45.75 },
          { op: "F", width_in: 76 },
          { op: null, width_in: 45.75 },
        ],
      },
    };
    expect(unitPaneSummary({ kind: "door" }, mark1Spec)).toBe("3 panels · F · F · Door");
  });

  it("reads mark 8 straight off the sheet (all four panels fixed)", () => {
    const mark8Spec = {
      operation: "Fixed",
      extra: {
        panels: [
          { op: "F", width_in: 41.875 },
          { op: "F", width_in: 41.875 },
          { op: "F", width_in: 41.875 },
          { op: "F", width_in: 41.875 },
        ],
      },
    };
    expect(unitPaneSummary({ kind: "window" }, mark8Spec)).toBe("4 panels · F · F · F · F");
  });

  it("stays honestly silent (null) when the spec has no panel breakdown at all", () => {
    expect(unitPaneSummary({ kind: "window" }, { operation: "Fixed", extra: null })).toBeNull();
    expect(unitPaneSummary({ kind: "window" }, null)).toBeNull();
    expect(unitPaneSummary({ kind: "window" }, undefined)).toBeNull();
  });

  it("marks an unlabeled panel on a WINDOW (no door convention to fall back on) as unknown, never a guess", () => {
    const spec = { operation: null, extra: { panels: [{ op: null, width_in: 30 }] } };
    expect(unitPaneSummary({ kind: "window" }, spec)).toBe("1 panel · ?");
  });

  it("ignores a garbage panel entry with no real width", () => {
    const spec = {
      operation: null,
      extra: { panels: [{ op: "F", width_in: 30 }, { op: "X", width_in: null }] },
    };
    expect(unitPaneSummary({ kind: "window" }, spec)).toBe("1 panel · F");
  });
});
