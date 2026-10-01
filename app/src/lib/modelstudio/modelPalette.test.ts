import { describe, expect, it } from "vitest";
import { MODEL_PALETTE, wallTintForTexture } from "./modelPalette";

describe("model wall finishes", () => {
  it("warms only the bundled default and leaves saved texture colors intact", () => {
    expect(wallTintForTexture("/modelstudio/textures/wall-white.png")).toBe(MODEL_PALETTE.wall);
    expect(wallTintForTexture("/modelstudio/textures/wall-brick.png")).toBe(0xffffff);
    expect(wallTintForTexture("https://example.test/custom-finish.png")).toBe(0xffffff);
  });
});
