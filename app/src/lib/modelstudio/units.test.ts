// General units.ts pure-function coverage that isn't specific to pane-grid
// editing (see paneGrid.test.ts for splits/presets/spec-import).

import { describe, expect, it } from "vitest";
import {
  configFromTiers,
  constructabilityProblems,
  mirrorUnitConfig,
  specImportName,
  specToUnitConfig,
  unitTiers,
  type UnitConfig,
  type UnitTier,
} from "./units";
import type { ProjectMarkSpec } from "../install/specs";

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

  // Studio 100x #22: a multi-tier unit must flip EVERY tier, not just the
  // flat mirror — otherwise "Mirror" leaves tier 1 flipped and the tiers
  // above it untouched, an inconsistent unit.
  it("flips every tier's panels too, keeping the flat mirror in sync", () => {
    const cfg: UnitConfig = configFromTiers(
      { kind: "window" },
      [
        { panels: [{ widthMm: 900, mechanism: "slider", direction: "left" }], heightMm: 1200, story: 1 },
        { panels: [{ widthMm: 900, mechanism: "casement", direction: "right" }], heightMm: 1200, story: 2 },
      ],
    );
    const mirrored = mirrorUnitConfig(cfg);
    expect(mirrored.tiers?.[0].panels[0].direction).toBe("right");
    expect(mirrored.tiers?.[1].panels[0].direction).toBe("left");
    // The flat fields still mirror tier 0 after the flip.
    expect(mirrored.panels[0].direction).toBe(mirrored.tiers?.[0].panels[0].direction);
  });
});

describe("unitTiers / configFromTiers (Studio 100x #22)", () => {
  const flatCfg: UnitConfig = {
    kind: "window",
    heightMm: 1500,
    panels: [{ widthMm: 900, mechanism: "fixed" }],
    cornerAfterPanel: null,
  };

  it("a config with no tiers field synthesizes exactly one tier off the flat fields", () => {
    const tiers = unitTiers(flatCfg);
    expect(tiers).toHaveLength(1);
    expect(tiers[0]).toEqual({
      panels: flatCfg.panels,
      heightMm: flatCfg.heightMm,
      cornerAfterPanel: null,
      story: 1,
    });
  });

  it("an empty tiers array is treated the same as absent", () => {
    expect(unitTiers({ ...flatCfg, tiers: [] })).toEqual(unitTiers(flatCfg));
  });

  it("a config WITH tiers returns them verbatim, ignoring the flat fields' own content", () => {
    const tiers: UnitTier[] = [
      { panels: [{ widthMm: 800, mechanism: "fixed" }], heightMm: 1000, story: 1 },
      { panels: [{ widthMm: 800, mechanism: "hung" }], heightMm: 900, story: 2 },
    ];
    const cfg: UnitConfig = { ...flatCfg, tiers };
    expect(unitTiers(cfg)).toBe(tiers);
  });

  it("configFromTiers collapses a single tier to the plain flat shape — no `tiers` key at all", () => {
    const cfg = configFromTiers(
      { kind: "door", insetOutset: "outset", weightLb: 42, frameColor: "black" },
      [{ panels: [{ widthMm: 900, mechanism: "fixed" }], heightMm: 2000, cornerAfterPanel: null, story: 1 }],
    );
    expect("tiers" in cfg).toBe(false);
    expect(cfg.panels).toEqual([{ widthMm: 900, mechanism: "fixed" }]);
    expect(cfg.heightMm).toBe(2000);
    expect(cfg.kind).toBe("door");
    expect(cfg.insetOutset).toBe("outset");
    expect(cfg.weightLb).toBe(42);
    expect(cfg.frameColor).toBe("black");
  });

  it("configFromTiers with 2+ tiers sets `tiers` AND mirrors tier 0 onto the flat fields", () => {
    const tiers: UnitTier[] = [
      { panels: [{ widthMm: 900, mechanism: "fixed" }], heightMm: 1200, cornerAfterPanel: null, story: 1 },
      { panels: [{ widthMm: 900, mechanism: "slider", direction: "left" }], heightMm: 1100, story: 2 },
      { panels: [{ widthMm: 900, mechanism: "casement", direction: "right" }], heightMm: 1000, story: 3 },
    ];
    const cfg = configFromTiers({ kind: "window" }, tiers);
    expect(cfg.tiers).toEqual(tiers);
    expect(cfg.panels).toEqual(tiers[0].panels);
    expect(cfg.heightMm).toBe(1200);
    expect(cfg.cornerAfterPanel).toBeNull();
  });

  it("round-trips through unitTiers — what you build is what you read back, single or multi-tier", () => {
    // cornerAfterPanel explicit (not absent) — configFromTiers's flat
    // mirror always writes it, so unitTiers' synthesis always reads it
    // back as an explicit value, not "absent."
    const single: UnitTier[] = [
      { panels: [{ widthMm: 700, mechanism: "hung" }], heightMm: 1400, cornerAfterPanel: null, story: 1 },
    ];
    expect(unitTiers(configFromTiers({ kind: "window" }, single))).toEqual(single);

    const multi: UnitTier[] = [
      { panels: [{ widthMm: 900, mechanism: "fixed" }], heightMm: 1200, story: 1 },
      { panels: [{ widthMm: 900, mechanism: "fixed" }], heightMm: 1200, story: 2 },
    ];
    expect(unitTiers(configFromTiers({ kind: "window" }, multi))).toEqual(multi);
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

// Owner, live pilot 2026-09-02: Mad Moose's Add units are French doors
// ("Fixed / French Door") but Studio drew the operable leaf as a SLIDING
// panel with a → arrow instead of a swing. A door that doesn't slide swings.
describe("specToUnitConfig door leaf swings vs slides", () => {
  const base: ProjectMarkSpec = {
    mark_code: "D-11", style: null, glass: null, color: null,
    size_code: null, width_in: 72, height_in: 84, operation: null,
    tempered: null, egress: null, u_factor: null, shgc: null, grids: null,
    screen: null, product_line: null, extra: null, image_page: null,
    image_bbox: null, planset_id: null, confirmed: false, source: "ai",
    id: "d11", project_id: "p", created_at: "", updated_at: "",
  };

  it("a French door's operable leaf swings (casement, with a hinge side); its fixed leaves stay fixed", () => {
    const spec: ProjectMarkSpec = {
      ...base,
      style: "Fixed / French Door (inward, 3-point lock)",
      operation: "Fixed / French Door",
      extra: {
        panels: [
          { op: "X", width_in: 40 },
          { op: "F", width_in: 20 },
          { op: "F", width_in: 20 },
        ],
      },
    };
    const cfg = specToUnitConfig(spec)!;
    expect(cfg.kind).toBe("door");
    expect(cfg.panels[0].mechanism).toBe("casement");
    expect(cfg.panels[0].direction).toBeDefined();
    expect(cfg.panels[1].mechanism).toBe("fixed");
    expect(cfg.panels[2].mechanism).toBe("fixed");
  });

  it("a bare French door with no drawn panels swings too, not a fixed slab", () => {
    const cfg = specToUnitConfig({
      ...base,
      style: "Aluminum French Door",
      operation: "French Door",
    })!;
    expect(cfg.kind).toBe("door");
    expect(cfg.panels).toHaveLength(1);
    expect(cfg.panels[0].mechanism).toBe("casement");
    expect(cfg.panels[0].direction).toBeDefined();
  });

  it("a sliding patio door's operable leaf still slides — drawn panels", () => {
    const spec: ProjectMarkSpec = {
      ...base,
      style: "Aluminum Sliding Patio Door",
      operation: "XO",
      extra: {
        panels: [
          { op: "X", width_in: 36 },
          { op: "O", width_in: 36 },
        ],
      },
    };
    const cfg = specToUnitConfig(spec)!;
    expect(cfg.kind).toBe("door");
    expect(cfg.panels[0].mechanism).toBe("slider");
    expect(cfg.panels[1].mechanism).toBe("fixed");
  });

  it("a sliding patio door's operable leaf still slides — operation string", () => {
    const cfg = specToUnitConfig({
      ...base,
      style: "Sliding Patio Door",
      operation: "OX",
    })!;
    expect(cfg.kind).toBe("door");
    expect(cfg.panels.some((p) => p.mechanism === "slider")).toBe(true);
    expect(cfg.panels.every((p) => p.mechanism !== "casement")).toBe(true);
  });

  it("a window with an XO operation is untouched — X stays a slider", () => {
    const cfg = specToUnitConfig({
      ...base,
      style: "Aluminum Sliding Window",
      operation: "XO",
    })!;
    expect(cfg.kind).toBe("window");
    expect(cfg.panels[0].mechanism).toBe("slider");
    expect(cfg.panels[1].mechanism).toBe("fixed");
  });

  // Studio used to answer both of these questions with its own regexes, and
  // they had drifted from the answer the job card, the map and the counts give
  // (wave X review). Both cases below are ones the old rules got wrong.
  describe("reads the spec the same way the rest of the app does", () => {
    it("does not turn an OUTDOOR living room into a door", () => {
      // `/door|patio/` with no word boundary matched "outdoor". The shared
      // classifier matches whole words only.
      const spec: ProjectMarkSpec = {
        ...base,
        style: "Outdoor living room fixed panel",
        operation: "Fixed",
      };
      expect(specToUnitConfig(spec)!.kind).toBe("window");
      expect(specImportName(spec)).toBe("Window D-11");
    });

    it("keeps a French door swinging when a sliding screen is mentioned later", () => {
      // The old test searched the whole style-plus-operation string for
      // "slid", so this drew with a slide arrow. Position decides: the
      // supplier writes the unit first and its neighbours after.
      const cfg = specToUnitConfig({
        ...base,
        style: "Aluminum French Door with sliding screen",
        operation: "French Door",
      })!;
      expect(cfg.kind).toBe("door");
      expect(cfg.panels[0].mechanism).toBe("casement");
    });

    it("draws a bifold's leaf as a fold, which the catalog has a symbol for", () => {
      const cfg = specToUnitConfig({
        ...base,
        style: "Thermal break Aluminum Bi-Fold Door (4 panel)",
        operation: null,
      })!;
      expect(cfg.kind).toBe("door");
      expect(cfg.panels[0].mechanism).toBe("bifold");
    });
  });
});
