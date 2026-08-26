// The four numbers, pinned. The rule that matters most: a count and the list
// behind it are derived from the same predicate, so they cannot disagree —
// and "not tagged" counts MARKS, because a mark repeated across eight
// openings is one mark to a manufacturer's label.

import { describe, expect, it } from "vitest";
import type { StorageContainer, StoragePackage } from "../storage";
import {
  cardLink,
  cardPackages,
  untaggedMarks,
  warehouseCounts,
  WAREHOUSE_CARDS,
} from "./warehouseCards";

let seq = 0;
function pkg(over: Partial<StoragePackage> & { marks?: string[] }): StoragePackage {
  const { marks, ...rest } = over;
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
const containers = [conex];
const NO_DAMAGE = 0;

describe("on hand", () => {
  it("counts what we are holding — not what left for a job", () => {
    const rows = [
      pkg({ status: "stored" }),
      pkg({ status: "received", container_id: null }),
      pkg({ status: "checked_out", container_id: null }),
    ];
    expect(warehouseCounts(rows, containers, [], NO_DAMAGE)["on-hand"]).toBe(2);
  });
});

describe("loose", () => {
  it("counts tagged packages with no container and no shelf spot", () => {
    const rows = [
      pkg({ container_id: "conex" }),
      pkg({ status: "received", container_id: null }),
      pkg({ status: "received", container_id: null, location_id: "slot-1" }),
    ];
    expect(warehouseCounts(rows, containers, [], NO_DAMAGE).loose).toBe(1);
  });

  it("a package in a crate inside a conex is placed, not loose", () => {
    const crate: StorageContainer = { ...conex, id: "crate", name: "Crate 7", parent_container_id: "conex" };
    const rows = [pkg({ container_id: "crate" })];
    expect(warehouseCounts(rows, [conex, crate], [], NO_DAMAGE).loose).toBe(0);
  });
});

describe("not tagged", () => {
  const schedule = [
    { project_id: "job-1", mark_code: "16" },
    { project_id: "job-1", mark_code: "17" },
    { project_id: "job-1", mark_code: "18" },
  ];

  it("counts scheduled windows with nothing tagged against them", () => {
    const rows = [pkg({ marks: ["16"] })];
    expect(warehouseCounts(rows, containers, schedule, NO_DAMAGE)["not-tagged"]).toBe(2);
  });

  it("one tagged package is enough — the rest is 'waiting on parts', a different card", () => {
    const rows = [pkg({ marks: ["16"], part_index: 2, part_total: 3 })];
    const counts = warehouseCounts(rows, containers, schedule, NO_DAMAGE);
    expect(counts["not-tagged"]).toBe(2); // 17 and 18, NOT 16
  });

  it("matches marks case-blind", () => {
    const rows = [pkg({ marks: ["13a"] })];
    expect(
      warehouseCounts(rows, containers, [{ project_id: "job-1", mark_code: "13A" }], NO_DAMAGE)[
        "not-tagged"
      ],
    ).toBe(0);
  });

  it("a mark repeated across openings counts ONCE — labels carry no instance number", () => {
    const repeated = [
      { project_id: "job-1", mark_code: "6" },
      { project_id: "job-1", mark_code: "6" },
      { project_id: "job-1", mark_code: "6" },
    ];
    expect(warehouseCounts([], containers, repeated, NO_DAMAGE)["not-tagged"]).toBe(1);
  });

  it("does not credit a tag from another job", () => {
    const rows = [pkg({ project_id: "job-2", marks: ["16"] })];
    expect(warehouseCounts(rows, containers, schedule, NO_DAMAGE)["not-tagged"]).toBe(3);
  });

  it("counts checked-out packages as tagged — the sticker went on either way", () => {
    const rows = [pkg({ status: "checked_out", container_id: null, marks: ["16"] })];
    expect(warehouseCounts(rows, containers, schedule, NO_DAMAGE)["not-tagged"]).toBe(2);
  });

  it("is zero with no schedule at all rather than guessing", () => {
    expect(warehouseCounts([], containers, [], NO_DAMAGE)["not-tagged"]).toBe(0);
  });
});

describe("damaged", () => {
  it("counts open damage REPORTS — packages cannot carry damage yet", () => {
    const counts = warehouseCounts([pkg({}), pkg({})], containers, [], 3);
    expect(counts.damaged).toBe(3);
  });

  it("sends you to the issue, not to a package list", () => {
    expect(cardLink("damaged")).toBe("/issues");
  });

  it("package cards open on the warehouse page, never the old unit list", () => {
    // /warehouse/:view reads the UNIT system; these numbers no longer do.
    // The Storage hub merged into /warehouse (ticket 18), so a card number
    // opens right back where it was tapped, with ?card= filtering the page.
    for (const c of WAREHOUSE_CARDS) {
      if (c.id === "damaged") continue;
      expect(cardLink(c.id), `${c.id} points at the old unit list`).toBe(
        `/warehouse?card=${c.id}`,
      );
    }
  });
});

describe("untaggedMarks", () => {
  it("lists exactly what the not-tagged number counts", () => {
    const schedule = [
      { project_id: "job-1", mark_code: "16" },
      { project_id: "job-1", mark_code: "17" },
      { project_id: "job-1", mark_code: " 17 " }, // duplicate, spaced
    ];
    const rows = [pkg({ marks: ["16"] })];
    const missing = untaggedMarks(rows, schedule);
    expect(missing.map((m) => m.mark_code)).toEqual(["17"]);
    expect(warehouseCounts(rows, containers, schedule, 0)["not-tagged"]).toBe(
      missing.length,
    );
  });
});

describe("counts and their lists agree", () => {
  const rows = [
    pkg({ container_id: "conex" }),
    pkg({ status: "received", container_id: null }),
    pkg({ status: "checked_out", container_id: null }),
  ];
  it("every package-backed card's row count equals its number", () => {
    const counts = warehouseCounts(rows, containers, [], 0);
    for (const card of WAREHOUSE_CARDS) {
      // These two count things that are not packages (marks / issue reports).
      if (card.id === "not-tagged" || card.id === "damaged") continue;
      expect(
        cardPackages(card.id, rows, containers).length,
        `${card.id} count and list disagree`,
      ).toBe(counts[card.id]);
    }
  });

  it("the two non-package cards list nothing and link away instead", () => {
    expect(cardPackages("not-tagged", rows, containers)).toEqual([]);
    expect(cardPackages("damaged", rows, containers)).toEqual([]);
  });

  it("every card explains itself in plain words", () => {
    for (const card of WAREHOUSE_CARDS) {
      expect(card.blurb.length, `${card.id} has no blurb`).toBeGreaterThan(40);
    }
  });
});

/**
 * A blurb is a promise about what the crew will find when they tap through.
 * It went quiet about a photo on 2026-08-17 because the arrival check took
 * none and `issues` had no column to hold one; warehouse ticket 11
 * (20260922000000_damage_photo.sql) made that promise true again.
 */
describe("the damaged card promises only what is there", () => {
  const damaged = WAREHOUSE_CARDS.find((c) => c.id === "damaged")!;

  it("promises the photo now that arrival capture takes one (ticket 11)", () => {
    expect(damaged.blurb.toLowerCase()).toContain("photo");
  });

  it("still promises the reporter, which is real", () => {
    // arrive_packages stamps issues.created_by; Issues.tsx renders the name.
    expect(damaged.blurb.toLowerCase()).toContain("who reported it");
  });
});
