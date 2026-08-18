import { describe, expect, it } from "vitest";
import { modelBounds, zoneRect } from "./ContainerViewer";
import { buildShellSerialized } from "../../lib/modelstudio/shell";

describe("the viewer's zone math (ticket 22, slice 3)", () => {
  const shell = buildShellSerialized({ lengthCm: 600, widthCm: 240, heightCm: 259 });
  const bounds = modelBounds(shell)!;

  it("reads the footprint off the generated shell exactly", () => {
    expect(bounds).toEqual({ minX: 0, maxX: 600, minY: 0, maxY: 240 });
  });

  it("front is the +x (door) third of a movable box — ADR-0006's promise", () => {
    expect(zoneRect(bounds, "front", "conex")).toEqual({
      x0: 400, x1: 600, y0: 0, y1: 240,
    });
    expect(zoneRect(bounds, "back", "conex")).toEqual({
      x0: 0, x1: 200, y0: 0, y1: 240,
    });
  });

  it("a compass area inside a conex answers nothing — it would be a lie", () => {
    expect(zoneRect(bounds, "northeast", "conex")).toBeNull();
  });

  it("the building gets the 3×3 grid, north at -y", () => {
    expect(zoneRect(bounds, "northwest", "building")).toEqual({
      x0: 0, x1: 200, y0: 0, y1: 80,
    });
    expect(zoneRect(bounds, "middle", "building")).toEqual({
      x0: 200, x1: 400, y0: 80, y1: 160,
    });
    expect(zoneRect(bounds, "southeast", "building")).toEqual({
      x0: 400, x1: 600, y0: 160, y1: 240,
    });
  });

  it("junk never draws a glow", () => {
    expect(zoneRect(bounds, "mezzanine", "building")).toBeNull();
    expect(modelBounds("not json")).toBeNull();
    expect(modelBounds("{}")).toBeNull();
  });
});
