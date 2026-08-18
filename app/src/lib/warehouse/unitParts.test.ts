// The completeness rules, pinned: never claim more than the labels say,
// never block on less. The one hard invariant — a missing part is "no label
// yet", not "not arrived" — is in the copy the headline produces.

import { describe, expect, it } from "vitest";
import type { StoragePackage } from "../storage";
import { partsHeadline, unitParts } from "./unitParts";

let seq = 0;
function pkg(over: Partial<StoragePackage> & { marks?: string[] }): StoragePackage {
  const { marks, ...rest } = over;
  seq += 1;
  return {
    id: `id-${seq}`,
    serial: `PKG-${String(seq).padStart(6, "0")}`,
    short_code: null,
    status: "stored",
    project_id: "job-1",
    category: null,
    part_index: null,
    part_total: null,
    part_type: null,
    mfr_mark: null,
    note: null,
    delivery_id: null,
    container_id: null,
    bound_at: null,
    bound_by: null,
    created_at: "2026-08-17T00:00:00Z",
    package_marks: (marks ?? ["16"]).map((mark_code) => ({ mark_code })),
    ...rest,
  };
}

describe("unitParts", () => {
  it("finds every package tagged with the mark on the job, and only those", () => {
    const rows = unitParts(
      [
        pkg({ marks: ["16"] }),
        pkg({ marks: ["17"] }),                       // other window
        pkg({ marks: ["16"], project_id: "job-2" }),  // other job
        pkg({ marks: ["16", "17"] }),                 // bulk crate carrying both
      ],
      "job-1",
      "16",
    ).rows;
    expect(rows).toHaveLength(2);
  });

  it("matches the mark case-blind — scans type lowercase sometimes", () => {
    expect(unitParts([pkg({ marks: ["13A"] })], "job-1", "13a").rows).toHaveLength(1);
  });

  it("reads 'all here' only when every numbered piece is present", () => {
    const r = unitParts(
      [
        pkg({ part_index: 1, part_total: 3, part_type: "frame" }),
        pkg({ part_index: 2, part_total: 3, part_type: "glass" }),
        pkg({ part_index: 3, part_total: 3, part_type: "hardware" }),
      ],
      "job-1",
      "16",
    );
    expect(r.complete).toBe(true);
    expect(r.missingIndexes).toEqual([]);
    expect(partsHeadline(r)).toEqual({ text: "3 of 3 · all here", tone: "ok" });
  });

  it("names the gap when the denominator says there should be more", () => {
    const r = unitParts(
      [pkg({ part_index: 2, part_total: 3, part_type: "glass" })],
      "job-1",
      "16",
    );
    expect(r.expectedTotal).toBe(3);
    expect(r.missingIndexes).toEqual([1, 3]);
    expect(r.complete).toBe(false);
    const h = partsHeadline(r);
    expect(h.tone).toBe("warn");
    expect(h.text).toContain("1 of 3 here");
    expect(h.text).toContain("no label yet for parts 1, 3");
  });

  it("claims nothing when no label carried a number", () => {
    const r = unitParts([pkg({}), pkg({})], "job-1", "16");
    expect(r.expectedTotal).toBeNull();
    expect(r.complete).toBeNull();
    const h = partsHeadline(r);
    expect(h.tone).toBe("muted");
    expect(h.text).toBe("2 packages here · labels carry no part numbers");
  });

  it("refuses to pick a side when labels disagree on the total", () => {
    const r = unitParts(
      [pkg({ part_index: 1, part_total: 3 }), pkg({ part_index: 2, part_total: 4 })],
      "job-1",
      "16",
    );
    expect(r.totalsDisagree).toBe(true);
    expect(r.complete).toBeNull();
    expect(r.missingIndexes).toEqual([]);
    expect(partsHeadline(r).tone).toBe("warn");
    expect(partsHeadline(r).text).toContain("disagree");
  });

  it("tolerates a duplicate piece — a replacement shipment is not a conflict", () => {
    const r = unitParts(
      [
        pkg({ part_index: 2, part_total: 2 }),
        pkg({ part_index: 2, part_total: 2 }),
        pkg({ part_index: 1, part_total: 2 }),
      ],
      "job-1",
      "16",
    );
    expect(r.totalsDisagree).toBe(false);
    expect(r.presentIndexes).toEqual([1, 2]);
    expect(r.complete).toBe(true);
  });

  it("mixed numbered and numberless: judged against the known total only", () => {
    const r = unitParts(
      [pkg({ part_index: 2, part_total: 3 }), pkg({})],
      "job-1",
      "16",
    );
    // The numberless package might BE part 1 — which is exactly why the copy
    // says "no label yet", never "not arrived".
    expect(r.missingIndexes).toEqual([1, 3]);
    expect(r.rows).toHaveLength(2);
  });

  it("sorts numbered parts first, in order, numberless after", () => {
    const r = unitParts(
      [pkg({}), pkg({ part_index: 2, part_total: 2 }), pkg({ part_index: 1, part_total: 2 })],
      "job-1",
      "16",
    );
    expect(r.rows.map((p) => p.part_index)).toEqual([1, 2, null]);
  });

  it("says so plainly when nothing is tagged", () => {
    const h = partsHeadline(unitParts([], "job-1", "16"));
    expect(h).toEqual({ text: "Nothing tagged for this window yet", tone: "muted" });
  });
});

describe("minted labels (ticket 15): expected, never present", () => {
  it("a declared window counts its labels as on the way, not here", () => {
    // Foreman declared "arrives as 3"; nothing has arrived. Saying "3 of 3
    // here" would be the app lying about a shelf.
    const r = unitParts(
      [
        pkg({ status: "minted", part_index: 1, part_total: 3, marks: ["16"] }),
        pkg({ status: "minted", part_index: 2, part_total: 3, marks: ["16"] }),
        pkg({ status: "minted", part_index: 3, part_total: 3, marks: ["16"] }),
      ],
      "job-1",
      "16",
    );
    expect(r.expectedTotal).toBe(3);
    expect(r.presentIndexes).toEqual([]);
    expect(r.onTheWayIndexes).toEqual([1, 2, 3]);
    expect(r.complete).toBe(false);
    expect(partsHeadline(r)).toEqual({
      text: "0 of 3 here · 3 on the way",
      tone: "muted",
    });
  });

  it("receiving flips a part from on-the-way to here", () => {
    const r = unitParts(
      [
        pkg({ status: "received", part_index: 1, part_total: 3, marks: ["16"] }),
        pkg({ status: "minted", part_index: 2, part_total: 3, marks: ["16"] }),
        pkg({ status: "minted", part_index: 3, part_total: 3, marks: ["16"] }),
      ],
      "job-1",
      "16",
    );
    expect(r.presentIndexes).toEqual([1]);
    expect(r.onTheWayIndexes).toEqual([2, 3]);
    expect(r.missingIndexes).toEqual([]);
  });

  it("a part with NO label anywhere still raises the alarm, on the way or not", () => {
    const r = unitParts(
      [
        pkg({ status: "received", part_index: 1, part_total: 3, marks: ["16"] }),
        pkg({ status: "minted", part_index: 2, part_total: 3, marks: ["16"] }),
      ],
      "job-1",
      "16",
    );
    expect(r.missingIndexes).toEqual([3]);
    const h = partsHeadline(r);
    expect(h.tone).toBe("warn");
    expect(h.text).toContain("no label yet for part 3");
    expect(h.text).toContain("1 on the way");
  });
});

describe("the maker's label disagrees (ticket 20)", () => {
  it("one recorded maker count that differs raises the flag, maker's number named", () => {
    const r = unitParts(
      [
        pkg({ status: "received", part_index: 1, part_total: 4, mfr_part_total: 3, marks: ["16"] }),
        pkg({ status: "minted", part_index: 2, part_total: 4, marks: ["16"] }),
      ],
      "job-1",
      "16",
    );
    expect(r.makerSays).toBe(3);
    const h = partsHeadline(r);
    expect(h.tone).toBe("warn");
    expect(h.text).toContain("the maker's label says 3");
    expect(h.text).toContain("burn");
  });

  it("a maker count that AGREES raises nothing", () => {
    const r = unitParts(
      [pkg({ part_index: 1, part_total: 3, mfr_part_total: 3, marks: ["16"] })],
      "job-1",
      "16",
    );
    expect(r.makerSays).toBe(null);
  });

  it("nobody looked, nothing said", () => {
    const r = unitParts(
      [pkg({ part_index: 1, part_total: 3, marks: ["16"] })],
      "job-1",
      "16",
    );
    expect(r.makerSays).toBe(null);
  });
});
