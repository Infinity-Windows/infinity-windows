// @vitest-environment happy-dom
// The remembered-mapping half of this module reads and writes localStorage, so
// the suite needs a browser-ish global — same reason featureTips.test.ts does.
import { beforeEach, describe, expect, it } from "vitest";
import {
  filenamePattern,
  guessMapping,
  normalizeDate,
  openingMapping,
  parseAmountToCents,
  parseDelimited,
  rememberMapping,
  rememberedMapping,
  toBankRows,
  undatedRows,
  unreadableRows,
  vendorGuess,
  type BankFieldMapping,
} from "./bankImport";

/**
 * A card export shaped the way real ones are: shouty descriptions with store
 * numbers, an accountant's parenthesised refund, a US-format date column, and a
 * header row whose words are nobody's idea of standard. The exact layout of the
 * owner's export is NOT known — that is precisely why the mapping step exists
 * and why this fixture deliberately does not use tidy names.
 */
const SAMPLE = [
  '"Posted Date","Card Holder","Description","Amount","Reference"',
  '"08/25/2026","Maria G","HOME DEPOT #4512 OREM UT","$147.13","TX-9001"',
  '"08/26/2026","Sam T","SHELL OIL 574123 LEHI","62.40","TX-9002"',
  '"08/27/2026","Maria G","HOME DEPOT #4512 OREM UT","(20.00)","TX-9003"',
  '"08/28/2026","Sam T","LUNCH MEETING","not a number","TX-9004"',
].join("\n");

describe("parseDelimited", () => {
  it("reads a quoted CSV into headers and rows", () => {
    const parsed = parseDelimited(SAMPLE);
    expect(parsed.headers).toEqual([
      "Posted Date",
      "Card Holder",
      "Description",
      "Amount",
      "Reference",
    ]);
    expect(parsed.rows).toHaveLength(4);
    expect(parsed.rows[0][2]).toBe("HOME DEPOT #4512 OREM UT");
  });

  it("keeps a comma that lives inside a quoted field", () => {
    const parsed = parseDelimited('a,b\n"OREM, UT",5');
    expect(parsed.rows[0]).toEqual(["OREM, UT", "5"]);
  });

  it("reads a doubled quote as one literal quote", () => {
    const parsed = parseDelimited('a\n"say ""hi"""');
    expect(parsed.rows[0][0]).toBe('say "hi"');
  });

  it("reads a tab-separated export too", () => {
    const parsed = parseDelimited("date\tamount\n2026-08-25\t12.50");
    expect(parsed.headers).toEqual(["date", "amount"]);
    expect(parsed.rows[0]).toEqual(["2026-08-25", "12.50"]);
  });

  it("survives an empty file rather than throwing at a person", () => {
    expect(parseDelimited("")).toEqual({ headers: [], rows: [] });
  });

  it("drops the UTF-8 BOM Excel writes, so the first header is not '\\ufeffDate'", () => {
    const parsed = parseDelimited("﻿Date,Amount\n2026-08-25,1.00");
    expect(parsed.headers[0]).toBe("Date");
  });
});

describe("guessMapping", () => {
  it("offers a sensible opening guess for a real header row", () => {
    const parsed = parseDelimited(SAMPLE);
    expect(guessMapping(parsed.headers)).toEqual({
      postedOn: "Posted Date",
      amount: "Amount",
      description: "Description",
      cardholder: "Card Holder",
      externalId: "Reference",
    });
  });

  it("prefers the POSTED date over a bare Date column beside it", () => {
    // On most exports the bare "Date" is the settlement date, which drifts.
    expect(guessMapping(["Date", "Posted", "Amount"]).postedOn).toBe("Posted");
  });

  it("says null rather than guessing when nothing looks right", () => {
    const guess = guessMapping(["col1", "col2"]);
    expect(guess.amount).toBeNull();
    expect(guess.postedOn).toBeNull();
  });
});

describe("parseAmountToCents", () => {
  it("reads the shapes an export actually uses", () => {
    expect(parseAmountToCents("$147.13")).toBe(14713);
    expect(parseAmountToCents("1,234.56")).toBe(123456);
    expect(parseAmountToCents("62")).toBe(6200);
  });

  it("treats accountant parentheses as the minus sign they are", () => {
    // A refund read as a charge would flip the sign on real money.
    expect(parseAmountToCents("(20.00)")).toBe(-2000);
    expect(parseAmountToCents("-20.00")).toBe(-2000);
  });

  it("refuses a cell that is not a number, so a mis-mapped column shows up", () => {
    expect(parseAmountToCents("not a number")).toBeNull();
    expect(parseAmountToCents("")).toBeNull();
    expect(parseAmountToCents("  ")).toBeNull();
  });
});

describe("normalizeDate", () => {
  it("reads ISO and US spellings", () => {
    expect(normalizeDate("2026-08-25")).toBe("2026-08-25");
    expect(normalizeDate("08/25/2026")).toBe("2026-08-25");
    expect(normalizeDate("8/5/26")).toBe("2026-08-05");
  });

  // Every one of these turned up as null before the review fix, so a file
  // spelling its dates this way imported every charge with posted_on null —
  // silently, because a dateless row is still a real charge and is kept.
  it("reads the other unambiguous spellings real exports use", () => {
    expect(normalizeDate("2026/08/25")).toBe("2026-08-25");
    expect(normalizeDate("2026.08.25")).toBe("2026-08-25");
    expect(normalizeDate("20260825")).toBe("2026-08-25");
    expect(normalizeDate("Aug 25, 2026")).toBe("2026-08-25");
    expect(normalizeDate("August 25 2026")).toBe("2026-08-25");
    expect(normalizeDate("25 Aug 2026")).toBe("2026-08-25");
    expect(normalizeDate("25-Aug-2026")).toBe("2026-08-25");
  });

  it("still refuses anything ambiguous instead of letting Date guess", () => {
    // A statement imported a day out would silently break the ±3-day window.
    expect(normalizeDate("")).toBeNull();
    expect(normalizeDate("13/45/2026")).toBeNull();
    // 12 August or 8 December? Nobody can tell, so neither will this.
    expect(normalizeDate("12.08.2026")).toBeNull();
    // Eight digits that do not start with a year are somebody's M/D/YYYY with
    // the separators stripped — not a compact ISO date.
    expect(normalizeDate("08252026")).toBeNull();
    expect(normalizeDate("Smarch 25, 2026")).toBeNull();
    expect(normalizeDate("last Tuesday")).toBeNull();
  });
});

describe("vendorGuess", () => {
  it("keeps the name and drops the store number and city noise", () => {
    expect(vendorGuess("HOME DEPOT #4512 OREM UT")).toBe("HOME DEPOT OREM");
    expect(vendorGuess("SHELL OIL 574123 LEHI")).toBe("SHELL OIL LEHI");
  });

  it("is null for nothing at all", () => {
    expect(vendorGuess(null)).toBeNull();
    expect(vendorGuess("")).toBeNull();
  });
});

describe("toBankRows", () => {
  const parsed = parseDelimited(SAMPLE);
  const mapping = guessMapping(parsed.headers);

  it("maps a confirmed layout into the rows the import RPC wants", () => {
    const rows = toBankRows(parsed, mapping);
    expect(rows[0]).toEqual({
      posted_on: "2026-08-25",
      amount_cents: 14713,
      description: "HOME DEPOT #4512 OREM UT",
      vendor_guess: "HOME DEPOT OREM",
      cardholder: "Maria G",
      external_id: "TX-9001",
    });
  });

  it("DROPS a row whose amount cannot be read rather than importing a zero", () => {
    // A statement with phantom $0 charges on it looks complete and is not.
    const rows = toBankRows(parsed, mapping);
    expect(rows).toHaveLength(3);
    expect(rows.some((r) => r.description === "LUNCH MEETING")).toBe(false);
    expect(unreadableRows(parsed, mapping)).toBe(1);
  });

  it("leaves a field blank when its column was mapped to nothing", () => {
    const noHolder: BankFieldMapping = { ...mapping, cardholder: null };
    expect(toBankRows(parsed, noHolder)[0].cardholder).toBeNull();
  });

  // The mapping step used to check the Amount column and nothing else, so a
  // Date column pointed at the wrong header — or spelled in a way this app
  // cannot read — imported every charge dateless and silently: the rows are
  // kept, nothing looks wrong, and auto-match then proposes nothing forever.
  it("counts the rows that will import with no date, so the mapping step can say so", () => {
    expect(undatedRows(parsed, mapping)).toBe(0);
    const wrongDateColumn: BankFieldMapping = { ...mapping, postedOn: "Merchant" };
    expect(undatedRows(parsed, wrongDateColumn)).toBe(3);
    // Still counted as importable — a dateless charge is a real charge, so it
    // is kept, which is exactly why the warning has to exist.
    expect(unreadableRows(parsed, wrongDateColumn)).toBe(1);
    const noDateColumn: BankFieldMapping = { ...mapping, postedOn: null };
    expect(undatedRows(parsed, noDateColumn)).toBe(3);
  });
});

describe("the remembered mapping", () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      /* nothing to clear */
    }
  });

  it("treats two months of the same export as one pattern", () => {
    expect(filenamePattern("statement-2026-08.csv")).toBe(
      filenamePattern("statement-2026-09.csv"),
    );
    expect(filenamePattern("Statement-2026-08.csv")).toBe("statement-#-#.csv");
  });

  it("hands back what a human confirmed last month", () => {
    const parsed = parseDelimited(SAMPLE);
    const confirmed: BankFieldMapping = {
      ...guessMapping(parsed.headers),
      // The human corrected the guess — that correction is the thing worth
      // remembering.
      description: "Card Holder",
    };
    rememberMapping("statement-2026-08.csv", confirmed);
    expect(rememberedMapping("statement-2026-09.csv")).toEqual(confirmed);
    expect(openingMapping("statement-2026-09.csv", parsed.headers).description).toBe(
      "Card Holder",
    );
  });

  it("falls back to the guess for a column the new file no longer has", () => {
    rememberMapping("statement-2026-08.csv", {
      postedOn: "Gone Column",
      amount: "Amount",
      description: null,
      cardholder: null,
      externalId: null,
    });
    const parsed = parseDelimited(SAMPLE);
    const opening = openingMapping("statement-2026-09.csv", parsed.headers);
    expect(opening.postedOn).toBe("Posted Date");
    expect(opening.amount).toBe("Amount");
  });

  it("guesses fresh for a file nobody has mapped before", () => {
    expect(rememberedMapping("brand-new-export.csv")).toBeNull();
  });
});
