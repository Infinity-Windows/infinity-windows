// Studio 100x #45/#46: the whole point of this catalog is that it's local.
// A guard, not a design doc — if someone later "helpfully" points a finish
// at a CDN thumbnail, this fails instead of quietly reintroducing the bug
// #45 removed.

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FLOOR_FINISHES, WALL_FINISHES, finishForUrl } from "./finishes";

describe("finish catalog stays local", () => {
  it("every wall + floor finish is a same-origin /modelstudio/ path", () => {
    for (const f of [...WALL_FINISHES, ...FLOOR_FINISHES]) {
      expect(f.url.startsWith("/modelstudio/textures/")).toBe(true);
      expect(f.url).not.toMatch(/^https?:\/\//);
    }
  });

  it("has exactly the lean set the spec calls for — 4 wall, 2 floor", () => {
    expect(WALL_FINISHES).toHaveLength(4);
    expect(FLOOR_FINISHES).toHaveLength(2);
  });

  it("ids are unique within each catalog", () => {
    expect(new Set(WALL_FINISHES.map((f) => f.id)).size).toBe(WALL_FINISHES.length);
    expect(new Set(FLOOR_FINISHES.map((f) => f.id)).size).toBe(FLOOR_FINISHES.length);
  });

  it("every referenced texture file actually exists under app/public", () => {
    // vite serves /modelstudio/textures/* straight out of app/public — a
    // typo'd path here wouldn't fail the build (it's a plain string, not
    // an import), only a broken swatch at runtime.
    for (const f of [...WALL_FINISHES, ...FLOOR_FINISHES]) {
      expect(existsSync(`public${f.url}`)).toBe(true);
    }
  });
});

describe("finishForUrl", () => {
  it("matches a saved texture back to its catalog entry", () => {
    const wood = FLOOR_FINISHES.find((f) => f.id === "wood")!;
    expect(finishForUrl(FLOOR_FINISHES, wood.url)).toEqual(wood);
  });

  it("returns null for an unrecognized or missing url", () => {
    expect(finishForUrl(WALL_FINISHES, "/modelstudio/textures/not-a-real-one.png")).toBeNull();
    expect(finishForUrl(WALL_FINISHES, null)).toBeNull();
    expect(finishForUrl(WALL_FINISHES, undefined)).toBeNull();
  });
});
