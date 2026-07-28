import { describe, expect, it } from "vitest";
import {
  checkSpecSize,
  compareSizes,
  listSizeMismatches,
  parsePrintedInches,
  readPrintedSize,
  resolveSpecSize,
  sizeMismatchRecord,
  sizeToleranceFor,
  SIZE_TOLERANCE_IN,
} from "./printedSize";

// Dimensions transcribed verbatim off the STRATA shop drawing for PV Townhomes
// Bldg 14 (the Smith job): millimetres with the manufacturer's own inch
// equivalent in parentheses. These strings are ground truth — they are exactly
// what vision reads off the sheet.
const SMITH_PRINTED = {
  mark1Width: '901(35 1/2")',
  mark1Height: '1816(71 1/2")',
  mark5Height: '1802(71")',
  mark9Height: '2425(95 1/2")',
  transomHeight: '596(23 1/2")',
};

describe("parsePrintedInches", () => {
  it("reads the manufacturer's parenthesised inch equivalent", () => {
    expect(parsePrintedInches(SMITH_PRINTED.mark1Width)).toBe(35.5);
    expect(parsePrintedInches(SMITH_PRINTED.mark1Height)).toBe(71.5);
    expect(parsePrintedInches(SMITH_PRINTED.mark5Height)).toBe(71);
    expect(parsePrintedInches(SMITH_PRINTED.mark9Height)).toBe(95.5);
    expect(parsePrintedInches(SMITH_PRINTED.transomHeight)).toBe(23.5);
  });

  it("reads a bare inch measurement", () => {
    expect(parsePrintedInches('35 1/2"')).toBe(35.5);
    expect(parsePrintedInches('72"')).toBe(72);
    expect(parsePrintedInches('95.5"')).toBe(95.5);
    expect(parsePrintedInches('1/2"')).toBe(0.5);
    expect(parsePrintedInches("36 in")).toBe(36);
    expect(parsePrintedInches("36 inches")).toBe(36);
  });

  it("reads unicode vulgar fractions", () => {
    expect(parsePrintedInches('35½"')).toBe(35.5);
    expect(parsePrintedInches('35 ½"')).toBe(35.5);
    expect(parsePrintedInches('23¼"')).toBe(23.25);
    expect(parsePrintedInches('71¾"')).toBe(71.75);
    expect(parsePrintedInches('35⅜"')).toBe(35.375);
    expect(parsePrintedInches('35⅝"')).toBe(35.625);
    expect(parsePrintedInches('35⅞"')).toBe(35.875);
    expect(parsePrintedInches('901(35½")')).toBe(35.5);
  });

  it("reads feet-and-inches", () => {
    expect(parsePrintedInches("3'0\"")).toBe(36);
    expect(parsePrintedInches("2'8 1/2\"")).toBe(32.5);
    expect(parsePrintedInches("6'0\"")).toBe(72);
    expect(parsePrintedInches("8'")).toBe(96);
    expect(parsePrintedInches("2'8½\"")).toBe(32.5);
  });

  it("accepts the unicode prime and double-prime marks", () => {
    expect(parsePrintedInches("3\u20320\u2033")).toBe(36);
    expect(parsePrintedInches("35 1/2\u2033")).toBe(35.5);
    expect(parsePrintedInches("901(35 1/2\u201D)")).toBe(35.5);
  });

  it("falls back to millimetres when no inch part is printed", () => {
    // 901 / 25.4 = 35.47…
    expect(parsePrintedInches("901")).toBe(35.47);
    expect(parsePrintedInches("1816")).toBe(71.5);
    expect(parsePrintedInches("901mm")).toBe(35.47);
    expect(parsePrintedInches("901 mm")).toBe(35.47);
    expect(parsePrintedInches(901)).toBe(35.47);
  });

  it("refuses to read a small bare number as millimetres", () => {
    // "36" is far likelier an inch figure that lost its mark than 36mm, and
    // reading it as 1.4" would override a perfectly good 36" call size.
    expect(parsePrintedInches("36")).toBeNull();
    expect(parsePrintedInches("72")).toBeNull();
    expect(parsePrintedInches("99")).toBeNull();
    // …unless the sheet says "mm" out loud.
    expect(parsePrintedInches("96mm")).toBe(3.78);
  });

  it("keeps the millimetre figure when the parenthetical is unreadable", () => {
    expect(parsePrintedInches("1816(???)")).toBe(71.5);
    expect(parsePrintedInches("901 (approx)")).toBe(35.47);
  });

  it("tolerates the whitespace and newlines a PDF text layer introduces", () => {
    expect(parsePrintedInches('  901(35 1/2")  ')).toBe(35.5);
    expect(parsePrintedInches('901 ( 35 1/2" )')).toBe(35.5);
    expect(parsePrintedInches('35\n1/2"')).toBe(35.5);
    expect(parsePrintedInches('35 1 /\n2"')).toBe(35.5);
    // The text layer sometimes drops the slash entirely, one number per line.
    expect(parsePrintedInches('35\n1\n2"')).toBe(35.5);
    expect(parsePrintedInches('901(35\n1\n2")')).toBe(35.5);
    expect(parsePrintedInches("\t1802 ( 71\" )\n")).toBe(71);
  });

  it("returns null for anything it cannot read, and never throws", () => {
    for (const junk of [
      null,
      undefined,
      "",
      "   ",
      "\n",
      "n/a",
      "N/A",
      "-",
      "TBD",
      "see detail",
      "abc",
      '"',
      "()",
      "(  )",
      "900x1800",
      "35/",
      '35 1/0"',
      {},
      [],
      NaN,
      true,
    ]) {
      expect(parsePrintedInches(junk)).toBeNull();
    }
  });

  it("rejects implausible dimensions rather than trusting them", () => {
    // 999999mm is 39,370" — a mis-transcription, not a window.
    expect(parsePrintedInches("999999")).toBeNull();
    expect(parsePrintedInches('9999"')).toBeNull();
    expect(parsePrintedInches("0")).toBeNull();
    expect(parsePrintedInches('0"')).toBeNull();
  });

  it("does not read a slash-less fraction with an implausible denominator", () => {
    // "35 1 7" is not 35 1/7 of an inch; no tape measure has sevenths.
    expect(parsePrintedInches('35 1 7"')).toBeNull();
    // Nor when the numerator is not smaller than the denominator.
    expect(parsePrintedInches('35 4 2"')).toBeNull();
  });
});

describe("sizeToleranceFor", () => {
  it("is a flat two inches on ordinary units", () => {
    expect(SIZE_TOLERANCE_IN).toBe(2);
    expect(sizeToleranceFor(35.5)).toBe(2);
    expect(sizeToleranceFor(24)).toBe(2);
  });

  it("scales to 5% on big units, where nominal slack is bigger", () => {
    expect(sizeToleranceFor(96)).toBeCloseTo(4.8, 5);
    expect(sizeToleranceFor(120)).toBeCloseTo(6, 5);
  });
});

describe("compareSizes", () => {
  it("treats nominal slack as a match — a call size is deliberately bigger", () => {
    // Smith mark 1: "3060" decodes to 36 × 72; the sheet prints 35.5 × 71.5.
    const result = compareSizes({
      decodedWidthIn: 36,
      decodedHeightIn: 72,
      printedWidthIn: 35.5,
      printedHeightIn: 71.5,
    });
    expect(result.status).toBe("match");
    expect(result.deltaWidthIn).toBe(0.5);
    expect(result.deltaHeightIn).toBe(0.5);
  });

  it("catches an inch-convention code decoded as feet+inches", () => {
    // "3672" meant 36" × 72"; feet+inches turns it into 42" × 86".
    const result = compareSizes({
      decodedWidthIn: 42,
      decodedHeightIn: 86,
      printedWidthIn: 36,
      printedHeightIn: 72,
    });
    expect(result.status).toBe("mismatch");
    expect(result.deltaWidthIn).toBe(6);
    expect(result.deltaHeightIn).toBe(14);
  });

  it("flags a disagreement on either axis alone", () => {
    expect(
      compareSizes({
        decodedWidthIn: 36,
        decodedHeightIn: 96,
        printedWidthIn: 35.5,
        printedHeightIn: 71.5,
      }).status,
    ).toBe("mismatch");
    expect(
      compareSizes({
        decodedWidthIn: 48,
        decodedHeightIn: 72,
        printedWidthIn: 35.5,
        printedHeightIn: 71.5,
      }).status,
    ).toBe("mismatch");
  });

  it("compares an axis only when both numbers exist", () => {
    const heightOnly = compareSizes({
      decodedWidthIn: 36,
      decodedHeightIn: 72,
      printedWidthIn: null,
      printedHeightIn: 71.5,
    });
    expect(heightOnly.status).toBe("match");
    expect(heightOnly.deltaWidthIn).toBeNull();
    expect(heightOnly.deltaHeightIn).toBe(0.5);

    const badHeightOnly = compareSizes({
      decodedWidthIn: 36,
      decodedHeightIn: 86,
      printedWidthIn: null,
      printedHeightIn: 72,
    });
    expect(badHeightOnly.status).toBe("mismatch");
  });

  it("is 'unknown' when there is nothing to compare", () => {
    for (const input of [
      { decodedWidthIn: null, decodedHeightIn: null, printedWidthIn: 36, printedHeightIn: 72 },
      { decodedWidthIn: 36, decodedHeightIn: 72, printedWidthIn: null, printedHeightIn: null },
      { decodedWidthIn: null, decodedHeightIn: null, printedWidthIn: null, printedHeightIn: null },
    ]) {
      const result = compareSizes(input);
      expect(result.status).toBe("unknown");
      expect(result.deltaWidthIn).toBeNull();
      expect(result.deltaHeightIn).toBeNull();
    }
  });

  it("allows more slack on a big unit via the 5% floor", () => {
    // A 96" slider 3" out is within 5%; the same 3" on a 24" transom is not.
    expect(
      compareSizes({
        decodedWidthIn: 72,
        decodedHeightIn: 96,
        printedWidthIn: 72,
        printedHeightIn: 93,
      }).status,
    ).toBe("match");
    expect(
      compareSizes({
        decodedWidthIn: 24,
        decodedHeightIn: 27,
        printedWidthIn: 24,
        printedHeightIn: 24,
      }).status,
    ).toBe("mismatch");
  });

  it("honours an explicit tolerance", () => {
    const input = {
      decodedWidthIn: 36,
      decodedHeightIn: 72,
      printedWidthIn: 35.5,
      printedHeightIn: 71.5,
    };
    // The 5% floor still applies unless the caller turns it off too.
    expect(compareSizes(input, 0.25).status).toBe("match");
    expect(compareSizes(input, 0.25, 0).status).toBe("mismatch");
    expect(compareSizes(input, 6).status).toBe("match");
  });
});

describe("resolveSpecSize", () => {
  it("keeps the nominal decoded size when the sheet agrees", () => {
    const size = resolveSpecSize({
      decodedWidthIn: 36,
      decodedHeightIn: 72,
      printedWidthIn: 35.5,
      printedHeightIn: 71.5,
    });
    expect(size.from).toBe("decoded");
    expect(size.widthIn).toBe(36);
    expect(size.heightIn).toBe(72);
    expect(size.comparison.status).toBe("match");
  });

  it("prefers the printed dimensions when they disagree", () => {
    const size = resolveSpecSize({
      decodedWidthIn: 42,
      decodedHeightIn: 86,
      printedWidthIn: 36,
      printedHeightIn: 72,
    });
    expect(size.from).toBe("printed");
    expect(size.widthIn).toBe(36);
    expect(size.heightIn).toBe(72);
    expect(size.comparison.status).toBe("mismatch");
  });

  it("uses whichever side exists on its own", () => {
    expect(
      resolveSpecSize({
        decodedWidthIn: null,
        decodedHeightIn: null,
        printedWidthIn: 35.5,
        printedHeightIn: 71.5,
      }),
    ).toMatchObject({ from: "printed", widthIn: 35.5, heightIn: 71.5 });

    expect(
      resolveSpecSize({
        decodedWidthIn: 36,
        decodedHeightIn: 72,
        printedWidthIn: null,
        printedHeightIn: null,
      }),
    ).toMatchObject({ from: "decoded", widthIn: 36, heightIn: 72 });

    expect(
      resolveSpecSize({
        decodedWidthIn: null,
        decodedHeightIn: null,
        printedWidthIn: null,
        printedHeightIn: null,
      }),
    ).toMatchObject({ from: "none", widthIn: null, heightIn: null });
  });

  it("fills a missing printed axis from the decode on a mismatch", () => {
    const size = resolveSpecSize({
      decodedWidthIn: 42,
      decodedHeightIn: 86,
      printedWidthIn: null,
      printedHeightIn: 72,
    });
    expect(size.from).toBe("printed");
    expect(size.widthIn).toBe(42);
    expect(size.heightIn).toBe(72);
  });
});

describe("readPrintedSize", () => {
  it("reads the verbatim strings and stored inches out of extra", () => {
    expect(
      readPrintedSize({
        qty: "2",
        printed_width: SMITH_PRINTED.mark1Width,
        printed_height: SMITH_PRINTED.mark1Height,
        printed_width_in: 35.5,
        printed_height_in: 71.5,
      }),
    ).toEqual({
      widthRaw: SMITH_PRINTED.mark1Width,
      heightRaw: SMITH_PRINTED.mark1Height,
      widthIn: 35.5,
      heightIn: 71.5,
    });
  });

  it("re-derives the inches when only the verbatim strings were stored", () => {
    const printed = readPrintedSize({
      printed_width: SMITH_PRINTED.mark1Width,
      printed_height: SMITH_PRINTED.mark5Height,
    });
    expect(printed.widthIn).toBe(35.5);
    expect(printed.heightIn).toBe(71);
  });

  it("is empty for legacy rows and junk", () => {
    const empty = {
      widthRaw: null,
      heightRaw: null,
      widthIn: null,
      heightIn: null,
    };
    expect(readPrintedSize(null)).toEqual(empty);
    expect(readPrintedSize(undefined)).toEqual(empty);
    expect(readPrintedSize({})).toEqual(empty);
    expect(readPrintedSize({ qty: "2" })).toEqual(empty);
    expect(readPrintedSize("nope")).toEqual(empty);
    expect(readPrintedSize([1, 2])).toEqual(empty);
    expect(readPrintedSize({ printed_width: "  ", printed_height: null })).toEqual(
      empty,
    );
  });
});

describe("sizeMismatchRecord", () => {
  it("records what disagreed and by how much", () => {
    expect(sizeMismatchRecord("3672", 36, 72)).toEqual({
      size_code: "3672",
      decoded_width_in: 42,
      decoded_height_in: 86,
      printed_width_in: 36,
      printed_height_in: 72,
      delta_width_in: 6,
      delta_height_in: 14,
    });
  });

  it("is null when there is nothing to record", () => {
    expect(sizeMismatchRecord("3060", 35.5, 71.5)).toBeNull();
    expect(sizeMismatchRecord("3060", null, null)).toBeNull();
    expect(sizeMismatchRecord(null, 36, 72)).toBeNull();
    expect(sizeMismatchRecord("900x1800", 36, 72)).toBeNull();
  });
});

describe("checkSpecSize", () => {
  it("says nothing about the real Smith mark 1 — the code and sheet agree", () => {
    expect(
      checkSpecSize({
        mark_code: "1",
        size_code: "3060",
        extra: {
          qty: "2",
          printed_width: SMITH_PRINTED.mark1Width,
          printed_height: SMITH_PRINTED.mark1Height,
          printed_width_in: 35.5,
          printed_height_in: 71.5,
        },
      }),
    ).toBeNull();
  });

  it("explains an inch-convention code in words a foreman can act on", () => {
    const mismatch = checkSpecSize({
      mark_code: "7",
      size_code: "3672",
      extra: { printed_width: '36"', printed_height: '72"' },
    });
    expect(mismatch).not.toBeNull();
    expect(mismatch?.message).toBe(
      'Mark 7: code 3672 decodes to 42" x 86" but the sheet prints 36" x 72" ' +
        "— check the size convention.",
    );
    expect(mismatch?.decodedWidthIn).toBe(42);
    expect(mismatch?.printedWidthIn).toBe(36);
  });

  it("stays quiet without printed dimensions or a decodable code", () => {
    expect(checkSpecSize({ mark_code: "1", size_code: "3060" })).toBeNull();
    expect(checkSpecSize({ mark_code: "1", size_code: "3060", extra: null })).toBeNull();
    expect(
      checkSpecSize({
        mark_code: "1",
        size_code: null,
        extra: { printed_width: '36"', printed_height: '72"' },
      }),
    ).toBeNull();
    expect(
      checkSpecSize({
        mark_code: "1",
        size_code: "6080 XO",
        extra: { printed_width: '36"', printed_height: '72"' },
      }),
    ).toBeNull();
  });
});

describe("listSizeMismatches", () => {
  const clean = {
    mark_code: "1",
    size_code: "3060",
    extra: {
      printed_width: SMITH_PRINTED.mark1Width,
      printed_height: SMITH_PRINTED.mark1Height,
    },
  };
  const badSeven = {
    mark_code: "7",
    size_code: "3672",
    extra: { printed_width: '36"', printed_height: '72"' },
  };
  const badTwelve = {
    mark_code: "12",
    size_code: "2436",
    extra: { printed_width: '24"', printed_height: '36"' },
  };

  it("is empty when every mark checks out", () => {
    expect(listSizeMismatches([clean, { mark_code: "2", size_code: "6080" }])).toEqual(
      [],
    );
    expect(listSizeMismatches([])).toEqual([]);
  });

  it("lists the disagreeing marks in mark order", () => {
    const found = listSizeMismatches([badTwelve, clean, badSeven]);
    expect(found.map((m) => m.mark)).toEqual(["7", "12"]);
  });

  it("survives junk rows", () => {
    const rows = [null, undefined, {}, badSeven] as unknown as Parameters<
      typeof listSizeMismatches
    >[0];
    expect(listSizeMismatches(rows).map((m) => m.mark)).toEqual(["7"]);
  });
});
