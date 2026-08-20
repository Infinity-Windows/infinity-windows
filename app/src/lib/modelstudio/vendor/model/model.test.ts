// Studio 100x #46: wall and floor finishes ride the vendor's OWN
// wall.frontTexture/backTexture fields and Floorplan's floor-texture map —
// nothing new to serialize. This pins that the vendor really does carry
// both through a save/load round trip, independent of anything the app
// layer does with them.

import { describe, expect, it } from "vitest";
import { Model } from "./model";

/** A single closed rectangle — the simplest shape that forms one Room. */
function rectSerialized(): string {
  const corners = {
    a: { x: 0, y: 0 },
    b: { x: 500, y: 0 },
    c: { x: 500, y: 400 },
    d: { x: 0, y: 400 },
  };
  const walls = [
    { corner1: "a", corner2: "b", height: 250 },
    { corner1: "b", corner2: "c", height: 250 },
    { corner1: "c", corner2: "d", height: 250 },
    { corner1: "d", corner2: "a", height: 250 },
  ];
  return JSON.stringify({ floorplan: { corners, walls }, items: [] });
}

describe("wall + floor finish round trip", () => {
  it("keeps a wall's chosen finish through save -> load", () => {
    const model = new Model("/modelstudio/");
    model.loadSerialized(rectSerialized());
    const wall = model.floorplan.getWalls()[0];
    const finish = { url: "/modelstudio/textures/wall-brick.png", stretch: true, scale: 0 };
    wall.frontTexture = finish;
    wall.backTexture = finish;

    const reloaded = new Model("/modelstudio/");
    reloaded.loadSerialized(model.exportSerialized());

    const reloadedWall = reloaded.floorplan.getWalls()[0];
    expect(reloadedWall.frontTexture).toEqual(finish);
    expect(reloadedWall.backTexture).toEqual(finish);
  });

  it("leaves other walls on their default finish untouched", () => {
    const model = new Model("/modelstudio/");
    model.loadSerialized(rectSerialized());
    const [first, second] = model.floorplan.getWalls();
    first.frontTexture = { url: "/modelstudio/textures/wall-stucco.png", stretch: true, scale: 0 };

    const reloaded = new Model("/modelstudio/");
    reloaded.loadSerialized(model.exportSerialized());

    expect(reloaded.floorplan.getWalls()[0].frontTexture.url).toBe(
      "/modelstudio/textures/wall-stucco.png",
    );
    expect(reloaded.floorplan.getWalls()[1].frontTexture.url).toBe(second.frontTexture.url);
  });

  it("keeps a room's chosen floor finish through save -> load", () => {
    const model = new Model("/modelstudio/");
    model.loadSerialized(rectSerialized());
    const rooms = model.floorplan.getRooms();
    expect(rooms.length).toBe(1); // the closed rectangle forms exactly one room
    rooms[0].setTexture("/modelstudio/textures/concrete.png", false, 300);

    const reloaded = new Model("/modelstudio/");
    reloaded.loadSerialized(model.exportSerialized());

    const reloadedRooms = reloaded.floorplan.getRooms();
    expect(reloadedRooms).toHaveLength(1);
    expect(reloadedRooms[0].getTexture()).toEqual({
      url: "/modelstudio/textures/concrete.png",
      scale: 300,
    });
  });
});
