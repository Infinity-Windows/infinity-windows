import { describe, expect, it } from "vitest";
import {
  askStudioAssist,
  backfillItemDescriptions,
  buildStudioAssistPayload,
  buildUnitCatalogSummary,
  checkModelSize,
  defaultUnitName,
  describeProposal,
  MAX_MODEL_JSON_BYTES,
  parseAddUnitProposal,
  resolveWallPoint,
  serializeFloorForAI,
  type AddUnitProposal,
  type WallEndpoints,
} from "./aiAssist";
import type { StudioSavedFloorplan, StudioSerializedItem } from "./core";
import type { UnitConfig } from "./units";

// Reuses the exact building simplify-canvas-data.test.ts already ships:
// seven corners, eight walls, one floor area, five items — trimmed to what
// this file's assertions need.
const FLOORPLAN: StudioSavedFloorplan = {
  corners: {
    "56d9ebd1-91b2-875c-799d-54b3785fca1f": { x: 630.55, y: -227.58 },
    "8f4a050d-2ef4-18ce-2d90-b0ab32285f74": { x: 294.64, y: -227.58 },
    "4e312eca-51da-1daf-a45f-23dca0d3f0f1": { x: 294.64, y: 232.66 },
    "254656bf-ce52-29a6-d40e-15dcaa84b04f": { x: 745.74, y: 232.66 },
  },
  walls: [
    { corner1: "4e312eca-51da-1daf-a45f-23dca0d3f0f1", corner2: "254656bf-ce52-29a6-d40e-15dcaa84b04f" },
    { corner1: "254656bf-ce52-29a6-d40e-15dcaa84b04f", corner2: "56d9ebd1-91b2-875c-799d-54b3785fca1f" },
    { corner1: "56d9ebd1-91b2-875c-799d-54b3785fca1f", corner2: "8f4a050d-2ef4-18ce-2d90-b0ab32285f74" },
    { corner1: "8f4a050d-2ef4-18ce-2d90-b0ab32285f74", corner2: "4e312eca-51da-1daf-a45f-23dca0d3f0f1" },
  ],
};

function item(overrides: Partial<StudioSerializedItem> = {}): StudioSerializedItem {
  return {
    item_name: "Window 16",
    item_type: 3,
    model_url: "/modelstudio/models/window.json",
    xpos: 400,
    ypos: 42,
    zpos: -100,
    rotation: 0,
    scale_x: 1,
    scale_y: 1,
    scale_z: 1,
    fixed: false,
    ...overrides,
  };
}

describe("backfillItemDescriptions", () => {
  it("fills description from metadata.itemName when description is absent", () => {
    const [out] = backfillItemDescriptions([item({ metadata: { itemName: "Window 16" } })]);
    expect(out.description).toBe("Window 16");
  });

  it("never overwrites a description that's already set", () => {
    const [out] = backfillItemDescriptions([
      item({ description: "Feng shui focal window", metadata: { itemName: "Window 16" } }),
    ]);
    expect(out.description).toBe("Feng shui focal window");
  });

  it("leaves description absent when there's no itemName to borrow", () => {
    const [out] = backfillItemDescriptions([item({ metadata: {} })]);
    expect(out.description).toBeUndefined();
  });

  it("trims whitespace-only or blank itemName rather than using it", () => {
    const [out] = backfillItemDescriptions([item({ metadata: { itemName: "   " } })]);
    expect(out.description).toBeUndefined();
  });
});

const SLIDER: UnitConfig = {
  kind: "window",
  heightMm: 1200,
  panels: [{ widthMm: 900, mechanism: "slider" }, { widthMm: 900, mechanism: "fixed" }],
};

describe("buildUnitCatalogSummary", () => {
  it("summarizes name, kind, panel count and rounded size in inches", () => {
    const [entry] = buildUnitCatalogSummary([{ name: "Window 16", config: SLIDER }]);
    expect(entry).toEqual({
      name: "Window 16",
      kind: "window",
      panels: 2,
      widthIn: 71, // 1800mm / 25.4
      heightIn: 47, // 1200mm / 25.4
    });
  });

  it("caps the summary at 20 entries so the catalog block stays small", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      name: `Unit ${i}`,
      config: SLIDER,
    }));
    expect(buildUnitCatalogSummary(many)).toHaveLength(20);
  });
});

describe("buildStudioAssistPayload / serializeFloorForAI", () => {
  it("simplifies the floorplan and backfills item names, pure given plain data", () => {
    const payload = buildStudioAssistPayload(
      { floorplan: FLOORPLAN, items: [item({ metadata: { itemName: "Window 16" } })] },
      [{ name: "Window 16", config: SLIDER }],
    );
    expect(payload.model.corners).toHaveLength(4);
    expect(payload.model.layout.walls).toHaveLength(4);
    expect(payload.model.items[0].description).toBe("Window 16");
    expect(payload.unitCatalogSummary).toEqual([
      { name: "Window 16", kind: "window", panels: 2, widthIn: 71, heightIn: 47 },
    ]);
  });

  it("modelJson is exactly toMinifiedJSON(model) — what the size cap measures", () => {
    const payload = buildStudioAssistPayload({ floorplan: FLOORPLAN, items: [] }, []);
    expect(payload.modelJson).toBe(JSON.stringify(payload.model));
  });

  it("serializeFloorForAI reads a live-shaped bp through its ONE touchpoint", () => {
    const fakeBp = {
      model: {
        exportSerialized: () => JSON.stringify({ floorplan: FLOORPLAN, items: [item()] }),
      },
    };
    const payload = serializeFloorForAI(fakeBp, []);
    expect(payload.model.items).toHaveLength(1);
    expect(payload.model.corners).toHaveLength(4);
  });
});

describe("resolveWallPoint", () => {
  const walls: WallEndpoints[] = [
    // 500cm wall running along x, from (0,0) to (500,0)
    { getStartX: () => 0, getStartY: () => 0, getEndX: () => 500, getEndY: () => 0 },
    // 300cm wall running along y, from (500,0) to (500,300)
    { getStartX: () => 500, getStartY: () => 0, getEndX: () => 500, getEndY: () => 300 },
  ];

  it("interpolates a point along the named wall at the given distance", () => {
    expect(resolveWallPoint(walls, 0, 100)).toEqual({ x: 100, y: 0 });
    expect(resolveWallPoint(walls, 1, 150)).toEqual({ x: 500, y: 150 });
  });

  it("clamps xCm to the wall's own length rather than overshooting it", () => {
    expect(resolveWallPoint(walls, 0, 9999)).toEqual({ x: 500, y: 0 });
    expect(resolveWallPoint(walls, 0, -50)).toEqual({ x: 0, y: 0 });
  });

  it("returns null for a wall index that doesn't exist", () => {
    expect(resolveWallPoint(walls, 7, 100)).toBeNull();
    expect(resolveWallPoint([], 0, 100)).toBeNull();
  });

  it("doesn't divide by zero on a degenerate zero-length wall", () => {
    const zero: WallEndpoints[] = [
      { getStartX: () => 10, getStartY: () => 10, getEndX: () => 10, getEndY: () => 10 },
    ];
    expect(resolveWallPoint(zero, 0, 50)).toEqual({ x: 10, y: 10 });
  });
});

describe("describeProposal", () => {
  const walls: WallEndpoints[] = [
    { getStartX: () => 0, getStartY: () => 0, getEndX: () => 500, getEndY: () => 0 },
  ];
  const proposal: AddUnitProposal = {
    action: "add_unit",
    wall: 0,
    xCm: 120,
    config: { kind: "window", heightMm: 1200, panels: [{ widthMm: 900, mechanism: "slider" }] },
  };

  it("describes the unit, the wall's length and the offset in feet-inches", () => {
    expect(describeProposal(walls, proposal)).toBe(
      "1-panel window — the 16'5\" wall, about 3'11\" from its start",
    );
  });

  it("still explains the unit when the wall no longer resolves", () => {
    expect(describeProposal(walls, { ...proposal, wall: 9 })).toBe(
      "1-panel window — that wall isn't on the model anymore",
    );
  });
});

describe("defaultUnitName", () => {
  it("names a window vs a door and carries the panel count", () => {
    expect(
      defaultUnitName({ kind: "window", heightMm: 1200, panels: [{ widthMm: 900, mechanism: "slider" }] }),
    ).toBe("AI suggestion — 1-panel window");
    expect(
      defaultUnitName({
        kind: "door",
        heightMm: 2000,
        panels: [
          { widthMm: 900, mechanism: "bifold" },
          { widthMm: 900, mechanism: "bifold" },
        ],
      }),
    ).toBe("AI suggestion — 2-panel door");
  });
});

// ---------------------------------------------------------------------------
// checkModelSize and parseAddUnitProposal are re-exported, unchanged, from
// supabase/functions/_shared/studioAssist.ts — this IS that module's test,
// same pattern as spendGuard.test.ts / anthropicMessages.test.ts testing
// _shared/ modules from the client side. See that file's header for why the
// edge function and the browser share one copy.
// ---------------------------------------------------------------------------

describe("checkModelSize", () => {
  it("allows a payload right at the cap", () => {
    const json = "x".repeat(MAX_MODEL_JSON_BYTES);
    const check = checkModelSize(json);
    expect(check.ok).toBe(true);
    expect(check.bytes).toBe(MAX_MODEL_JSON_BYTES);
  });

  it("refuses one byte over the cap, in plain words, without throwing", () => {
    const json = "x".repeat(MAX_MODEL_JSON_BYTES + 1);
    const check = checkModelSize(json);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.message).toMatch(/too big/i);
      expect(check.message).not.toMatch(/error/i);
    }
  });

  it("measures UTF-8 bytes, not UTF-16 characters", () => {
    // Each 🤖 is 4 bytes in UTF-8 but 2 UTF-16 code units — a naive
    // `.length` cap would under-count by half here.
    const json = "🤖".repeat(MAX_MODEL_JSON_BYTES / 2 + 1);
    expect(checkModelSize(json).ok).toBe(false);
  });
});

describe("parseAddUnitProposal", () => {
  const validBlock =
    '```json\n{"action":"add_unit","wall":2,"xCm":150,' +
    '"config":{"kind":"window","heightMm":1200,' +
    '"panels":[{"widthMm":900,"mechanism":"slider"}]}}\n```';

  it("extracts a well-formed proposal and strips its block from the prose", () => {
    const text = `Sure, I'll add a slider to that wall.\n\n${validBlock}`;
    const { prose, proposal } = parseAddUnitProposal(text);
    expect(prose).toBe("Sure, I'll add a slider to that wall.");
    expect(proposal).toEqual({
      action: "add_unit",
      wall: 2,
      xCm: 150,
      config: { kind: "window", heightMm: 1200, panels: [{ widthMm: 900, mechanism: "slider" }] },
    });
  });

  it("carries through optional panel and config fields when present", () => {
    const text =
      '```json\n{"action":"add_unit","wall":0,"xCm":0,"config":{"kind":"door",' +
      '"heightMm":2032,"panels":[{"widthMm":914,"mechanism":"bifold","direction":"left",' +
      '"slideCount":2}],"cornerAfterPanel":0,"insetOutset":"outset","weightLb":180,' +
      '"frameColor":"bronze","rows":[{"heightMm":1016},{"heightMm":1016}]}}\n```';
    const { proposal } = parseAddUnitProposal(text);
    expect(proposal?.config).toEqual({
      kind: "door",
      heightMm: 2032,
      panels: [{ widthMm: 914, mechanism: "bifold", direction: "left", slideCount: 2 }],
      cornerAfterPanel: 0,
      insetOutset: "outset",
      weightLb: 180,
      frameColor: "bronze",
      rows: [{ heightMm: 1016 }, { heightMm: 1016 }],
    });
  });

  it("returns the whole text unchanged with a null proposal when there's no fenced block", () => {
    const text = "Wall 2 has a 90-inch slider on it, about 15 feet from the origin.";
    expect(parseAddUnitProposal(text)).toEqual({ prose: text, proposal: null });
  });

  it("ignores a fenced block that isn't JSON at all", () => {
    const text = "Here's the wall list:\n```\nwall 0, wall 1, wall 2\n```";
    const { proposal } = parseAddUnitProposal(text);
    expect(proposal).toBeNull();
  });

  it("ignores a JSON block whose action isn't add_unit", () => {
    const text = '```json\n{"action":"delete_unit","id":"abc"}\n```';
    expect(parseAddUnitProposal(text).proposal).toBeNull();
  });

  it.each([
    ["wall is negative", '"wall":-1,"xCm":0'],
    ["wall is not an integer", '"wall":1.5,"xCm":0'],
    ["xCm is negative", '"wall":0,"xCm":-10'],
    ["wall is missing", '"xCm":0'],
  ])("rejects a proposal where %s", (_label, fields) => {
    const text =
      `\`\`\`json\n{"action":"add_unit",${fields},"config":{"kind":"window","heightMm":1200,` +
      '"panels":[{"widthMm":900,"mechanism":"slider"}]}}\n```';
    expect(parseAddUnitProposal(text).proposal).toBeNull();
  });

  it("rejects a config with an empty panels array or an unknown mechanism", () => {
    const emptyPanels =
      '```json\n{"action":"add_unit","wall":0,"xCm":0,' +
      '"config":{"kind":"window","heightMm":1200,"panels":[]}}\n```';
    expect(parseAddUnitProposal(emptyPanels).proposal).toBeNull();

    const badMechanism =
      '```json\n{"action":"add_unit","wall":0,"xCm":0,"config":{"kind":"window",' +
      '"heightMm":1200,"panels":[{"widthMm":900,"mechanism":"pivot"}]}}\n```';
    expect(parseAddUnitProposal(badMechanism).proposal).toBeNull();
  });

  it("one bad panel invalidates the whole config, even alongside good ones", () => {
    const text =
      '```json\n{"action":"add_unit","wall":0,"xCm":0,"config":{"kind":"window",' +
      '"heightMm":1200,"panels":[{"widthMm":900,"mechanism":"slider"},' +
      '{"widthMm":-5,"mechanism":"fixed"}]}}\n```';
    expect(parseAddUnitProposal(text).proposal).toBeNull();
  });

  it("skips a malformed block and picks the next valid one — ONE proposal per reply", () => {
    const text =
      "Here's a rough idea, then the real one:\n" +
      '```json\n{"action":"add_unit","wall":"not-a-number","xCm":0,"config":{}}\n```\n' +
      "Actually:\n" +
      validBlock;
    const { proposal } = parseAddUnitProposal(text);
    expect(proposal?.wall).toBe(2);
  });

  it("never throws on garbage input", () => {
    expect(() => parseAddUnitProposal("```json\n{not json at all\n```")).not.toThrow();
    // Exercises the runtime guard against a non-string — cast rather than
    // `@ts-expect-error`, since whether this project's tsconfig treats
    // `null` as assignable to `string` isn't something to depend on here.
    expect(() => parseAddUnitProposal(null as unknown as string)).not.toThrow();
  });
});

describe("askStudioAssist", () => {
  it("refuses an oversized payload before ever calling the network", async () => {
    const oversized = {
      model: { corners: [], layout: { walls: [], areas: [] }, items: [] },
      modelJson: "x".repeat(MAX_MODEL_JSON_BYTES + 1),
      unitCatalogSummary: [],
    };
    const result = await askStudioAssist("How many units?", oversized);
    expect(result.answer).toBe("");
    expect(result.note).toMatch(/too big/i);
  });
});
