// The Find bar's promise: any identifier, one physical answer, and a miss
// that says what to do next rather than "no results".

import { describe, expect, it } from "vitest";
import type { StorageContainer, StoragePackage } from "../storage";
import { answerHeadline, findInWarehouse, type FindInputs } from "./find";

let seq = 0;
function pkg(over: Partial<StoragePackage> & { marks?: string[] }): StoragePackage {
  const { marks, ...rest } = over;
  seq += 1;
  return {
    id: `pkg-${seq}`,
    serial: `PKG-00000${seq}`,
    short_code: null,
    status: "stored",
    project_id: "job-1",
    category: null,
    note: null,
    delivery_id: null,
    container_id: "conex",
    location_id: null,
    bound_at: null,
    bound_by: null,
    created_at: "2026-08-17T00:00:00Z",
    package_marks: (marks ?? []).map((mark_code) => ({ mark_code })),
    ...rest,
  };
}

const conex: StorageContainer = {
  id: "conex",
  serial: "CTR-000001",
  name: "Conex 3",
  address: null,
  access_code: null,
  notes: null,
  active: true,
  created_at: "2026-08-17T00:00:00Z",
  parent_container_id: null,
  location_id: null,
};
const crate: StorageContainer = {
  ...conex,
  id: "crate",
  serial: "CTR-000002",
  name: "Crate 7",
  parent_container_id: "conex",
};

const base = (over: Partial<FindInputs> = {}): FindInputs => ({
  packages: [],
  containers: [conex, crate],
  projects: [{ id: "job-1", job_code: "BLACK22", name: "Black Desert" }],
  locationsById: new Map(),
  ...over,
});

describe("finding a package", () => {
  it("by its serial, and says where it sits", () => {
    const p = pkg({ container_id: "crate" });
    // Use the row's own serial: the factory counter is shared across the file.
    const a = findInWarehouse(p.serial.toLowerCase(), base({ packages: [p] }))!;
    expect(a.kind).toBe("package");
    expect(a.kind === "package" && a.hit.where).toBe("Crate 7 — inside Conex 3");
  });

  it("by its short code", () => {
    const p = pkg({ short_code: "K4T9QP" });
    const a = findInWarehouse("k4t9qp", base({ packages: [p] }))!;
    expect(a.kind).toBe("package");
  });

  it("by the manufacturer's own number — sometimes the only one in hand", () => {
    const p = pkg({ mfr_mark: "A-2216" });
    const a = findInWarehouse("a-2216", base({ packages: [p] }))!;
    expect(a.kind).toBe("package");
  });

  it("says plainly when it already left", () => {
    const p = pkg({ status: "checked_out", container_id: null });
    const a = findInWarehouse(p.serial, base({ packages: [p] }))!;
    expect(a.kind === "package" && a.hit.where).toBe("checked out to a job");
  });
});

describe("finding a window", () => {
  const packages = [
    pkg({ marks: ["16"], part_index: 1, part_total: 3, part_type: "frame" }),
    pkg({ marks: ["16"], part_index: 2, part_total: 3, part_type: "glass", container_id: "crate" }),
  ];

  it("returns the whole chain, not a list to dig through", () => {
    const a = findInWarehouse("16", base({ packages }))!;
    expect(a.kind).toBe("unit");
    if (a.kind !== "unit") return;
    expect(a.jobCode).toBe("BLACK22");
    expect(a.hits).toHaveLength(2);
    expect(a.hits[1].where).toBe("Crate 7 — inside Conex 3");
    expect(a.headline).toContain("2 of 3 here");
    expect(answerHeadline(a)).toContain("Window 16 · BLACK22");
  });

  it("answers for a scheduled window with nothing tagged yet", () => {
    const a = findInWarehouse("17", base({
      packages,
      scheduledMarks: [{ project_id: "job-1", mark_code: "17" }],
    }))!;
    expect(a.kind).toBe("unit");
    if (a.kind !== "unit") return;
    expect(a.hits).toHaveLength(0);
    expect(a.headline).toBe("Nothing tagged for this window yet");
  });
});

describe("a staged package names its job through Find (F6)", () => {
  // The label existed and was unit-tested; Find never handed it the locations,
  // so every staged package on every screen read "on a shelf". This pins the
  // whole path — findInWarehouse's own answer, not placeLabel in isolation.
  const bay = { id: "bay-1", address: "J-BLACK22-A", zone: "J", rack: "BLACK22" };
  const locationsById = new Map([[bay.id, bay]]);

  it("says which job a found package is set aside for", () => {
    const p = pkg({ container_id: null, location_id: "bay-1" });
    const a = findInWarehouse(p.serial, base({ packages: [p], locationsById }))!;
    expect(a.kind).toBe("package");
    expect(a.kind === "package" && a.hit.where).toBe("staged for BLACK22 — J-BLACK22-A");
  });

  it("names the bay on a window's rows too, not just a lone sticker", () => {
    const p = pkg({ marks: ["44"], container_id: null, location_id: "bay-1" });
    const a = findInWarehouse("44", base({ packages: [p], locationsById }))!;
    expect(a.kind).toBe("unit");
    expect(a.kind === "unit" && a.hits[0].where).toBe("staged for BLACK22 — J-BLACK22-A");
  });
});

describe("one mark, more than one job (D1)", () => {
  // Marks are position numbers off the plans and are unique only WITHIN a job
  // (project_marks: unique (project_id, mark_code)). Two live jobs both have a
  // window 16. Answering with whichever came first was confident and wrong.
  const jobs = [
    { id: "job-1", job_code: "BLACK22", name: "Black Desert" },
    { id: "job-2", job_code: "SUNVALE14", name: "Sun Valley" },
  ];

  const both = () => [
    pkg({ project_id: "job-1", marks: ["16"], part_index: 1, part_total: 2 }),
    pkg({ project_id: "job-2", marks: ["16"], part_index: 1, part_total: 2 }),
  ];

  it("asks which job instead of guessing one", () => {
    const a = findInWarehouse("16", base({ packages: both(), projects: jobs }))!;
    expect(a.kind).toBe("mark-choices");
    if (a.kind !== "mark-choices") return;
    expect(a.choices.map((c) => c.jobCode)).toEqual(["BLACK22", "SUNVALE14"]);
  });

  it("every row carries what tells the two windows apart", () => {
    const bay = { id: "bay-1", address: "J-BLACK22-A", zone: "J", rack: "BLACK22" };
    const [one, two] = both();
    one.container_id = null;
    one.location_id = "bay-1";
    const a = findInWarehouse(
      "16",
      base({
        packages: [one, two],
        projects: jobs,
        locationsById: new Map([[bay.id, bay]]),
      }),
    )!;
    if (a.kind !== "mark-choices") throw new Error("expected a pick-list");
    expect(a.choices[0].where).toBe("staged for BLACK22 — J-BLACK22-A");
    expect(a.choices[0].headline).toContain("1 of 2 here");
    expect(a.choices[1].where).toBe("Conex 3");
  });

  it("one job with that mark still answers straight through — no extra tap", () => {
    const a = findInWarehouse("16", base({ packages: [both()[0]], projects: jobs }))!;
    expect(a.kind).toBe("unit");
    expect(a.kind === "unit" && a.jobCode).toBe("BLACK22");
  });

  it("picking a job off the list goes straight to that job's window", () => {
    const a = findInWarehouse(
      "16",
      base({ packages: both(), projects: jobs }),
      { markProjectId: "job-2" },
    )!;
    expect(a.kind).toBe("unit");
    expect(a.kind === "unit" && a.jobCode).toBe("SUNVALE14");
  });

  it("counts a scheduled mark as a job in the running, even with nothing tagged", () => {
    // The rejected fix was "only search the open job". Nothing here scopes to
    // a job, so the hub — where no job is open — still sees both.
    const a = findInWarehouse(
      "16",
      base({
        packages: [both()[0]],
        projects: jobs,
        scheduledMarks: [{ project_id: "job-2", mark_code: "16" }],
      }),
    )!;
    expect(a.kind).toBe("mark-choices");
    if (a.kind !== "mark-choices") return;
    expect(a.choices.map((c) => c.jobCode)).toEqual(["BLACK22", "SUNVALE14"]);
    expect(a.choices[1].headline).toBe("Nothing tagged for this window yet");
  });

  it("a stale pick from an older search is ignored, not obeyed", () => {
    const a = findInWarehouse(
      "16",
      base({ packages: [both()[0]], projects: jobs }),
      { markProjectId: "job-2" },
    )!;
    expect(a.kind === "unit" && a.jobCode).toBe("BLACK22");
  });
});

describe("finding a container or a job", () => {
  it("a conex lists what is inside it", () => {
    const a = findInWarehouse("Conex 3", base({ packages: [pkg({})] }))!;
    expect(a.kind).toBe("container");
    expect(a.kind === "container" && a.hits).toHaveLength(1);
  });

  it("a job code gathers everything tagged for it", () => {
    const a = findInWarehouse("black22", base({ packages: [pkg({}), pkg({})] }))!;
    expect(a.kind).toBe("job");
    expect(a.kind === "job" && a.hits).toHaveLength(2);
  });
});

describe("precedence and misses", () => {
  it("a sticker code wins over anything else that might match", () => {
    // A container mischievously named after a package serial.
    const odd: StorageContainer = { ...conex, id: "odd", name: "PKG-000010" };
    const p = pkg({ serial: "PKG-000010" });
    const a = findInWarehouse("PKG-000010", base({ packages: [p], containers: [odd] }))!;
    expect(a.kind).toBe("package");
  });

  it("says what to do next instead of 'no results'", () => {
    const a = findInWarehouse("ZZZZZ", base())!;
    expect(a.kind).toBe("miss");
    expect(a.kind === "miss" && a.suggestion).toContain("tag it at the truck");
  });

  it("stays quiet until there is something to go on", () => {
    expect(findInWarehouse("", base())).toBeNull();
    expect(findInWarehouse("1", base())).toBeNull();
  });
});

describe("shelves answer through their own addresses (audit F7, ticket 21)", () => {
  // The old path resolved a slot only when a unit from the retired chain
  // happened to be parked there — 8 real staging bays, 1 unit staged, so it
  // failed for essentially every real bay. Slots answer for themselves now.
  const bay = { id: "loc-1", address: "S-01-A" };

  it("finds a rack slot by its printed address and lists its packages", () => {
    const here = pkg({ serial: "PKG-000050", container_id: null, location_id: "loc-1" });
    const elsewhere = pkg({ serial: "PKG-000051", container_id: "conex" });
    const a = findInWarehouse(
      "s-01-a",
      base({ packages: [here, elsewhere], locationsById: new Map([["loc-1", bay]]) }),
    )!;
    expect(a.kind).toBe("slot");
    if (a.kind !== "slot") return;
    expect(a.hits.map((h) => h.pkg.serial)).toEqual(["PKG-000050"]);
  });

  it("an empty bay answers honestly instead of 'not found'", () => {
    const a = findInWarehouse(
      "S-01-A",
      base({ packages: [], locationsById: new Map([["loc-1", bay]]) }),
    )!;
    expect(a.kind).toBe("slot");
    if (a.kind !== "slot") return;
    expect(a.hits).toEqual([]);
  });
});

describe("a supply answers with its home box (owner ask, 2026-08-18)", () => {
  const CAULK = {
    id: "s1",
    name: "Caulk (grey)",
    unit: "tube",
    on_hand: 12,
    home_container_id: "conex",
    home_note: "north wall, blue bins",
  };

  it("finds it by part of the name and says the box and the note", () => {
    const a = findInWarehouse("caulk", base({ supplies: [CAULK] }))!;
    expect(a.kind).toBe("supply");
    if (a.kind !== "supply") return;
    expect(a.home).toBe("Conex 3 — north wall, blue bins");
    expect(a.onHand).toBe(12);
  });

  it("an exact name beats a contains match", () => {
    const exact = { ...CAULK, id: "s2", name: "CAULK", home_note: null, home_container_id: null };
    const a = findInWarehouse("caulk", base({ supplies: [CAULK, exact] }))!;
    if (a.kind !== "supply") return;
    expect(a.name).toBe("CAULK");
  });

  it("stickers and boxes still win — a supply never shadows a serial", () => {
    const p = pkg({ serial: "CAULKGUN1" });
    const a = findInWarehouse("caulkgun1", base({ packages: [p], supplies: [CAULK] }))!;
    expect(a.kind).toBe("package");
  });

  it("two letters never match a supply — too easy to hit by accident", () => {
    const a = findInWarehouse("ca", base({ supplies: [CAULK] }))!;
    expect(a.kind).toBe("miss");
  });

  it("no home yet is said plainly", () => {
    const bare = { id: "s3", name: "Screws", unit: "box" };
    const a = findInWarehouse("screws", base({ supplies: [bare] }))!;
    if (a.kind !== "supply") return;
    expect(a.home).toBe("no home spot yet");
  });
});

// The three field reports of 2026-08-26: job names answered nothing, a
// colliding manufacturer mark showed one package when two jobs had one,
// and waiting-job material was invisible to every path.
describe("finding by a piece of the job's name", () => {
  it("'sand hollow' finds the job through its NAME, not just its code", () => {
    const p = pkg({ project_id: "esh", marks: ["4"] });
    const a = findInWarehouse("sand hollow", base({
      packages: [p],
      projects: [{ id: "esh", job_code: "ESH-18", name: "Estates at Sand Hollow 18" }],
    }));
    expect(a).toMatchObject({ kind: "job", jobCode: "ESH-18" });
    expect((a as { hits: unknown[] }).hits).toHaveLength(1);
  });

  it("a typed waiting-job name answers with its material", () => {
    const p = pkg({ project_id: null, pending_job_name: "Mad Moose", mfr_mark: "7", marks: [] });
    const a = findInWarehouse("mad moose", base({ packages: [p], projects: [] }));
    expect(a).toMatchObject({ kind: "pending-job", name: "Mad Moose" });
    expect(answerHeadline(a!)).toContain("Mad Moose");
  });

  it("a bare number never detours into name matching", () => {
    const a = findInWarehouse("505", base({
      projects: [{ id: "x", job_code: "505-RIDGE", name: null }],
    }));
    expect(a?.kind).toBe("miss");
  });
});

describe("colliding manufacturer marks", () => {
  it("one mfr match still answers instantly as the package", () => {
    const crated = pkg({ project_id: null, pending_job_name: "Mad Moose", mfr_mark: "CRATE 1", marks: [] });
    const a = findInWarehouse("CRATE 1", base({ packages: [crated], projects: [] }));
    expect(a?.kind).toBe("package");
  });

  it("two jobs each holding a #12 asks which job — waiting jobs included", () => {
    const bound = pkg({ project_id: "job-1", mfr_mark: "12", marks: ["12"] });
    const waiting = pkg({ project_id: null, pending_job_name: "Don Timpson Res", mfr_mark: "12", marks: [] });
    const a = findInWarehouse("#12", base({ packages: [bound, waiting] }));
    expect(a?.kind).toBe("mark-choices");
    const choices = (a as { choices: { jobCode: string; pendingName: string | null }[] }).choices;
    expect(choices).toHaveLength(2);
    expect(choices.map((c) => c.jobCode).sort()).toEqual(["BLACK22", "Don Timpson Res"]);
  });

  it("picking the waiting job answers with that job's window", () => {
    const bound = pkg({ project_id: "job-1", mfr_mark: "12", marks: ["12"] });
    const waiting = pkg({ project_id: null, pending_job_name: "Don Timpson Res", mfr_mark: "12", marks: [] });
    const a = findInWarehouse("12", base({ packages: [bound, waiting] }), {
      markPendingName: "Don Timpson Res",
    });
    expect(a).toMatchObject({ kind: "unit", projectId: null, jobCode: "Don Timpson Res" });
    expect((a as { hits: unknown[] }).hits).toHaveLength(1);
  });
});
