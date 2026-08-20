import { describe, expect, it } from "vitest";
import { roMismatchWarning } from "./roMismatch";
import type { UnitConfig } from "../modelstudio/units";

const flat = (widthIn: number, heightIn: number): UnitConfig => ({
  kind: "window",
  heightMm: heightIn * 25.4,
  panels: [{ widthMm: widthIn * 25.4, mechanism: "fixed" }],
});

describe("roMismatchWarning", () => {
  it("nothing to say when the gap is within roCheck's range", () => {
    const cfg = flat(36, 72);
    // 3/8" over on both axes — within the 1/8"-1/2" band.
    expect(
      roMismatchWarning({ ro_width_in: 36.375, ro_height_in: 72.375 }, cfg),
    ).toBeNull();
  });

  it("flags a will-not-fit gap when the RO is smaller than the unit", () => {
    const cfg = flat(36, 72);
    const msg = roMismatchWarning({ ro_width_in: 35.9, ro_height_in: 72.375 }, cfg);
    expect(msg).toMatch(/width/);
    expect(msg).toMatch(/will not go in/);
  });

  it("flags an oversized gap past the 1/2\" maximum", () => {
    const cfg = flat(36, 72);
    const msg = roMismatchWarning({ ro_width_in: 36.375, ro_height_in: 73 }, cfg);
    expect(msg).toMatch(/height/);
    expect(msg).toMatch(/oversized/);
  });

  it("flags too-tight the other direction: a gap under 1/8\" but still positive", () => {
    const cfg = flat(36, 72);
    const msg = roMismatchWarning({ ro_width_in: 36.0625, ro_height_in: 72.375 }, cfg);
    expect(msg).toMatch(/width/);
    expect(msg).toMatch(/minimum to shim/);
  });

  it("both axes can fail at once, joined into one sentence", () => {
    const cfg = flat(36, 72);
    const msg = roMismatchWarning({ ro_width_in: 35.9, ro_height_in: 73 }, cfg);
    expect(msg).toMatch(/width/);
    expect(msg).toMatch(/height/);
  });

  it("says nothing when either RO number hasn't been measured yet", () => {
    const cfg = flat(36, 72);
    expect(
      roMismatchWarning({ ro_width_in: null, ro_height_in: 72.375 }, cfg),
    ).toBeNull();
    expect(
      roMismatchWarning({ ro_width_in: 36.375, ro_height_in: null }, cfg),
    ).toBeNull();
  });

  it("says nothing for a corner unit — no single RO to judge a wrapped unit against", () => {
    const cfg: UnitConfig = {
      kind: "window",
      heightMm: 2000,
      panels: [
        { widthMm: 800, mechanism: "fixed" },
        { widthMm: 2400, mechanism: "fixed" },
      ],
      cornerAfterPanel: 0,
    };
    expect(roMismatchWarning({ ro_width_in: 1, ro_height_in: 1 }, cfg)).toBeNull();
  });
});
