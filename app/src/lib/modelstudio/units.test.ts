// General units.ts pure-function coverage that isn't specific to pane-grid
// editing (see paneGrid.test.ts for splits/presets/spec-import).

import { describe, expect, it } from "vitest";
import { constructabilityProblems, mirrorUnitConfig, type UnitConfig } from "./units";

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

describe("constructabilityProblems (Studio 100x #13)", () => {
  it("a flat, in-range config has nothing to say", () => {
    const cfg: UnitConfig = {
      kind: "window",
      heightMm: 1500,
      panels: [{ widthMm: 900, mechanism: "slider", direction: "left", slideCount: 3 }],
    };
    expect(constructabilityProblems(cfg)).toEqual([]);
  });

  it("flags a corner marked past the last legal split", () => {
    const cfg: UnitConfig = {
      kind: "window",
      heightMm: 1500,
      panels: [{ widthMm: 900, mechanism: "fixed" }],
      cornerAfterPanel: 0, // one panel — nothing left to wrap into
    };
    expect(constructabilityProblems(cfg)).toHaveLength(1);
    expect(constructabilityProblems(cfg)[0]).toMatch(/corner/);
  });

  it("a legal corner (0 <= k <= panels.length - 2) raises nothing", () => {
    const cfg: UnitConfig = {
      kind: "window",
      heightMm: 1500,
      panels: [
        { widthMm: 300, mechanism: "fixed" },
        { widthMm: 900, mechanism: "fixed" },
      ],
      cornerAfterPanel: 0,
    };
    expect(constructabilityProblems(cfg)).toEqual([]);
  });

  it("flags a stored slide count outside 1-8, even though slideCountOf would clamp it", () => {
    const cfg: UnitConfig = {
      kind: "window",
      heightMm: 1500,
      panels: [{ widthMm: 900, mechanism: "slider", direction: "left", slideCount: 12 }],
    };
    expect(constructabilityProblems(cfg)).toHaveLength(1);
    expect(constructabilityProblems(cfg)[0]).toMatch(/slide count/);
  });

  it("a non-slider panel's slideCount is never judged — ignored off sliders", () => {
    const cfg: UnitConfig = {
      kind: "window",
      heightMm: 1500,
      panels: [{ widthMm: 900, mechanism: "fixed", slideCount: 99 }],
    };
    expect(constructabilityProblems(cfg)).toEqual([]);
  });

  it("both kinds of problem can fire on the same config", () => {
    const cfg: UnitConfig = {
      kind: "window",
      heightMm: 1500,
      panels: [{ widthMm: 900, mechanism: "slider", direction: "left", slideCount: 0 }],
      cornerAfterPanel: 5,
    };
    expect(constructabilityProblems(cfg)).toHaveLength(2);
  });
});
