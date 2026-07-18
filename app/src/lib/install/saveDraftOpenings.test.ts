import { describe, expect, it } from "vitest";

/**
 * Pure merge used by saveDraftOpenings: when re-extracting, keep pin coords
 * from prior drafts that share an opening_code.
 */
function mergePreservedPins(
  drafts: {
    opening_code: string;
    page_number: number;
    pin_x: number | null;
    pin_y: number | null;
  }[],
  preserved: Map<
    string,
    { pin_x: number; pin_y: number; page_number: number }
  >,
) {
  return drafts.map((d) => {
    const kept = preserved.get(d.opening_code);
    return {
      ...d,
      page_number: kept?.page_number ?? d.page_number,
      pin_x: kept?.pin_x ?? d.pin_x,
      pin_y: kept?.pin_y ?? d.pin_y,
    };
  });
}

describe("preserve manual pins on re-extract", () => {
  it("restores pins for matching opening codes", () => {
    const preserved = new Map([
      ["6-1", { pin_x: 0.22, pin_y: 0.41, page_number: 3 }],
    ]);
    const merged = mergePreservedPins(
      [
        {
          opening_code: "6-1",
          page_number: 3,
          pin_x: 0.18,
          pin_y: 0.58,
        },
        {
          opening_code: "6-2",
          page_number: 3,
          pin_x: 0.3,
          pin_y: 0.58,
        },
      ],
      preserved,
    );
    expect(merged[0]).toMatchObject({
      opening_code: "6-1",
      pin_x: 0.22,
      pin_y: 0.41,
      page_number: 3,
    });
    expect(merged[1]).toMatchObject({
      opening_code: "6-2",
      pin_x: 0.3,
      pin_y: 0.58,
    });
  });
});
