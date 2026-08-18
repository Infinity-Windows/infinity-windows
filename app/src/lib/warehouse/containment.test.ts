// The inherited-location rules, pinned client-side: the same one-level
// nesting the database trigger enforces, and the "moving a conex moves the
// crate's packages too" chain the move confirmation counts on.

import { describe, expect, it } from "vitest";
import type { StorageContainer, StoragePackage } from "../storage";
import type { Location } from "../types";
import {
  canNest,
  placeChain,
  placeLabel,
  placeWhere,
  ridesAlong,
  toLocationsById,
} from "./containment";

let seq = 0;
function ctr(over: Partial<StorageContainer>): StorageContainer {
  seq += 1;
  return {
    id: over.id ?? `ctr-${seq}`,
    serial: `CTR-${String(seq).padStart(6, "0")}`,
    name: over.name ?? `Container ${seq}`,
    address: null,
    access_code: null,
    notes: null,
    active: true,
    created_at: "2026-08-17T00:00:00Z",
    parent_container_id: null,
    location_id: null,
    ...over,
  };
}

function pkg(over: Partial<StoragePackage>): StoragePackage {
  seq += 1;
  return {
    id: `pkg-${seq}`,
    serial: `PKG-${String(seq).padStart(6, "0")}`,
    short_code: null,
    status: "stored",
    project_id: "job-1",
    category: null,
    note: null,
    delivery_id: null,
    container_id: null,
    location_id: null,
    bound_at: null,
    bound_by: null,
    created_at: "2026-08-17T00:00:00Z",
    ...over,
  };
}

const conex = ctr({ id: "conex", name: "Conex 3", location_id: "yard-spot" });
const crate = ctr({ id: "crate", name: "Crate 7", parent_container_id: "conex" });
const byId = new Map([
  ["conex", conex],
  ["crate", crate],
]);

describe("placeChain", () => {
  it("walks package → crate → conex, and the conex's spot wins", () => {
    const chain = placeChain(pkg({ container_id: "crate" }), byId);
    expect(chain.container?.name).toBe("Crate 7");
    expect(chain.parent?.name).toBe("Conex 3");
    expect(chain.locationId).toBe("yard-spot");
    expect(chain.loose).toBe(false);
    expect(placeLabel(chain)).toBe("Crate 7 — inside Conex 3");
  });

  it("a package straight in a conex reads one link", () => {
    const chain = placeChain(pkg({ container_id: "conex" }), byId);
    expect(chain.parent).toBeNull();
    expect(placeLabel(chain)).toBe("Conex 3");
  });

  it("a package on its own rack slot is placed, not loose", () => {
    const chain = placeChain(pkg({ location_id: "slot-9" }), byId);
    expect(chain.locationId).toBe("slot-9");
    expect(chain.loose).toBe(false);
    // Without the location lookup all it can honestly say is "a shelf";
    // pass the lookup and it names the shelf (see the staging-bay tests).
    expect(placeLabel(chain)).toBe("on a shelf");
  });

  it("no container and no slot is LOOSE, said plainly", () => {
    const chain = placeChain(pkg({}), byId);
    expect(chain.loose).toBe(true);
    expect(placeLabel(chain)).toBe("loose — no container, no slot");
  });
});

describe("canNest", () => {
  const all = [conex, crate, ctr({ id: "empty", name: "Crate 9" })];

  it("allows a lone crate into a top-level conex", () => {
    expect(canNest("empty", "conex", all)).toBe(true);
  });

  it("refuses a crate inside a crate — one level is as deep as it goes", () => {
    expect(canNest("empty", "crate", all)).toBe(false);
  });

  it("refuses nesting a container that holds others", () => {
    expect(canNest("conex", "empty", all)).toBe(false);
  });

  it("refuses a container inside itself", () => {
    expect(canNest("conex", "conex", all)).toBe(false);
  });
});

describe("ridesAlong", () => {
  const inCrate = pkg({ container_id: "crate" });
  const inConex = pkg({ container_id: "conex" });
  const takenOut = pkg({ container_id: "conex", status: "checked_out" });
  const elsewhere = pkg({ container_id: "other" });
  const all = [inCrate, inConex, takenOut, elsewhere];
  const containers = [conex, crate];

  it("moving the conex carries its packages AND the crate's — one action, all of them", () => {
    const riders = ridesAlong("conex", all, containers);
    expect(riders).toContain(inConex);
    expect(riders).toContain(inCrate);
    expect(riders).toHaveLength(2);
  });

  it("moving the crate carries only what is in the crate", () => {
    expect(ridesAlong("crate", all, containers)).toEqual([inCrate]);
  });

  it("checked-out packages stopped riding along when they left", () => {
    expect(ridesAlong("conex", all, containers)).not.toContain(takenOut);
  });
});

describe("staged packages name their job (ticket 08b)", () => {
  // A staging bay's rack IS the job code, character for character
  // (20260729220000). Showing "on J-BLACK22-A" makes somebody decode it;
  // naming the job is the entire point of setting material aside.
  const bay = { id: "bay-1", address: "J-BLACK22-A", zone: "J", rack: "BLACK22" };
  const shelf = { id: "shelf-1", address: "S-01-A", zone: "S", rack: "01" };
  const locs = new Map([
    [bay.id, bay],
    [shelf.id, shelf],
  ]);

  it("says which job a staged package is set aside for", () => {
    const chain = placeChain(pkg({ container_id: null, location_id: "bay-1" }), byId, locs);
    expect(placeLabel(chain)).toBe("staged for BLACK22 — J-BLACK22-A");
    expect(chain.loose).toBe(false);
  });

  it("a plain stock shelf just says the shelf", () => {
    const chain = placeChain(pkg({ container_id: null, location_id: "shelf-1" }), byId, locs);
    expect(placeLabel(chain)).toBe("on S-01-A");
  });

  it("degrades honestly when the lookup was not passed", () => {
    const chain = placeChain(pkg({ container_id: null, location_id: "bay-1" }), byId);
    expect(placeLabel(chain)).toBe("on a shelf");
  });

  it("a container still beats a location — the crate is what holds it", () => {
    const chain = placeChain(pkg({ container_id: "crate" }), byId, locs);
    expect(placeLabel(chain)).toBe("Crate 7 — inside Conex 3");
  });
});

describe("building the lookup from the rows a screen actually has", () => {
  // Every test above hands placeLabel a map somebody typed out by hand, which
  // is why "staged for BLACK22" passed its tests for weeks while no screen in
  // the app ever showed it. These two go through the rows listLocations()
  // really returns, and through the one call a display screen makes.
  const bay: Location = {
    id: "bay-1",
    zone: "J",
    rack: "BLACK22",
    slot: "A",
    address: "J-BLACK22-A",
    capacity: 4,
    active: true,
  };
  const shelf: Location = {
    id: "shelf-1",
    zone: "S",
    rack: "01",
    slot: "A",
    address: "S-01-A",
    capacity: 6,
    active: true,
  };

  it("turns a locations query straight into the lookup, no hand-trimming", () => {
    const map = toLocationsById([bay, shelf]);
    expect(map.get("bay-1")?.address).toBe("J-BLACK22-A");
    expect(map.size).toBe(2);
  });

  it("placeWhere gives the whole sentence in one call", () => {
    const map = toLocationsById([bay, shelf]);
    const staged = pkg({ container_id: null, location_id: "bay-1" });
    expect(placeWhere(staged, byId, map)).toBe("staged for BLACK22 — J-BLACK22-A");
    const onShelf = pkg({ container_id: null, location_id: "shelf-1" });
    expect(placeWhere(onShelf, byId, map)).toBe("on S-01-A");
    expect(placeWhere(pkg({ container_id: "crate" }), byId, map)).toBe(
      "Crate 7 — inside Conex 3",
    );
  });
});
