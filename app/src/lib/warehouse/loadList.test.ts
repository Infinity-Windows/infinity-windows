import { describe, expect, it } from "vitest";
import {
  buildLoadList,
  loadListStorageKey,
  parseTicked,
  serializeTicked,
} from "./loadList";

function pkg(overrides: Partial<Parameters<typeof buildLoadList>[0][number]> = {}) {
  return {
    id: "p1",
    container_id: "c1",
    piece_count: null,
    part_index: null,
    part_total: null,
    part_type: null,
    mfr_mark: null,
    package_marks: [],
    ...overrides,
  };
}

const containers = [
  { id: "c1", name: "Conex 1", serial: "CX-1", address: "100 Main St" },
  { id: "c2", name: "Conex 2", serial: "CX-2", address: null },
];

describe("buildLoadList", () => {
  it("groups packages by container, containers sorted by name", () => {
    const summary = buildLoadList(
      [
        pkg({ id: "a", container_id: "c2", mfr_mark: "6" }),
        pkg({ id: "b", container_id: "c1", mfr_mark: "5" }),
      ],
      containers,
      new Set(),
    );
    expect(summary.groups.map((g) => g.containerName)).toEqual(["Conex 1", "Conex 2"]);
  });

  it("orders packages within a container by mark then part label", () => {
    const summary = buildLoadList(
      [
        pkg({ id: "a", mfr_mark: "16", part_index: 2, part_total: 3, part_type: "glass" }),
        pkg({ id: "b", mfr_mark: "16", part_index: 1, part_total: 3, part_type: "frame" }),
        pkg({ id: "c", mfr_mark: "6", part_index: 1, part_total: 1, part_type: "frame" }),
      ],
      containers,
      new Set(),
    );
    const ids = summary.groups[0].rows.map((r) => r.id);
    // Mark 6 before mark 16 (numeric compare), then within 16, "Part 1 of 3"
    // before "Part 2 of 3".
    expect(ids).toEqual(["c", "b", "a"]);
  });

  it("counts picked and total, per container and overall", () => {
    const summary = buildLoadList(
      [
        pkg({ id: "a", container_id: "c1" }),
        pkg({ id: "b", container_id: "c1" }),
        pkg({ id: "c", container_id: "c2" }),
      ],
      containers,
      new Set(["a", "c"]),
    );
    const c1 = summary.groups.find((g) => g.containerId === "c1")!;
    const c2 = summary.groups.find((g) => g.containerId === "c2")!;
    expect(c1.pickedCount).toBe(1);
    expect(c1.totalCount).toBe(2);
    expect(c2.pickedCount).toBe(1);
    expect(c2.totalCount).toBe(1);
    expect(summary.pickedCount).toBe(2);
    expect(summary.totalCount).toBe(3);
  });

  it("marks a group complete only once every row in it is ticked", () => {
    const partial = buildLoadList(
      [pkg({ id: "a" }), pkg({ id: "b" })],
      containers,
      new Set(["a"]),
    );
    expect(partial.groups[0].complete).toBe(false);

    const full = buildLoadList(
      [pkg({ id: "a" }), pkg({ id: "b" })],
      containers,
      new Set(["a", "b"]),
    );
    expect(full.groups[0].complete).toBe(true);
  });

  it("carries a container's address, and leaves it null when unset", () => {
    const summary = buildLoadList(
      [pkg({ id: "a", container_id: "c1" }), pkg({ id: "b", container_id: "c2" })],
      containers,
      new Set(),
    );
    expect(summary.groups.find((g) => g.containerId === "c1")!.address).toBe("100 Main St");
    expect(summary.groups.find((g) => g.containerId === "c2")!.address).toBeNull();
  });

  it("marks crate-pool rows (piece_count set) and carries their count", () => {
    const summary = buildLoadList(
      [pkg({ id: "a", piece_count: 12, part_type: "glass" })],
      containers,
      new Set(),
    );
    const row = summary.groups[0].rows[0];
    expect(row.isPool).toBe(true);
    expect(row.pieceCount).toBe(12);
  });

  it("sorts a package with no container into a last, honestly-named bucket", () => {
    const summary = buildLoadList(
      [pkg({ id: "a", container_id: null }), pkg({ id: "b", container_id: "c1" })],
      containers,
      new Set(),
    );
    expect(summary.groups.map((g) => g.containerName)).toEqual(["Conex 1", "Not yet placed"]);
  });
});

describe("ticked-set persistence", () => {
  it("keys by project id", () => {
    expect(loadListStorageKey("job-42")).toBe("infinity.loadlist.job-42");
  });

  it("round-trips a set of ids", () => {
    const set = new Set(["a", "b", "c"]);
    expect(parseTicked(serializeTicked(set))).toEqual(set);
  });

  it("reads missing, corrupt, or wrongly-shaped storage as nothing ticked", () => {
    expect(parseTicked(null)).toEqual(new Set());
    expect(parseTicked("not json")).toEqual(new Set());
    expect(parseTicked(JSON.stringify({ not: "an array" }))).toEqual(new Set());
  });

  it("drops non-string entries rather than choking on them", () => {
    expect(parseTicked(JSON.stringify(["a", 1, null, "b"]))).toEqual(new Set(["a", "b"]));
  });
});
