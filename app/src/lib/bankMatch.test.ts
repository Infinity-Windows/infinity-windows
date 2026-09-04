import { describe, expect, it } from "vitest";
import {
  daysBetween,
  proposeMatches,
  vendorOverlap,
  vendorTokens,
  withoutReceipts,
  type MatchableReceipt,
  type MatchableTransaction,
} from "./bankMatch";
import { openingMapping, parseDelimited, toBankRows } from "./bankImport";

function txn(
  id: string,
  amountCents: number,
  postedOn: string | null,
  description: string | null = null,
): MatchableTransaction {
  return {
    id,
    amountCents,
    postedOn,
    vendorGuess: description ? description.split(/\s+/).slice(0, 2).join(" ") : null,
    description,
  };
}

function receipt(
  id: string,
  amountCents: number | null,
  purchasedOn: string | null,
  vendor: string | null = null,
): MatchableReceipt {
  return { id, amountCents, purchasedOn, vendor };
}

describe("daysBetween", () => {
  it("counts whole days either way round", () => {
    expect(daysBetween("2026-08-25", "2026-08-28")).toBe(3);
    expect(daysBetween("2026-08-28", "2026-08-25")).toBe(3);
    expect(daysBetween("2026-08-25", "2026-08-25")).toBe(0);
  });

  it("is null when either day is missing or unreadable", () => {
    expect(daysBetween(null, "2026-08-25")).toBeNull();
    expect(daysBetween("2026-08-25", null)).toBeNull();
    expect(daysBetween("nonsense", "2026-08-25")).toBeNull();
  });
});

describe("vendorTokens", () => {
  it("drops punctuation, numbers and two-letter words", () => {
    // "of", "in" and "co" overlap between every vendor on earth.
    expect([...vendorTokens("HOME DEPOT #4512 OREM UT")].sort()).toEqual([
      "depot",
      "home",
      "orem",
    ]);
  });
});

describe("vendorOverlap", () => {
  it("agrees when the charge and the receipt name the same shop", () => {
    expect(
      vendorOverlap(txn("t", 100, "2026-08-25", "HOME DEPOT #4512 OREM UT"), receipt("r", 100, "2026-08-25", "Home Depot")),
    ).toBe(true);
  });

  it("does not agree on two different shops", () => {
    expect(
      vendorOverlap(txn("t", 100, "2026-08-25", "SHELL OIL LEHI"), receipt("r", 100, "2026-08-25", "Home Depot")),
    ).toBe(false);
  });
});

describe("proposeMatches", () => {
  it("pairs an equal amount inside the three-day window", () => {
    const pairs = proposeMatches(
      [txn("t1", 14713, "2026-08-25", "HOME DEPOT #4512")],
      [receipt("r1", 14713, "2026-08-23", "Home Depot")],
    );
    expect(pairs).toEqual([
      { transactionId: "t1", receiptId: "r1", daysApart: 2, vendorAgrees: true },
    ]);
  });

  it("never pairs two different amounts, however close the dates", () => {
    // Amount is an equality on purpose: two charges for different amounts are
    // never the same purchase.
    expect(
      proposeMatches(
        [txn("t1", 14713, "2026-08-25", "HOME DEPOT")],
        [receipt("r1", 14700, "2026-08-25", "Home Depot")],
      ),
    ).toEqual([]);
  });

  it("refuses anything more than three days apart", () => {
    expect(
      proposeMatches(
        [txn("t1", 5000, "2026-08-25")],
        [receipt("r1", 5000, "2026-08-29")],
      ),
    ).toEqual([]);
  });

  it("uses the vendor as the tiebreaker between two same-amount receipts", () => {
    const pairs = proposeMatches(
      [txn("t1", 6240, "2026-08-26", "SHELL OIL 574123 LEHI")],
      [
        // Closer in time, wrong shop.
        receipt("r_near", 6240, "2026-08-26", "Home Depot"),
        // A day further out, right shop — this is the one.
        receipt("r_shell", 6240, "2026-08-25", "Shell"),
      ],
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0].receiptId).toBe("r_shell");
    expect(pairs[0].vendorAgrees).toBe(true);
  });

  it("is one-to-one: one receipt never answers for two charges", () => {
    const pairs = proposeMatches(
      [txn("t1", 5000, "2026-08-25", "SHELL"), txn("t2", 5000, "2026-08-26", "SHELL")],
      [receipt("r1", 5000, "2026-08-25", "Shell")],
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0].transactionId).toBe("t1");
  });

  it("skips a charge or a receipt with no date rather than guessing", () => {
    expect(
      proposeMatches([txn("t1", 5000, null, "SHELL")], [receipt("r1", 5000, "2026-08-25", "Shell")]),
    ).toEqual([]);
    expect(
      proposeMatches([txn("t1", 5000, "2026-08-25", "SHELL")], [receipt("r1", 5000, null, "Shell")]),
    ).toEqual([]);
  });

  it("skips a receipt whose amount nobody has filled in yet", () => {
    expect(
      proposeMatches([txn("t1", 5000, "2026-08-25")], [receipt("r1", null, "2026-08-25")]),
    ).toEqual([]);
  });

  it("is stable — the same input proposes the same pairs every time", () => {
    const txns = [txn("t2", 5000, "2026-08-25", "SHELL"), txn("t1", 5000, "2026-08-25", "SHELL")];
    const receipts = [receipt("r2", 5000, "2026-08-25", "Shell"), receipt("r1", 5000, "2026-08-25", "Shell")];
    expect(proposeMatches(txns, receipts)).toEqual(proposeMatches(txns, receipts));
  });
});

describe("withoutReceipts", () => {
  it("is the whole question: which charges has nobody handed a receipt in for", () => {
    const rows = [
      { id: "a", status: "unreceipted", receiptId: null },
      { id: "b", status: "matched", receiptId: "r1" },
      // Somebody already said this one needs no receipt.
      { id: "c", status: "ignored", receiptId: null },
    ];
    expect(withoutReceipts(rows).map((r) => r.id)).toEqual(["a"]);
  });
});

// Wave Z review fix. Chase, Amex and most card exports write a PURCHASE as a
// negative number. The import used to carry that convention straight through, so
// every charge landed negative, no receipt could ever equal one (a receipt's
// amount cannot be negative — update_receipt refuses it), and the auto-match
// proposed nothing at all, forever, with nothing on screen to say why.
//
// The fix is upstream, in the mapping step, so these tests drive the whole path:
// a real negative-signed file -> toBankRows -> proposeMatches.
describe("a statement that writes purchases as negatives", () => {
  const CHASE = [
    "Transaction Date,Post Date,Description,Card Holder,Amount",
    "08/24/2026,08/25/2026,HOME DEPOT #4512 OREM UT,Maria G,-147.13",
    "08/25/2026,08/26/2026,SHELL OIL 574123 LEHI,Sam T,-62.40",
    // The one genuine refund in the month, positive the way the bank writes it.
    "08/26/2026,08/27/2026,HOME DEPOT #4512 OREM UT,Maria G,20.00",
  ].join("\n");

  const parsed = parseDelimited(CHASE);

  it("is spotted from the file, so the mapping step opens with the right answer", () => {
    const mapping = openingMapping("chase-2026-08.csv", parsed);
    expect(mapping.purchasesAreNegative).toBe(true);
  });

  it("imports purchases as money OUT and keeps the refund negative", () => {
    const mapping = openingMapping("chase-2026-08.csv", parsed);
    const rows = toBankRows(parsed, mapping);
    expect(rows.map((r) => r.amount_cents)).toEqual([14713, 6240, -2000]);
  });

  it("matches the receipt the bookkeeper handed in, which is the whole point", () => {
    const mapping = openingMapping("chase-2026-08.csv", parsed);
    const rows = toBankRows(parsed, mapping);
    const charges = rows.map((r, i) => ({
      id: `t${i}`,
      amountCents: r.amount_cents,
      postedOn: r.posted_on,
      vendorGuess: r.vendor_guess,
      description: r.description,
    }));
    const proposals = proposeMatches(charges, [
      receipt("r1", 14713, "2026-08-24", "Home Depot"),
    ]);
    expect(proposals).toEqual([
      { transactionId: "t0", receiptId: "r1", daysApart: 1, vendorAgrees: true },
    ]);
  });

  it("proposes NOTHING for a refund of the same size — a refund is not a purchase", () => {
    const mapping = openingMapping("chase-2026-08.csv", parsed);
    const rows = toBankRows(parsed, mapping);
    const refund = rows.find((r) => r.amount_cents < 0)!;
    const proposals = proposeMatches(
      [
        {
          id: "refund",
          amountCents: refund.amount_cents,
          postedOn: refund.posted_on,
          vendorGuess: refund.vendor_guess,
          description: refund.description,
        },
      ],
      [receipt("r2", 2000, "2026-08-26", "Home Depot")],
    );
    expect(proposals).toEqual([]);
  });

  it("reads an ordinary positive export exactly as before", () => {
    const plain = parseDelimited(
      ["Date,Description,Amount", "08/25/2026,HOME DEPOT #4512,147.13"].join("\n"),
    );
    const mapping = openingMapping("plain-2026-08.csv", plain);
    expect(mapping.purchasesAreNegative).toBe(false);
    expect(toBankRows(plain, mapping)[0].amount_cents).toBe(14713);
  });
});
