// The signature sync PLANNER is pure: config priority is the pull's rule
// (catalog beats spec), unchanged keys are skipped, and no config means
// no signature — never a guessed one.

import { describe, expect, it } from "vitest";
import { planSignatureUpdates, storyByMarkFrom } from "./signatureSync";
import { computeSignature } from "./signature";
import type { ProjectMarkSpec } from "../install/specs";
import type { UnitConfig } from "../modelstudio/units";

function spec(mark: string, over: Partial<ProjectMarkSpec> = {}): ProjectMarkSpec {
  return {
    mark_code: mark, style: null, glass: null, color: null, size_code: null,
    width_in: 72, height_in: 48, operation: "XO", tempered: null, egress: null,
    u_factor: null, shgc: null, grids: null, screen: null, product_line: null,
    extra: null, image_page: null, image_bbox: null, planset_id: null,
    confirmed: true, source: "manual",
    id: `spec-${mark}`, project_id: "p", created_at: "", updated_at: "",
    ...over,
  };
}

describe("planSignatureUpdates", () => {
  it("catalog config beats the spec; unchanged keys are skipped", () => {
    const catalog: UnitConfig = {
      kind: "window",
      heightMm: 1200,
      panels: [
        { widthMm: 900, mechanism: "fixed" },
        { widthMm: 900, mechanism: "fixed" },
        { widthMm: 900, mechanism: "fixed" },
      ],
    };
    const catalogByMark = new Map([["7", catalog]]);
    const expected = computeSignature(catalog, { story: 2, insetOutset: null });

    const updates = planSignatureUpdates({
      openings: [
        { id: "a", opening_code: "7-1", sig_key: null },
        { id: "b", opening_code: "7-2", sig_key: expected.sigKey }, // already current
      ],
      specs: [spec("7")],
      catalogByMark,
      storyByMark: new Map([["7-1", 2], ["7-2", 2]]),
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].openingId).toBe("a");
    // Catalog's 3 fixed panels, not the spec's XO pair.
    expect(updates[0].signature.tiers[0].mix).toEqual({ fixed: 3 });
    expect(updates[0].sigKey).toBe(expected.sigKey);
  });

  it("falls to the spec when no catalog unit exists, and reads inset/outset from extra", () => {
    const updates = planSignatureUpdates({
      openings: [{ id: "a", opening_code: "9", sig_key: null }],
      specs: [spec("9", { extra: { inset_outset: "outset" } })],
      catalogByMark: new Map(),
      storyByMark: new Map(),
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].signature.insetOutset).toBe("outset");
    expect(updates[0].signature.tiers[0].mix).toEqual({ fixed: 1, slider: 1 }); // XO
    expect(updates[0].signature.tiers[0].story).toBeNull(); // untraced — honest null
  });

  it("no config, no signature — never a guess", () => {
    const updates = planSignatureUpdates({
      openings: [{ id: "a", opening_code: "99", sig_key: null }],
      specs: [],
      catalogByMark: new Map(),
      storyByMark: new Map(),
    });
    expect(updates).toHaveLength(0);
  });

  // #23: a hand-built catalog unit's 3-way control writes straight to
  // UnitConfig.insetOutset. That's the config-of-record for its mark, so
  // it should win over whatever the spec sheet says — same "catalog beats
  // spec" priority the config selection itself already follows.
  it("a catalog unit's own insetOutset wins over the spec's", () => {
    const catalog: UnitConfig = {
      kind: "window",
      heightMm: 1200,
      panels: [{ widthMm: 900, mechanism: "fixed" }],
      insetOutset: "inset",
    };
    const updates = planSignatureUpdates({
      openings: [{ id: "a", opening_code: "5", sig_key: null }],
      specs: [spec("5", { extra: { inset_outset: "outset" } })],
      catalogByMark: new Map([["5", catalog]]),
      storyByMark: new Map(),
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].signature.insetOutset).toBe("inset");
  });

  it("falls to the spec's inset/outset when the catalog config doesn't set one", () => {
    const catalog: UnitConfig = {
      kind: "window",
      heightMm: 1200,
      panels: [{ widthMm: 900, mechanism: "fixed" }],
      // insetOutset absent — every catalog unit before #23 shipped.
    };
    const updates = planSignatureUpdates({
      openings: [{ id: "a", opening_code: "5", sig_key: null }],
      specs: [spec("5", { extra: { inset_outset: "outset" } })],
      catalogByMark: new Map([["5", catalog]]),
      storyByMark: new Map(),
    });
    expect(updates[0].signature.insetOutset).toBe("outset");
  });
});

describe("storyByMarkFrom", () => {
  it("normalizes ids and defaults a windowed story to 1", () => {
    const m = storyByMarkFrom({
      windows: [
        { id: "13A", story: 2 },
        { id: "10" }, // pinned but storyless → ground
      ],
    });
    expect(m.get("13-1")).toBe(2);
    expect(m.get("10")).toBe(1);
    expect(m.get("77")).toBeUndefined(); // unpinned marks stay unknown
  });
});
