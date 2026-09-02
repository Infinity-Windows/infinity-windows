// A project can hold SEVERAL specs plansets at once — the supplier's original
// cut sheet plus an ADDENDUM sheet for units added later — and every one of
// them is current. Mad Moose, 2026-09-01: an addendum was uploaded on top of
// the four-page supplier sheet, the app treated it as a replacement, and marks
// 4–10 lost the page with their markups on every spec card and on the Maps
// Interactive wall.
//
// These are the pure pieces of the rule that replaced that behaviour: which
// sheets count as current, which sheet ONE mark's drawing belongs to, and which
// confirmed rows may take a drawing they never had.

import { describe, expect, it } from "vitest";
import {
  adoptableDrawingCoords,
  findSpecsPlansetFor,
  findSpecsPlansets,
  specsPlansetIds,
  type StoredDrawingCoords,
} from "./api";
import type { Planset } from "./types";

/** The real Mad Moose file names, so a failure reads like the job. */
function planset(over: Partial<Planset> & Pick<Planset, "id">): Planset {
  return {
    project_id: "mad-moose",
    storage_path: `plansets/${over.id}.pdf`,
    source_format: "pdf",
    converted_pdf_path: null,
    page_count: 4,
    status: "ready",
    kind: "specs",
    created_at: "2026-08-01T00:00:00Z",
    ...over,
  };
}

// listPlansets returns newest first, so the addendum leads.
const ADDENDUM = planset({
  id: "MMV2A",
  page_count: 1,
  created_at: "2026-09-01T18:24:00Z",
});
const ORIGINAL = planset({ id: "MMV2", created_at: "2026-08-14T00:00:00Z" });
const BUILDING = planset({ id: "arch", kind: "building" });
const DWG = planset({ id: "raw-cad", source_format: "dwg" });
const MAD_MOOSE = [ADDENDUM, ORIGINAL, BUILDING, DWG];

describe("findSpecsPlansets", () => {
  it("returns every renderable specs sheet, newest first", () => {
    expect(findSpecsPlansets(MAD_MOOSE)).toEqual([ADDENDUM, ORIGINAL]);
  });

  it("leaves out building plans and un-converted CAD", () => {
    const ids = specsPlansetIds(MAD_MOOSE);
    expect(ids).toEqual(["MMV2A", "MMV2"]);
    expect(ids).not.toContain("arch");
    expect(ids).not.toContain("raw-cad");
  });

  it("counts a converted CAD specs sheet, which we can render", () => {
    const converted = planset({
      id: "cad-specs",
      source_format: "dxf",
      converted_pdf_path: "plansets/cad-specs.pdf",
    });
    expect(specsPlansetIds([converted])).toEqual(["cad-specs"]);
  });

  it("is empty rather than undefined on a job with no plans yet", () => {
    expect(findSpecsPlansets([])).toEqual([]);
    expect(specsPlansetIds([])).toEqual([]);
  });
});

describe("findSpecsPlansetFor", () => {
  it("gives each mark the sheet its own coordinates were read from", () => {
    // Mark 4 came off the original; the added unit came off the addendum.
    expect(findSpecsPlansetFor(MAD_MOOSE, { planset_id: "MMV2" })).toBe(ORIGINAL);
    expect(findSpecsPlansetFor(MAD_MOOSE, { planset_id: "MMV2A" })).toBe(ADDENDUM);
  });

  it("falls back to the newest sheet for a legacy row with no provenance", () => {
    expect(findSpecsPlansetFor(MAD_MOOSE, { planset_id: null })).toBe(ADDENDUM);
    expect(findSpecsPlansetFor(MAD_MOOSE, {})).toBe(ADDENDUM);
  });

  it("gives NOTHING when the named sheet is gone from the job", () => {
    // Never another file: page 3 of a different sheet is a different window.
    expect(findSpecsPlansetFor([ADDENDUM], { planset_id: "MMV2" })).toBeNull();
  });

  it("never offers a building plan or an un-renderable file", () => {
    expect(findSpecsPlansetFor([BUILDING, DWG], { planset_id: null })).toBeNull();
    expect(findSpecsPlansetFor([BUILDING], { planset_id: "arch" })).toBeNull();
  });
});

describe("adoptableDrawingCoords", () => {
  const BOX = [0.59, 0.462, 0.672, 0.622];

  function row(over: Partial<StoredDrawingCoords>): StoredDrawingCoords {
    return {
      id: "row-1",
      mark_code: "12",
      confirmed: true,
      image_page: null,
      image_bbox: null,
      planset_id: null,
      ...over,
    };
  }

  it("fills in a confirmed mark that has no drawing at all", () => {
    // The Mad Moose add units: confirmed off the schedule, picture-less until
    // the addendum sheet was read.
    expect(
      adoptableDrawingCoords(
        [row({ id: "add-12", mark_code: "12" })],
        [{ mark_code: "12", image_page: 1, image_bbox: BOX }],
        "MMV2A",
      ),
    ).toEqual([
      { id: "add-12", image_page: 1, image_bbox: BOX, planset_id: "MMV2A" },
    ]);
  });

  it("matches marks case-insensitively, like every other mark comparison", () => {
    const adopted = adoptableDrawingCoords(
      [row({ id: "row-4a", mark_code: "4a" })],
      [{ mark_code: "4A", image_page: 2, image_bbox: BOX }],
      "MMV2A",
    );
    expect(adopted.map((a) => a.id)).toEqual(["row-4a"]);
  });

  it("never overwrites drawing coordinates a row already has", () => {
    const already = [
      row({ id: "has-all", image_page: 3, image_bbox: BOX, planset_id: "MMV2" }),
      // Half a box is still a located picture this run has no standing to move.
      row({ id: "has-page", image_page: 3 }),
      row({ id: "has-box", image_bbox: BOX }),
    ];
    expect(
      adoptableDrawingCoords(
        already,
        [{ mark_code: "12", image_page: 1, image_bbox: BOX }],
        "MMV2A",
      ),
    ).toEqual([]);
  });

  it("un-strands a row the old retire step left pointing at nothing", () => {
    // Marks 4–10 as the addendum upload left them: the page and the box were
    // blanked and the pointer at the original sheet was kept. A pointer crops
    // nothing, so the row is still picture-less — and if it can't be adopted it
    // stays that way however many times the sheet is re-read.
    expect(
      adoptableDrawingCoords(
        [row({ id: "mark-7", mark_code: "7", planset_id: "MMV2" })],
        [{ mark_code: "7", image_page: 2, image_bbox: BOX }],
        "MMV2",
      ),
    ).toEqual([
      { id: "mark-7", image_page: 2, image_bbox: BOX, planset_id: "MMV2" },
    ]);
  });

  it("writes the sheet this run read over a stale pointer", () => {
    // Page, box and planset land as one set, so a row can't end up with the
    // original's pointer and the addendum's box.
    expect(
      adoptableDrawingCoords(
        [row({ id: "mark-7", mark_code: "7", planset_id: "deleted-sheet" })],
        [{ mark_code: "7", image_page: 1, image_bbox: BOX }],
        "MMV2A",
      ),
    ).toEqual([
      { id: "mark-7", image_page: 1, image_bbox: BOX, planset_id: "MMV2A" },
    ]);
  });

  it("leaves unconfirmed rows to the ordinary upsert", () => {
    expect(
      adoptableDrawingCoords(
        [row({ confirmed: false })],
        [{ mark_code: "12", image_page: 1, image_bbox: BOX }],
        "MMV2A",
      ),
    ).toEqual([]);
  });

  it("adopts nothing when this run found no usable box for the mark", () => {
    const drafts = [
      { mark_code: "12", image_page: null, image_bbox: BOX },
      { mark_code: "12", image_page: 1, image_bbox: null },
      // Reversed box — validateBbox refuses it, so there is nothing to adopt.
      { mark_code: "12", image_page: 1, image_bbox: [0.9, 0.9, 0.1, 0.1] },
      { mark_code: "12", image_page: 0, image_bbox: BOX },
    ];
    for (const draft of drafts) {
      expect(adoptableDrawingCoords([row({})], [draft], "MMV2A")).toEqual([]);
    }
  });

  it("adopts nothing when we don't know which sheet this run read", () => {
    // A box saved with a null planset falls back to whichever specs sheet is
    // newest, which is the wrong-picture failure this whole rule exists to stop.
    for (const unknown of [null, undefined, ""]) {
      expect(
        adoptableDrawingCoords(
          [row({})],
          [{ mark_code: "12", image_page: 1, image_bbox: BOX }],
          unknown,
        ),
      ).toEqual([]);
    }
  });

  it("adopts nothing for a mark this run didn't read", () => {
    expect(
      adoptableDrawingCoords(
        [row({ mark_code: "18B" })],
        [{ mark_code: "12", image_page: 1, image_bbox: BOX }],
        "MMV2A",
      ),
    ).toEqual([]);
  });

  it("survives an empty job on either side", () => {
    expect(adoptableDrawingCoords([], [], "MMV2A")).toEqual([]);
    expect(
      adoptableDrawingCoords([row({})], [], "MMV2A"),
    ).toEqual([]);
  });
});
