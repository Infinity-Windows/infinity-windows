import { describe, expect, it } from "vitest";
import { splitLines, splitLinesOnStore, splitUnits } from "./splitUnits";
import type { StorageContainer, StoragePackage } from "../storage";

let seq = 0;
const pkg = (over: Partial<StoragePackage> & { marks?: string[] }): StoragePackage => {
  const { marks, ...rest } = over;
  seq += 1;
  return {
    id: over.id ?? `p${seq}`,
    serial: `PKG-${seq}`,
    short_code: null,
    status: "stored",
    project_id: "job-1",
    category: null,
    note: null,
    delivery_id: null,
    container_id: "conex-3",
    location_id: null,
    bound_at: null,
    bound_by: null,
    created_at: "",
    package_marks: (marks ?? ["16"]).map((mark_code) => ({ mark_code })),
    ...rest,
  } as StoragePackage;
};

const containers = new Map<string, StorageContainer>([
  ["conex-3", { id: "conex-3", name: "Conex 3" } as StorageContainer],
  ["conex-7", { id: "conex-7", name: "Conex 7" } as StorageContainer],
  ["conex-9", { id: "conex-9", name: "Conex 9" } as StorageContainer],
  ["crate-1", { id: "crate-1", name: "BLACK22 · Crate 1", kind: "crate" } as StorageContainer],
]);
const locations = new Map();

describe("the standing count (ticket 19)", () => {
  it("a window with parts in two boxes is split", () => {
    const rows = [
      pkg({ container_id: "conex-3", part_index: 1, part_total: 2 }),
      pkg({ container_id: "conex-7", part_index: 2, part_total: 2 }),
    ];
    const split = splitUnits(rows, containers, locations);
    expect(split).toHaveLength(1);
    expect(split[0].markCode).toBe("16");
    expect(split[0].places).toEqual(["Conex 3", "Conex 7"]);
  });

  it("a window all in one box is not split", () => {
    const rows = [pkg({}), pkg({})];
    expect(splitUnits(rows, containers, locations)).toHaveLength(0);
  });

  it("a checked-out part does not make a window split — that is mid-install", () => {
    const rows = [
      pkg({}),
      pkg({ status: "checked_out", container_id: null }),
    ];
    expect(splitUnits(rows, containers, locations)).toHaveLength(0);
  });

  it("a stored part plus a loose part IS split — loose is a place", () => {
    const rows = [pkg({}), pkg({ container_id: null })];
    const split = splitUnits(rows, containers, locations);
    expect(split).toHaveLength(1);
  });

  it("a minted label on a boat does not split anything", () => {
    const rows = [pkg({}), pkg({ status: "minted", container_id: null })];
    expect(splitUnits(rows, containers, locations)).toHaveLength(0);
  });
});

describe("the moment-of-tap lines (ticket 19)", () => {
  it("taking one of two names where the other stays", () => {
    const a = pkg({ id: "take-me" });
    const b = pkg({});
    const lines = splitLines(new Set(["take-me"]), [a, b], containers, locations);
    expect(lines).toEqual([
      "Window 16 — taking 1 of its 2 parts here; the other 1 stays at Conex 3.",
    ]);
  });

  it("taking the whole window says nothing", () => {
    const a = pkg({ id: "x1" });
    const b = pkg({ id: "x2" });
    expect(splitLines(new Set(["x1", "x2"]), [a, b], containers, locations)).toEqual([]);
  });

  it("a window with one part says nothing — there is nothing to split", () => {
    const a = pkg({ id: "solo" });
    expect(splitLines(new Set(["solo"]), [a], containers, locations)).toEqual([]);
  });
});

describe("the store-time warning, read the other way (owner call)", () => {
  it("names the other part's box using the piece's own numbers", () => {
    const incoming = pkg({
      id: "incoming", status: "received", container_id: null, part_index: 1, part_total: 2,
    });
    const elsewhere = pkg({ id: "elsewhere", container_id: "conex-7", part_index: 2, part_total: 2 });
    const lines = splitLinesOnStore(
      new Set(["incoming"]), [incoming, elsewhere], "conex-3", containers, locations,
    );
    expect(lines).toEqual(["Part 1 of 2 — the other 1 part is at Conex 7."]);
  });

  it("falls back to the window number when nothing carries a part number", () => {
    const incoming = pkg({ id: "incoming", status: "received", container_id: null });
    const elsewhere = pkg({ id: "elsewhere", container_id: "conex-7" });
    const lines = splitLinesOnStore(
      new Set(["incoming"]), [incoming, elsewhere], "conex-3", containers, locations,
    );
    expect(lines).toEqual(["Window 16 — the other 1 part is at Conex 7."]);
  });

  it("storing every on-hand sibling into the same box together is not a split", () => {
    const a = pkg({ id: "a", status: "received", container_id: null, part_index: 1, part_total: 2 });
    const b = pkg({ id: "b", status: "received", container_id: null, part_index: 2, part_total: 2 });
    expect(splitLinesOnStore(new Set(["a", "b"]), [a, b], "conex-3", containers, locations)).toEqual([]);
  });

  it("a sibling already sitting in the destination doesn't count as elsewhere", () => {
    const incoming = pkg({
      id: "incoming", status: "received", container_id: null, part_index: 1, part_total: 2,
    });
    const alreadyHere = pkg({ id: "already-here", container_id: "conex-3", part_index: 2, part_total: 2 });
    expect(
      splitLinesOnStore(new Set(["incoming"]), [incoming, alreadyHere], "conex-3", containers, locations),
    ).toEqual([]);
  });

  it("a window with only the incoming piece on hand says nothing", () => {
    const solo = pkg({ id: "solo", status: "received", container_id: null });
    expect(splitLinesOnStore(new Set(["solo"]), [solo], "conex-3", containers, locations)).toEqual([]);
  });

  it("a checked-out piece coming back in still reads by its own part number", () => {
    // Its CURRENT status is checked_out — not on-hand — but it is still the
    // thing being stored, and its part number is still its part number.
    const returning = pkg({
      id: "returning", status: "checked_out", container_id: null, part_index: 2, part_total: 2,
    });
    const elsewhere = pkg({ id: "elsewhere", container_id: "conex-7", part_index: 1, part_total: 2 });
    const lines = splitLinesOnStore(
      new Set(["returning"]), [returning, elsewhere], "conex-3", containers, locations,
    );
    expect(lines).toEqual(["Part 2 of 2 — the other 1 part is at Conex 7."]);
  });

  it("siblings scattered across more than one other box read as one phrase", () => {
    const incoming = pkg({
      id: "incoming", status: "received", container_id: null, part_index: 1, part_total: 3,
    });
    const b = pkg({ id: "b", container_id: "conex-7", part_index: 2, part_total: 3 });
    const c = pkg({ id: "c", container_id: "conex-9", part_index: 3, part_total: 3 });
    const lines = splitLinesOnStore(
      new Set(["incoming"]), [incoming, b, c], "conex-3", containers, locations,
    );
    expect(lines).toEqual(["Part 1 of 3 — the other 2 parts are in more than one place."]);
  });

  // The two false alarms the field caught (owner report, 2026-08-26):
  // loose siblings at the door and glass riding in the job's own crate are
  // NOT "another place" — the warning cried wolf on every multi-part
  // check-in.
  it("a LOOSE arrived sibling waiting its turn is not a split", () => {
    const incoming = pkg({
      id: "incoming", status: "received", container_id: null, part_index: 1, part_total: 2,
    });
    const atTheDoor = pkg({
      id: "door", status: "received", container_id: null, part_index: 2, part_total: 2,
    });
    expect(
      splitLinesOnStore(new Set(["incoming"]), [incoming, atTheDoor], "conex-3", containers, locations),
    ).toEqual([]);
  });

  it("glass riding in the job's own crate is not a split", () => {
    const incoming = pkg({
      id: "incoming", status: "received", container_id: null, part_index: 1, part_total: 2,
    });
    const inCrate = pkg({ id: "crated", status: "stored", container_id: "crate-1", part_index: 2, part_total: 2 });
    expect(
      splitLinesOnStore(new Set(["incoming"]), [incoming, inCrate], "conex-3", containers, locations),
    ).toEqual([]);
  });

  it("a sibling on a named shelf still counts — a shelf is a committed spot", () => {
    const incoming = pkg({
      id: "incoming", status: "received", container_id: null, part_index: 1, part_total: 2,
    });
    const shelved = pkg({
      id: "shelved", status: "stored", container_id: null, location_id: "slot-1", part_index: 2, part_total: 2,
    });
    const lines = splitLinesOnStore(
      new Set(["incoming"]), [incoming, shelved], "conex-3", containers, locations,
    );
    expect(lines).toHaveLength(1);
  });
});
