// The Black Desert regression, end to end: a shop drawing that prints genuine
// half inches must survive the whole trip from the sheet to an installer's spec
// card without a single half inch being lost.
//
// The failure this pins down: `project_mark_specs.width_in` / `height_in` were
// `integer`, so every page whose sheet printed a fractional dimension was
// REJECTED by Postgres ("invalid input syntax for type integer: \"89.5\"") and
// the project got zero line-item specs. Widening the column is only half a fix —
// if any step on the client rounds, the crew still reads a size that's half an
// inch wrong, which is worse than an error because it looks fine. So this file
// walks the real values from the failing pages through every stage:
//
//   sheet transcription → parse → resolved size (the shape we STORE)
//     → the row PostgREST hands back → what the crew READS
//
// and asserts the number is byte-for-byte the same at each one.

import { describe, expect, it } from "vitest";
import { parsePrintedInches, resolveSpecSize } from "./printedSize";
import {
  formatFeetInches,
  formatInches,
  formatSize,
  normalizeSpec,
  parseSpecRow,
} from "./specs";
import { visionMarksToDrafts } from "./specsVision";

/**
 * The dimensions from the eleven Black Desert pages that failed, in the sheet's
 * own notation (millimetres with the manufacturer's inch equivalent in
 * parentheses) alongside the inch value Postgres rejected. Ground truth — these
 * are the values that produced the 22P02 errors in production.
 */
const BLACK_DESERT_PRINTED: { raw: string; inches: number }[] = [
  { raw: '901(35 1/2")', inches: 35.5 },
  { raw: '1511(59 1/2")', inches: 59.5 },
  { raw: '1816(71 1/2")', inches: 71.5 },
  { raw: '2273(89 1/2")', inches: 89.5 },
  { raw: '3035(119 1/2")', inches: 119.5 },
  { raw: '3492(137 1/2")', inches: 137.5 },
  { raw: '3645(143 1/2")', inches: 143.5 },
  { raw: '4559(179 1/2")', inches: 179.5 },
];

describe("Black Desert fractional dimensions — round trip", () => {
  it("reads every failing dimension off the sheet exactly", () => {
    for (const { raw, inches } of BLACK_DESERT_PRINTED) {
      expect(parsePrintedInches(raw)).toBe(inches);
    }
  });

  it("carries the half inch into the size we store", () => {
    // No decodable call size (this supplier doesn't use the 4-digit convention),
    // so the printed dimensions are the only source — and they must land whole.
    const size = resolveSpecSize({
      decodedWidthIn: null,
      decodedHeightIn: null,
      printedWidthIn: 89.5,
      printedHeightIn: 119.5,
    });
    expect(size).toMatchObject({ from: "printed", widthIn: 89.5, heightIn: 119.5 });
  });

  it("builds a draft row carrying 89.5, not 89 or 90", () => {
    const [draft] = visionMarksToDrafts([
      {
        mark: "Black Desert-#12",
        style: "Thermal Break Aluminum Fixed Window (Nail Fins)",
        glass: "5 (Low-E 366)+12A+5 (Low-E 366) Insulating tempered (argon)",
        color: "Black (Aluminum Profile Color)",
        size: "W-12 fixed",
        printed_width: '2273(89 1/2")',
        printed_height: '3035(119 1/2")',
      },
    ]);
    expect(draft.width_in).toBe(89.5);
    expect(draft.height_in).toBe(119.5);
    // The exact payload the upsert sends. A fractional value here is what an
    // `integer` column rejected outright.
    expect(Number.isInteger(draft.width_in as number)).toBe(false);
    expect(Number.isInteger(draft.height_in as number)).toBe(false);
    // The verbatim transcription rides along as the evidence for the number.
    expect(draft.extra).toMatchObject({
      printed_width: '2273(89 1/2")',
      printed_width_in: 89.5,
      printed_height_in: 119.5,
    });
  });

  it("reads a numeric column back off the wire without truncating", () => {
    // PostgREST hands `numeric` back as a JSON string, so the read path has to
    // survive "89.5" as well as 89.5.
    for (const { inches } of BLACK_DESERT_PRINTED) {
      const row = parseSpecRow({
        id: "11111111-1111-1111-1111-111111111111",
        project_id: "22222222-2222-2222-2222-222222222222",
        mark_code: "12",
        width_in: String(inches),
        height_in: String(inches),
        confirmed: false,
        source: "ai",
        created_at: "2026-07-28T00:00:00Z",
        updated_at: "2026-07-28T00:00:00Z",
      });
      expect(row?.width_in).toBe(inches);
      expect(row?.height_in).toBe(inches);
    }
  });

  it("shows a foreman-edited fractional value untouched", () => {
    // A foreman typing a measured 35 1/2" as 35.5 must not have it rounded.
    const spec = normalizeSpec(
      { mark_code: "12", width_in: "35.5", height_in: "71.5" },
      "manual",
    );
    expect(spec?.width_in).toBe(35.5);
    expect(spec?.height_in).toBe(71.5);
  });

  it("reads back to the crew as a fraction, never a decimal or a rounded inch", () => {
    for (const { inches } of BLACK_DESERT_PRINTED) {
      const shown = formatInches(inches);
      expect(shown).toBe(`${Math.floor(inches)}½"`);
      expect(shown).not.toContain(".");
      // The half inch is never swallowed into the next whole inch.
      expect(shown).not.toBe(`${Math.ceil(inches)}"`);
      expect(formatFeetInches(inches)).toContain("½");
    }
  });

  it("puts the whole trip together for the sheet's own strings", () => {
    const widthIn = parsePrintedInches('2273(89 1/2")');
    const heightIn = parsePrintedInches('3035(119 1/2")');
    const size = resolveSpecSize({
      decodedWidthIn: null,
      decodedHeightIn: null,
      printedWidthIn: widthIn,
      printedHeightIn: heightIn,
    });
    const row = parseSpecRow({
      id: "11111111-1111-1111-1111-111111111111",
      project_id: "22222222-2222-2222-2222-222222222222",
      mark_code: "12",
      width_in: String(size.widthIn),
      height_in: String(size.heightIn),
      confirmed: true,
      source: "ai",
      created_at: "2026-07-28T00:00:00Z",
      updated_at: "2026-07-28T00:00:00Z",
    });
    expect(formatSize(row!)).toBe("7'5½\" × 9'11½\" (89½\" × 119½\")");
  });
});

describe("Smith Residence whole inches stay pinned", () => {
  it("keeps 3060 reading exactly as it does today", () => {
    const [draft] = visionMarksToDrafts([
      {
        mark: "PV Townhomes Bldg 14-#1",
        size: "3060",
        // The sheet's 35 1/2" × 71 1/2" is inside tolerance of the nominal
        // 36 × 72 the call size names, so the NOMINAL size is what we keep.
        printed_width: '901(35 1/2")',
        printed_height: '1816(71 1/2")',
      },
    ]);
    expect(draft.width_in).toBe(36);
    expect(draft.height_in).toBe(72);
    expect(formatSize(draft)).toBe("3'0\" × 6'0\" (36\" × 72\")");
  });

  it("never dresses a whole inch up as a decimal or a fraction", () => {
    const shown = formatSize({ width_in: 36, height_in: 72, size_code: "3060" });
    expect(shown).not.toContain("36.0");
    expect(shown).not.toContain("½");
    expect(formatInches(36)).toBe('36"');
    expect(formatFeetInches(72)).toBe("6'0\"");
  });
});
