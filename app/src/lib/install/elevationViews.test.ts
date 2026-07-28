import { describe, expect, it } from "vitest";
import {
  calloutRingCircle,
  elevationAppearances,
  pageViewRegions,
  parseViewTitle,
  pickElevationViews,
  regionCropBbox,
  viewFaceKey,
  viewLabel,
  viewRank,
  type ElevationViewLike,
  type SheetTextLine,
} from "./elevationViews";

// Ground truth: every line on Black Desert sheet A.201 (page 2) containing
// "ELEVATION" or "VIEW", read off the real PDF with the positions the app
// extracts. Three of these are drawing captions; the other seven are the title
// block, two note headings and body prose that happen to use the word.
const A201_LINES: SheetTextLine[] = [
  { pageNumber: 2, y: 0.0678, x: 0.8018, text: "( ELEVATION MATERIAL LEGEND :" },
  { pageNumber: 2, y: 0.3434, x: 0.2572, text: "FRONT ELEVATION - SOUTH" },
  { pageNumber: 2, y: 0.365, x: 0.7953, text: "EXTERIOR ELEVATION GENERAL NOTES :" },
  { pageNumber: 2, y: 0.5048, x: 0.8047, text: "ELEVATION HEIGHT NOTES :" },
  {
    pageNumber: 2,
    y: 0.5165,
    x: 0.7624,
    text: "* ARCHITECTURAL FOOTING AND FOUNDATION ELEVATION ARE RELATIVE TO ARCHITECTURAL MAIN FLOOR OF +",
  },
  { pageNumber: 2, y: 0.5222, x: 0.769, text: "0'-0\" ELEVATION." },
  { pageNumber: 2, y: 0.6497, x: 0.2572, text: "FRONT PROPERTY VIEW" },
  { pageNumber: 2, y: 0.8319, x: 0.9106, text: "ELEVATIONS" },
  { pageNumber: 2, y: 0.9004, x: 0.2572, text: "RIGHT ELEVATION - EAST" },
];

// Ground truth: all 28 mark callouts on that same sheet — the ones PR #127
// keeps OUT of the opening count — as [mark, x, y].
const A201_CALLOUTS: [string, number, number][] = [
  ["2", 0.4311, 0.5091],
  ["2", 0.4587, 0.5091],
  ["1", 0.4916, 0.5076],
  ["1", 0.5121, 0.5076],
  ["3", 0.4159, 0.4759],
  ["4", 0.3832, 0.5029],
  ["6", 0.3646, 0.4184],
  ["5", 0.3433, 0.5046],
  ["9", 0.3169, 0.5202],
  ["10", 0.2669, 0.5],
  ["11", 0.2182, 0.4797],
  ["27", 0.1504, 0.5085],
  ["21", 0.6272, 0.4736],
  ["3", 0.4086, 0.1996],
  ["4", 0.384, 0.2032],
  ["5", 0.3484, 0.2023],
  ["9", 0.3158, 0.2023],
  ["10", 0.2553, 0.2027],
  ["11", 0.2156, 0.1823],
  ["36", 0.4685, 0.225],
  ["21", 0.602, 0.2254],
  ["21", 0.3348, 0.8375],
  ["20", 0.3713, 0.8375],
  ["34", 0.4074, 0.8407],
  ["19", 0.4341, 0.7624],
  ["33", 0.4757, 0.8415],
  ["32", 0.5106, 0.8424],
  ["15", 0.5652, 0.7913],
];

const a201Callouts = A201_CALLOUTS.map(([mark, x, y]) => ({
  mark,
  pageNumber: 2,
  x,
  y,
  labelW: 0.0247,
  labelH: 0.0353,
}));

describe("parseViewTitle", () => {
  it("reads every drawing caption Black Desert actually uses", () => {
    expect(parseViewTitle("FRONT ELEVATION - SOUTH")).toEqual({
      raw: "FRONT ELEVATION - SOUTH",
      faces: ["FRONT"],
      compass: "SOUTH",
      kind: "elevation",
    });
    expect(parseViewTitle("REAR ELEVATION - NORTH")?.compass).toBe("NORTH");
    expect(parseViewTitle("LEFT ELEVATION - WEST")?.faces).toEqual(["LEFT"]);
    expect(parseViewTitle("FRONT PROPERTY VIEW")).toEqual({
      raw: "FRONT PROPERTY VIEW",
      faces: ["FRONT"],
      compass: null,
      kind: "view",
    });
    expect(parseViewTitle("REAR PROPERTY ELEVATION")?.kind).toBe("elevation");
  });

  it("tolerates the draughtsman's spelling of ELEVETAION", () => {
    // A.203 says "ELEVETAION" for both courtyard drawings. A typo is no reason
    // to leave a crew without a picture.
    expect(parseViewTitle("REAR RIGHT COURTYARD ELEVETAION")).toEqual({
      raw: "REAR RIGHT COURTYARD ELEVETAION",
      faces: ["REAR", "RIGHT", "COURTYARD"],
      compass: null,
      kind: "elevation",
    });
    expect(parseViewTitle("FRONT RIGHT COURTYARD ELEVETAION")?.faces).toEqual([
      "FRONT",
      "RIGHT",
      "COURTYARD",
    ]);
  });

  it("rejects every other line on the real sheet that says ELEVATION", () => {
    // Six of the ten matching lines on A.201 are not captions. If any of these
    // parsed, the page would be cut into regions at the wrong heights.
    const captions = A201_LINES.filter((line) => parseViewTitle(line.text)).map(
      (line) => line.text,
    );
    expect(captions).toEqual([
      "FRONT ELEVATION - SOUTH",
      "FRONT PROPERTY VIEW",
      "RIGHT ELEVATION - EAST",
    ]);
  });

  it("rejects the sheet title block, which names a page not a drawing", () => {
    expect(parseViewTitle("ELEVATIONS")).toBeNull();
    expect(parseViewTitle("EXTERIOR ELEVATIONS")).toBeNull();
    expect(parseViewTitle("EXTERIOR ELEVATIONS (COURTYARD)")).toBeNull();
  });

  it("rejects the floor plan's prose about elevations", () => {
    expect(
      parseViewTitle("VERIFY W/ THE EXTERIOR ELEVATION FOR THE SILL HEIGHT"),
    ).toBeNull();
    expect(parseViewTitle("SEE ELEVATION")).toBeNull();
    expect(parseViewTitle("")).toBeNull();
  });
});

describe("viewFaceKey", () => {
  const key = (raw: string) => viewFaceKey(parseViewTitle(raw)!);

  it("calls the front elevation and the front property view one face", () => {
    // The sheet's own two captions for the same wall both say FRONT. That is
    // the evidence for collapsing them, and the only evidence we have.
    expect(key("FRONT ELEVATION - SOUTH")).toBe(key("FRONT PROPERTY VIEW"));
    expect(key("REAR ELEVATION - NORTH")).toBe(key("REAR PROPERTY ELEVATION"));
  });

  it("keeps the courtyard walls separate from the front and rear of the house", () => {
    expect(key("FRONT RIGHT COURTYARD ELEVETAION")).not.toBe(
      key("FRONT ELEVATION - SOUTH"),
    );
    expect(key("REAR RIGHT COURTYARD ELEVETAION")).not.toBe(
      key("REAR ELEVATION - NORTH"),
    );
    expect(key("REAR RIGHT COURTYARD ELEVETAION")).not.toBe(
      key("FRONT RIGHT COURTYARD ELEVETAION"),
    );
  });

  it("ignores word order", () => {
    expect(key("RIGHT FRONT COURTYARD ELEVATION")).toBe(
      key("FRONT RIGHT COURTYARD ELEVETAION"),
    );
  });
});

describe("viewLabel", () => {
  it("names all eight real drawings the way a crew member would say it", () => {
    expect(viewLabel("FRONT ELEVATION - SOUTH")).toBe("Front of the house (south)");
    expect(viewLabel("FRONT PROPERTY VIEW")).toBe("Front of the house");
    expect(viewLabel("RIGHT ELEVATION - EAST")).toBe("Right side of the house (east)");
    expect(viewLabel("REAR ELEVATION - NORTH")).toBe("Back of the house (north)");
    expect(viewLabel("REAR PROPERTY ELEVATION")).toBe("Back of the house");
    expect(viewLabel("LEFT ELEVATION - WEST")).toBe("Left side of the house (west)");
    expect(viewLabel("REAR RIGHT COURTYARD ELEVETAION")).toBe("Courtyard (back right)");
    expect(viewLabel("FRONT RIGHT COURTYARD ELEVETAION")).toBe("Courtyard (front right)");
  });

  it("falls back to the compass alone when that is all the caption gave", () => {
    expect(viewLabel("ELEVATION - NORTH")).toBe("North side of the house");
  });

  it("shows nothing rather than something wrong when there is no caption", () => {
    // Smith Residence has no readable sheet text at all. Nothing is a better
    // answer than "page 3".
    expect(viewLabel(null)).toBeNull();
    expect(viewLabel(undefined)).toBeNull();
    expect(viewLabel("")).toBeNull();
    expect(viewLabel("A.201")).toBeNull();
    expect(viewLabel("EXTERIOR ELEVATIONS")).toBeNull();
  });
});

describe("viewRank", () => {
  it("leads with the straight elevation over a property view of the same wall", () => {
    const rank = (raw: string) => viewRank(parseViewTitle(raw)!);
    expect(rank("FRONT ELEVATION - SOUTH")).toBeGreaterThan(
      rank("FRONT PROPERTY VIEW"),
    );
    expect(rank("REAR ELEVATION - NORTH")).toBeGreaterThan(
      rank("REAR PROPERTY ELEVATION"),
    );
  });
});

describe("pageViewRegions", () => {
  it("cuts the real A.201 into its three drawings", () => {
    const regions = pageViewRegions(A201_LINES);
    expect(regions.map((r) => r.viewName)).toEqual([
      "FRONT ELEVATION - SOUTH",
      "FRONT PROPERTY VIEW",
      "RIGHT ELEVATION - EAST",
    ]);
    expect(regions.map((r) => r.regionIndex)).toEqual([0, 1, 2]);
  });

  it("gives each drawing the band above its own caption", () => {
    const [first, second, third] = pageViewRegions(A201_LINES);
    expect(first.top).toBe(0);
    expect(first.bottom).toBeCloseTo(0.3634, 4);
    expect(second.top).toBeCloseTo(0.3434, 4);
    expect(third.top).toBeCloseTo(0.6497, 4);
    expect(third.bottom).toBeCloseTo(0.9204, 4);
  });

  it("splits the sheet's 28 callouts 8 / 13 / 7, matching the drawings", () => {
    // Counted by hand off the rendered page: the south elevation carries 8
    // callouts, the property view of the same wall 13, the east elevation 7.
    const counts = pageViewRegions(A201_LINES).map(
      (region) =>
        a201Callouts.filter((c) => c.y >= region.top && c.y <= region.bottom).length,
    );
    expect(counts).toEqual([8, 13, 7]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(A201_CALLOUTS.length);
  });

  it("finds no drawings on a sheet with no readable text", () => {
    expect(pageViewRegions([])).toEqual([]);
    expect(pageViewRegions([{ pageNumber: 4, y: 0.5, x: 0.1, text: "A.204" }])).toEqual(
      [],
    );
  });
});

describe("regionCropBbox", () => {
  const region = { top: 0.3434, bottom: 0.6697, titleX: 0.2572 };

  it("reproduces the real crop box for the front property view", () => {
    const inRegion = a201Callouts.filter((c) => c.y >= region.top && c.y <= region.bottom);
    const [x0, y0, x1, y1] = regionCropBbox(region, inRegion);
    // Widest callouts are #27 at x=0.1504 and #21 at x=0.6272, padded by 0.1.
    expect(x0).toBeCloseTo(0.0504, 4);
    expect(x1).toBeCloseTo(0.7272, 4);
    // The band clamps the top; the bottom is the lowest callout plus padding.
    expect(y0).toBeCloseTo(0.3434, 4);
    expect(y1).toBeCloseTo(0.6302, 4);
  });

  it("never bleeds into the façade above or below", () => {
    const box = regionCropBbox(region, [{ x: 0.5, y: 0.35 }, { x: 0.5, y: 0.66 }]);
    expect(box[1]).toBeGreaterThanOrEqual(region.top);
    expect(box[3]).toBeLessThanOrEqual(region.bottom);
  });

  it("includes the caption's own x so the crop can show it", () => {
    // Sparse drawings would otherwise crop to a sliver around one number.
    const box = regionCropBbox({ ...region, titleX: 0.05 }, [{ x: 0.9, y: 0.5 }]);
    expect(box[0]).toBeLessThanOrEqual(0.05);
    expect(box[2]).toBeGreaterThanOrEqual(0.9);
  });

  it("stays inside the page", () => {
    const box = regionCropBbox({ top: 0, bottom: 1, titleX: 0.98 }, [
      { x: 0.01, y: 0.02 },
      { x: 0.99, y: 0.98 },
    ]);
    expect(box.every((n) => n >= 0 && n <= 1)).toBe(true);
  });
});

describe("calloutRingCircle", () => {
  const bbox = [0.05, 0.343, 0.727, 0.63] as const;
  const page = { pageWidth: 2600, pageHeight: 1733 };

  it("centres the ring on the number, in crop pixels", () => {
    const ring = calloutRingCircle({
      pin: { x: 0.3169, y: 0.5202 },
      label: { w: 0.0124, h: 0.0353 },
      bbox: [...bbox],
      ...page,
    });
    // Crop starts at x=0.05*2600=130, y=0.343*1733≈594.
    expect(ring.cx).toBeCloseTo(0.3169 * 2600 - 130, 0);
    expect(ring.cy).toBeCloseTo(0.5202 * 1733 - Math.floor(0.343 * 1733), 0);
  });

  it("sizes the ring from the number the draughtsman drew", () => {
    const small = calloutRingCircle({
      pin: { x: 0.3, y: 0.5 },
      label: { w: 0.0124, h: 0.0353 },
      bbox: [...bbox],
      ...page,
    });
    const wide = calloutRingCircle({
      pin: { x: 0.3, y: 0.5 },
      label: { w: 0.0247, h: 0.0353 },
      bbox: [...bbox],
      ...page,
    });
    // A two-digit mark is wider, but height still dominates at this page size.
    expect(small.r).toBeCloseTo(0.0353 * 1733 * 0.8, 1);
    expect(wide.r).toBeGreaterThanOrEqual(small.r);
    expect(small.lineWidth).toBeGreaterThanOrEqual(2);
  });

  it("falls back to a fraction of the crop when the label size is unknown", () => {
    const ring = calloutRingCircle({
      pin: { x: 0.3, y: 0.5 },
      label: { w: null, h: null },
      bbox: [...bbox],
      ...page,
    });
    expect(ring.r).toBeGreaterThan(10);
    expect(ring.r).toBeLessThan(0.287 * 1733 * 0.2);
  });

  it("can never cover the drawing it is pointing at", () => {
    const ring = calloutRingCircle({
      pin: { x: 0.3, y: 0.5 },
      label: { w: 5, h: 5 },
      bbox: [...bbox],
      ...page,
    });
    const cropHeight = (0.63 - 0.343) * 1733;
    expect(ring.r).toBeLessThanOrEqual(cropHeight * 0.2 + 1);
  });
});

describe("elevationAppearances", () => {
  const appearances = elevationAppearances({
    repeatViewCallouts: a201Callouts,
    lines: A201_LINES,
  });

  it("turns the real sheet's 28 callouts into 26 appearances", () => {
    // #2 and #1 are each written twice over a pair of identical windows in the
    // property view; a second ring on the same façade says nothing new.
    expect(appearances).toHaveLength(26);
  });

  it("keeps one appearance per mark per drawing, leftmost", () => {
    const region1 = appearances.filter((a) => a.regionIndex === 1);
    expect(region1.filter((a) => a.mark === "2")).toHaveLength(1);
    expect(region1.find((a) => a.mark === "2")?.pinX).toBeCloseTo(0.4311, 4);
    expect(region1.find((a) => a.mark === "1")?.pinX).toBeCloseTo(0.4916, 4);
  });

  it("records mark #9 twice — once per drawing of the south wall", () => {
    const nine = appearances.filter((a) => a.mark === "9");
    expect(nine.map((a) => a.viewName)).toEqual([
      "FRONT ELEVATION - SOUTH",
      "FRONT PROPERTY VIEW",
    ]);
    expect(nine[0].pinY).toBeCloseTo(0.2023, 4);
    expect(nine[1].pinY).toBeCloseTo(0.5202, 4);
  });

  it("gives every mark in one drawing the same crop box", () => {
    const region0 = appearances.filter((a) => a.regionIndex === 0);
    const boxes = new Set(region0.map((a) => JSON.stringify(a.cropBbox)));
    expect(boxes.size).toBe(1);
  });

  it("carries the label size through for the ring", () => {
    expect(appearances.every((a) => a.labelW === 0.0247)).toBe(true);
    expect(
      elevationAppearances({
        repeatViewCallouts: a201Callouts.map((c) => ({ ...c, labelW: undefined, labelH: undefined })),
        lines: A201_LINES,
      })[0].labelW,
    ).toBeNull();
  });

  it("stores nothing for a sheet whose drawings have no captions", () => {
    // Smith Residence. No caption means we cannot name the wall or tell it
    // apart from the next drawing, so there is nothing honest to show.
    expect(
      elevationAppearances({ repeatViewCallouts: a201Callouts, lines: [] }),
    ).toEqual([]);
  });

  it("stores nothing when no callouts were skipped", () => {
    // The only input is callouts an opening extract already refused to count,
    // so an all-floor-plan job produces no references and no rows.
    expect(
      elevationAppearances({ repeatViewCallouts: [], lines: A201_LINES }),
    ).toEqual([]);
  });

  it("drops callouts that fall outside every captioned drawing", () => {
    const stray = { mark: "99", pageNumber: 2, x: 0.5, y: 0.95 };
    const withStray = elevationAppearances({
      repeatViewCallouts: [...a201Callouts, stray],
      lines: A201_LINES,
    });
    expect(withStray.some((a) => a.mark === "99")).toBe(false);
  });
});

describe("pickElevationViews", () => {
  const row = (
    mark: string,
    page: number,
    region: number,
    view: string | null,
  ): ElevationViewLike => ({
    mark_code: mark,
    page_number: page,
    region_index: region,
    view_name: view,
    planset_id: "planset-1",
  });

  it("shows mark #9's two stored appearances as one wall", () => {
    // Real rows for #9: the south elevation and the property view of the same
    // wall. Same face, so one entry, and the straight elevation leads.
    const picked = pickElevationViews([
      row("9", 2, 0, "FRONT ELEVATION - SOUTH"),
      row("9", 2, 1, "FRONT PROPERTY VIEW"),
    ]);
    expect(picked).toHaveLength(1);
    expect(picked[0].view_name).toBe("FRONT ELEVATION - SOUTH");
  });

  it("keeps all three walls a real corner unit is drawn on", () => {
    // Mark #15's four real appearances: east, north, the north property view,
    // and the front-right courtyard. Only the two views of the north wall merge.
    const picked = pickElevationViews([
      row("15", 2, 2, "RIGHT ELEVATION - EAST"),
      row("15", 3, 0, "REAR ELEVATION - NORTH"),
      row("15", 3, 1, "REAR PROPERTY ELEVATION"),
      row("15", 4, 1, "FRONT RIGHT COURTYARD ELEVETAION"),
    ]);
    expect(picked.map((r) => r.view_name)).toEqual([
      "RIGHT ELEVATION - EAST",
      "REAR ELEVATION - NORTH",
      "FRONT RIGHT COURTYARD ELEVETAION",
    ]);
  });

  it("orders the sheet's preferred drawing first, then by page", () => {
    const picked = pickElevationViews([
      row("27", 3, 2, "LEFT ELEVATION - WEST"),
      row("27", 2, 1, "FRONT PROPERTY VIEW"),
    ]);
    expect(picked[0].view_name).toBe("LEFT ELEVATION - WEST");
  });

  it("does not merge rows it cannot read a caption from", () => {
    const picked = pickElevationViews([
      row("5", 2, 0, null),
      row("5", 3, 0, null),
      row("5", 2, 1, "FRONT ELEVATION - SOUTH"),
    ]);
    expect(picked).toHaveLength(3);
    expect(picked[0].view_name).toBe("FRONT ELEVATION - SOUTH");
  });

  it("is empty for a mark with no references", () => {
    expect(pickElevationViews([])).toEqual([]);
  });
});
