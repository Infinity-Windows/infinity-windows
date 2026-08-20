// General units.ts pure-function coverage that isn't specific to pane-grid
// editing (see paneGrid.test.ts for splits/presets/spec-import).

import { describe, expect, it } from "vitest";
import { mirrorUnitConfig, type UnitConfig } from "./units";

describe("mirrorUnitConfig", () => {
  it("flips every panel's operable direction, left<->right", () => {
    const cfg: UnitConfig = {
      kind: "window",
      heightMm: 1800,
      panels: [
        { widthMm: 900, mechanism: "slider", direction: "left" },
        { widthMm: 900, mechanism: "casement", direction: "right" },
      ],
    };
    const mirrored = mirrorUnitConfig(cfg);
    expect(mirrored.panels[0]).toMatchObject({ mechanism: "slider", direction: "right" });
    expect(mirrored.panels[1]).toMatchObject({ mechanism: "casement", direction: "left" });
  });

  it("leaves directionless panels (fixed/hung) alone", () => {
    const cfg: UnitConfig = {
      kind: "window",
      heightMm: 1500,
      panels: [
        { widthMm: 1200, mechanism: "fixed" },
        { widthMm: 600, mechanism: "hung" },
      ],
    };
    const mirrored = mirrorUnitConfig(cfg);
    expect(mirrored.panels[0].direction).toBeUndefined();
    expect(mirrored.panels[1].direction).toBeUndefined();
    expect(mirrored.panels).toEqual(cfg.panels);
  });

  it("touches nothing else — widths, mechanisms, corner and kind pass through", () => {
    const cfg: UnitConfig = {
      kind: "door",
      heightMm: 2100,
      panels: [
        { widthMm: 800, mechanism: "bifold", direction: "left" },
        { widthMm: 2400, mechanism: "fixed" },
      ],
      cornerAfterPanel: 0,
      insetOutset: "outset",
    };
    const mirrored = mirrorUnitConfig(cfg);
    expect(mirrored.kind).toBe("door");
    expect(mirrored.heightMm).toBe(2100);
    expect(mirrored.cornerAfterPanel).toBe(0);
    expect(mirrored.insetOutset).toBe("outset");
    expect(mirrored.panels.map((p) => p.widthMm)).toEqual([800, 2400]);
    expect(mirrored.panels.map((p) => p.mechanism)).toEqual(["bifold", "fixed"]);
  });

  it("is a fresh object — mirroring twice round-trips without mutating the original", () => {
    const cfg: UnitConfig = {
      kind: "window",
      heightMm: 1800,
      panels: [{ widthMm: 900, mechanism: "slider", direction: "left" }],
    };
    const once = mirrorUnitConfig(cfg);
    const twice = mirrorUnitConfig(once);
    expect(cfg.panels[0].direction).toBe("left"); // original untouched
    expect(twice.panels[0].direction).toBe("left"); // mirrored back
    expect(once).not.toBe(cfg);
  });
});
