import { describe, expect, it } from "vitest";
import {
  areaLabel,
  areaOptions,
  areaSuffix,
  areaZoneOptions,
  BUILDING_AREAS,
  MOVABLE_AREAS,
  MOVABLE_ZONE_AREAS,
} from "./areas";
import type { StorageContainer } from "../storage";

const box = (kind?: string) => ({ kind }) as StorageContainer;

describe("areaOptions follows the kind of the box", () => {
  it("anything that moves gets the door-relative three, never a compass", () => {
    for (const kind of ["conex", "crate", "truck"]) {
      expect(areaOptions(box(kind))).toEqual(MOVABLE_AREAS);
    }
  });

  it("only the building earns the compass", () => {
    expect(areaOptions(box("building"))).toEqual(BUILDING_AREAS);
  });

  it("a row from before the kinds migration is a conex, so no compass", () => {
    expect(areaOptions(box(undefined))).toEqual(MOVABLE_AREAS);
  });

  it("no box, no options — an area is where INSIDE the box it sits", () => {
    expect(areaOptions(null)).toEqual([]);
  });
});

describe("areaZoneOptions offers the six finer zones only where they fit (owner call)", () => {
  it("anything that moves gets the six zones, on top of the plain three", () => {
    for (const kind of ["conex", "crate", "truck"]) {
      expect(areaZoneOptions(box(kind))).toEqual(MOVABLE_ZONE_AREAS);
    }
  });

  it("the building keeps only its compass — no finer zones", () => {
    expect(areaZoneOptions(box("building"))).toEqual([]);
  });

  it("no box, no zones", () => {
    expect(areaZoneOptions(null)).toEqual([]);
  });
});

describe("areas read as words", () => {
  it("the front names the door, because that is how you find it", () => {
    expect(areaLabel("front")).toBe("Front (door end)");
  });

  it("a six-zone value reads as two plain words", () => {
    expect(areaLabel("front-left")).toBe("Front Left");
    expect(areaLabel("back-right")).toBe("Back Right");
  });

  it("suffixes stay short: the sentence is 'Conex 7 — front'", () => {
    expect(areaSuffix("front")).toBe(" — front");
    expect(areaSuffix("northeast")).toBe(" — northeast");
    expect(areaSuffix(null)).toBe("");
  });

  it("an unknown value passes through instead of crashing", () => {
    expect(areaLabel("mezzanine")).toBe("mezzanine");
  });
});
