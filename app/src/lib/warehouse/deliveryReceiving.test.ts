import { describe, expect, it } from "vitest";
import {
  groupDelivery,
  groupRowsByType,
  missingSummary,
  pickToReceive,
  pickToReceiveGroup,
  pickToStore,
  pickToUndo,
  pickToUnstore,
  setForMark,
  type DeliveryPackageLite,
} from "./deliveryReceiving";

let seq = 0;
const pkg = (over: Partial<DeliveryPackageLite>): DeliveryPackageLite => ({
  id: `p-${++seq}`,
  status: "minted",
  project_id: null,
  pending_job_name: "Sunset Ridge 4",
  mfr_mark: "5050",
  part_index: 1,
  part_total: 3,
  part_type: null,
  piece_count: null,
  container_id: null,
  ...over,
});

describe("groupDelivery", () => {
  it("groups identical clone boxes into one row and keeps crate pieces separate", () => {
    const packages = [
      pkg({}),
      pkg({}),
      pkg({ part_index: 2 }),
      pkg({ piece_count: 4, part_index: null, part_total: null, part_type: "glass" }),
    ];
    const groups = groupDelivery(packages);
    expect(groups).toHaveLength(1);
    const labels = groups[0].rows.map((r) => `${r.label} ×${r.expected}`);
    expect(labels).toEqual([
      "Sunset Ridge 4 · #5050 — 1/3 ×2",
      "Sunset Ridge 4 · #5050 — 2/3 ×1",
      "Sunset Ridge 4 · #5050 — 4 pieces of glass (in the crates) ×1",
    ]);
    expect(groups[0].pendingJobName).toBe("Sunset Ridge 4");
    expect(groups[0].unfiledIds).toHaveLength(4);
  });

  it("splits real jobs from pending names, resolves titles, counts states", () => {
    const groups = groupDelivery(
      [
        pkg({ project_id: "job-1", pending_job_name: null, status: "received" }),
        pkg({ project_id: "job-1", pending_job_name: null, status: "stored" }),
        pkg({ status: "minted" }),
      ],
      (id) => (id === "job-1" ? "ESH-18" : null),
    );
    expect(groups).toHaveLength(2);
    const real = groups.find((g) => g.projectId === "job-1")!;
    expect(real.rows[0]).toMatchObject({ expected: 2, received: 2, stored: 1 });
    expect(real.rows[0].label).toBe("ESH-18 · #5050 — 1/3");
    expect(real.unfiledIds).toHaveLength(0);
  });
});

describe("pickers", () => {
  it("hand back any n twins — expected for receiving, loose for storing", () => {
    const groups = groupDelivery([
      pkg({ id: "a" }),
      pkg({ id: "b" }),
      pkg({ id: "c", status: "received" }),
      pkg({ id: "d", status: "received" }),
      pkg({ id: "e", status: "stored" }),
    ]);
    const row = groups[0].rows[0];
    expect(pickToReceive(row, 1)).toEqual(["a"]);
    expect(pickToReceive(row, 9)).toEqual(["a", "b"]);
    expect(pickToStore(row, 9)).toEqual(["c", "d"]);
  });
});

describe("pickToUndo", () => {
  it("undoes the most recent arrivals: loose received, and crate pieces that auto-stored", () => {
    const groups = groupDelivery([
      pkg({ id: "a", status: "received" }),
      pkg({ id: "b", status: "received" }),
      pkg({ id: "c", status: "stored" }), // stored in a conex: NOT undoable
      pkg({
        id: "k",
        status: "stored",
        piece_count: 4,
        part_index: null,
        part_total: null,
        part_type: "glass",
        container_id: "crate-1",
      }),
    ]);
    const boxRow = groups[0].rows.find((r) => !r.isCrate)!;
    expect(pickToUndo(boxRow, 1)).toEqual(["b"]);
    expect(pickToUndo(boxRow, 9)).toEqual(["a", "b"]);
    const crateRow = groups[0].rows.find((r) => r.isCrate)!;
    expect(pickToUndo(crateRow, 1)).toEqual(["k"]);
  });
});

describe("pickToUnstore", () => {
  it("pulls the most recent non-crate put-aways back", () => {
    const groups = groupDelivery([
      pkg({ id: "s1", status: "stored" }),
      pkg({ id: "s2", status: "stored" }),
      pkg({ id: "r1", status: "received" }),
    ]);
    const row = groups[0].rows[0];
    expect(row.storedIds).toEqual(["s1", "s2"]);
    expect(pickToUnstore(row, 1)).toEqual(["s2"]);
    expect(pickToUnstore(row, 9)).toEqual(["s1", "s2"]);
  });
});

describe("groupRowsByType — wave R, collapse the fifteen-card wall", () => {
  it("collapses many individually numbered expected slots of the same type into one group", () => {
    const packages = Array.from({ length: 15 }, (_, i) =>
      pkg({ id: `p${i + 1}`, part_index: i + 1, part_total: 15, part_type: "glass" }),
    );
    const groups = groupDelivery(packages);
    const typeGroups = groupRowsByType(groups[0].rows);
    expect(typeGroups).toHaveLength(1);
    expect(typeGroups[0]).toMatchObject({ mark: "5050", partType: "glass", missing: 15, received: 0 });
    expect(typeGroups[0].rows).toHaveLength(15);
    expect(typeGroups[0].expectedIds).toHaveLength(15);
  });

  it("keeps a single-row type ungrouped in spirit — one row in, one row out", () => {
    const groups = groupDelivery([pkg({ part_type: "frame" })]);
    const typeGroups = groupRowsByType(groups[0].rows);
    expect(typeGroups).toHaveLength(1);
    expect(typeGroups[0].rows).toHaveLength(1);
  });

  it("keeps different part types, and untyped slots, in their own groups", () => {
    const packages = [
      pkg({ id: "f1", part_index: 1, part_total: 5, part_type: "frame" }),
      pkg({ id: "f2", part_index: 2, part_total: 5, part_type: "frame" }),
      pkg({ id: "u1", part_index: 3, part_total: 5, part_type: null }),
      pkg({ id: "u2", part_index: 4, part_total: 5, part_type: null }),
    ];
    const groups = groupDelivery(packages);
    const typeGroups = groupRowsByType(groups[0].rows).sort((a, b) =>
      (a.partType ?? "").localeCompare(b.partType ?? ""),
    );
    expect(typeGroups).toHaveLength(2);
    expect(typeGroups[0]).toMatchObject({ partType: null, missing: 2 });
    expect(typeGroups[1]).toMatchObject({ partType: "frame", missing: 2 });
  });

  it("never mixes boxes and crate-pool pieces of the same type into one group", () => {
    const packages = [
      pkg({ id: "b1", part_index: 1, part_total: 2, part_type: "glass" }),
      pkg({ id: "b2", part_index: 2, part_total: 2, part_type: "glass" }),
      pkg({
        id: "c1",
        part_index: null,
        part_total: null,
        piece_count: 12,
        part_type: "glass",
      }),
    ];
    const groups = groupDelivery(packages);
    const typeGroups = groupRowsByType(groups[0].rows);
    expect(typeGroups).toHaveLength(2);
    expect(typeGroups.find((g) => g.isCrate)?.rows).toHaveLength(1);
    expect(typeGroups.find((g) => !g.isCrate)?.rows).toHaveLength(2);
  });

  it("counts arrived alongside still-missing on a partially arrived group", () => {
    const packages = [
      pkg({ id: "a1", part_index: 1, part_total: 3, part_type: "frame", status: "received" }),
      pkg({ id: "a2", part_index: 2, part_total: 3, part_type: "frame" }),
      pkg({ id: "a3", part_index: 3, part_total: 3, part_type: "frame" }),
    ];
    const groups = groupDelivery(packages);
    const typeGroups = groupRowsByType(groups[0].rows);
    expect(typeGroups[0]).toMatchObject({ missing: 2, received: 1 });
  });
});

describe("pickToReceiveGroup", () => {
  it("takes the lowest part_index first across every member row", () => {
    const packages = [
      pkg({ id: "p3", part_index: 3, part_total: 3, part_type: "glass" }),
      pkg({ id: "p1", part_index: 1, part_total: 3, part_type: "glass" }),
      pkg({ id: "p2", part_index: 2, part_total: 3, part_type: "glass" }),
    ];
    const groups = groupDelivery(packages);
    const [group] = groupRowsByType(groups[0].rows);
    expect(pickToReceiveGroup(group, 1)).toEqual(["p1"]);
    expect(pickToReceiveGroup(group, 2)).toEqual(["p1", "p2"]);
    expect(pickToReceiveGroup(group, 99)).toEqual(["p1", "p2", "p3"]);
  });
});

describe("missingSummary", () => {
  it("says exactly what never came off the truck", () => {
    const groups = groupDelivery([
      pkg({ status: "received" }),
      pkg({}),
      pkg({}),
      pkg({ part_index: 2, status: "received" }),
    ]);
    const s = missingSummary(groups);
    expect(s).toMatchObject({ expected: 4, received: 2, missing: 2 });
    expect(s.lines).toEqual(["Sunset Ridge 4 · #5050 — 1/3: 2 of 3 still missing"]);
  });
});

describe("setForMark", () => {
  it("gathers every slot and every id of one mark, whatever the state", () => {
    const packages = [
      pkg({ id: "a", mfr_mark: "4", part_index: 1, part_total: 7 }),
      pkg({ id: "b", mfr_mark: "4", part_index: 2, part_total: 7, status: "received" }),
      pkg({ id: "c", mfr_mark: "4", part_index: 3, part_total: 7, status: "stored" }),
      // Checked out: in none of the action id lists, but the set editor
      // still renames and deletes through it.
      pkg({ id: "d", mfr_mark: "4", part_index: 4, part_total: 7, status: "checked_out" }),
      pkg({ id: "e", mfr_mark: "1" }),
    ];
    const g = groupDelivery(packages)[0];
    const set = setForMark(g, "4");
    expect(set.slots).toHaveLength(4);
    expect([...set.allIds].sort()).toEqual(["a", "b", "c", "d"]);
    expect(set.expected).toBe(4);
    expect(set.arrived).toBe(3);
    expect(set.stored).toBe(2);
  });

  it("an unknown mark comes back empty, not a crash", () => {
    const g = groupDelivery([pkg({})])[0];
    const set = setForMark(g, "999");
    expect(set.slots).toEqual([]);
    expect(set.allIds).toEqual([]);
  });
});
