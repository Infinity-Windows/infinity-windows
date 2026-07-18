import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getOpeningMarkerScale,
  openingMarkerStyle,
  setOpeningMarkerScale,
} from "./openingMarkerScale";

describe("opening marker scale", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
  });

  it("defaults to 1 and persists a rounded scale", () => {
    expect(getOpeningMarkerScale("w1")).toBe(1);
    expect(setOpeningMarkerScale("w1", 1.26)).toBe(1.3);
    expect(getOpeningMarkerScale("w1")).toBe(1.3);
  });

  it("clamps markers between 60% and 200%", () => {
    expect(setOpeningMarkerScale("small", 0.1)).toBe(0.6);
    expect(setOpeningMarkerScale("large", 5)).toBe(2);
  });

  it("centers the scaled marker over its plan coordinate", () => {
    setOpeningMarkerScale("w1", 1.5);
    expect(openingMarkerStyle("w1")).toMatchObject({
      width: 45,
      height: 45,
      marginLeft: -22.5,
      marginTop: -22.5,
    });
  });
});
