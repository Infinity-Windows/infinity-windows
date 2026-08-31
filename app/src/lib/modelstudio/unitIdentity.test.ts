import { describe, expect, it } from "vitest";
import { displayMarkCode } from "../fitview/adapter";
import { inches } from "../fitview/fitviewRenderer";
import type { UnitConfig } from "./units";
import { unitMarkLabel, unitPaneSummary, unitSizeLabel, unitTypeLabel } from "./unitIdentity";

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
  it("counts panes and breaks them down by mechanism, first-seen order", () => {
    const panels: UnitConfig["panels"] = [
      { widthMm: 1200, mechanism: "slider", direction: "left" },
      { widthMm: 1200, mechanism: "fixed" },
      { widthMm: 1200, mechanism: "slider", direction: "right" },
    ];
    expect(unitPaneSummary({ panels })).toBe("3 panes · 2× Slider, 1× Fixed");
  });

  it("keeps the singular for one pane", () => {
    expect(unitPaneSummary({ panels: [{ widthMm: 900, mechanism: "casement", direction: "left" }] })).toBe(
      "1 pane · 1× Casement",
    );
  });

  it("degrades to a plain message for a config with no panels yet", () => {
    expect(unitPaneSummary({ panels: [] })).toBe("No panes yet");
  });
});
