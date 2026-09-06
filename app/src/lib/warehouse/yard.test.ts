import { describe, expect, it } from "vitest";
import type { StorageContainer, StoragePackage } from "../storage";
import { glowFromHits, yardSummary, yardTiles } from "./yard";

const NOW = new Date("2026-09-06T12:00:00Z");
const box = (id: string, name: string, kind: string, parent: string | null = null): StorageContainer => ({
  id, serial: `CTR-${id}`, name, kind, parent_container_id: parent, address: null, access_code: null,
  notes: null, active: true, created_at: "2026-08-01T00:00:00Z",
});
const pkg = (id: string, container: string | null, project: string | null, status = "stored", boundDaysAgo = 3): StoragePackage => ({
  id, serial: `PKG-${id}`, short_code: null, status: status as StoragePackage["status"], project_id: project,
  category: null, note: null, delivery_id: null, container_id: container,
  bound_at: new Date(NOW.getTime() - boundDaysAgo * 86_400_000).toISOString(), bound_by: null,
  created_at: "2026-08-10T00:00:00Z",
});
const jobs = new Map([["j1", "BLACK22"], ["j2", "PECAN14"]]);

describe("the yard draws every box in reading order", () => {
  const containers = [
    box("c12", "Conex 12", "conex"),
    box("c7", "Conex 7", "conex"),
    box("main", "Main warehouse", "building"),
    box("t2", "Truck 2", "truck"),
    box("cr", "Crate 12", "crate", "c7"),
  ];
  it("building first, conexes by number, trucks after, crates inside their box", () => {
    const tiles = yardTiles(containers, [], jobs, NOW);
    expect(tiles.map((t) => t.name)).toEqual(["Main warehouse", "Conex 7", "Conex 12", "Truck 2"]);
    expect(tiles[1].children.map((c) => c.name)).toEqual(["Crate 12"]);
  });
  it("counts what is stored in each box and stripes it by job, biggest job first", () => {
    const tiles = yardTiles(containers, [
      pkg("a", "c7", "j1"), pkg("b", "c7", "j1"), pkg("c", "c7", "j2"),
      pkg("d", "c7", "j1", "received"), // arrived but not put away: not inside
      pkg("e", "cr", null),
    ], jobs, NOW);
    const c7 = tiles.find((t) => t.name === "Conex 7")!;
    expect(c7.inside).toBe(3);
    expect(c7.jobs.map((j) => [j.jobCode, j.count])).toEqual([["BLACK22", 2], ["PECAN14", 1]]);
    expect(c7.children[0].jobs[0].jobCode).toBe("Boneyard");
  });
  it("remembers how long the oldest package has sat", () => {
    const tiles = yardTiles(containers, [pkg("a", "c7", "j1", "stored", 26), pkg("b", "c7", "j1", "stored", 2)], jobs, NOW);
    expect(tiles.find((t) => t.name === "Conex 7")!.oldestDays).toBe(26);
  });
  it("lights the box Find points at, and the box around a lit crate", () => {
    const tiles = yardTiles(containers, [], jobs, NOW, new Set(["cr"]));
    expect(tiles.find((t) => t.name === "Conex 7")!.glow).toBe(true);
    expect(tiles.find((t) => t.name === "Conex 12")!.glow).toBe(false);
  });
  it("leaves archived boxes off the yard", () => {
    const tiles = yardTiles([{ ...box("x", "Old conex", "conex"), active: false }], [], jobs, NOW);
    expect(tiles).toEqual([]);
  });
});

describe("what a Find answer lights up", () => {
  it("the boxes holding stored hits, and the box itself when the answer is a box", () => {
    const glow = glowFromHits(
      [{ pkg: { container_id: "c7", status: "stored" } }, { pkg: { container_id: "c3", status: "checked_out" } }],
      "main",
    );
    expect([...glow].sort()).toEqual(["c7", "main"]);
  });
});

describe("the line under the yard", () => {
  it("adds up packages across boxes and crates", () => {
    const tiles = yardTiles(
      [box("c7", "Conex 7", "conex"), box("cr", "Crate 12", "crate", "c7")],
      [pkg("a", "c7", "j1"), pkg("b", "cr", "j2")],
      jobs, NOW,
    );
    expect(yardSummary(tiles)).toBe("2 packages in 1 box · 2 jobs");
  });
  it("says so when there are no boxes", () => {
    expect(yardSummary([])).toMatch(/No boxes yet/);
  });
});
