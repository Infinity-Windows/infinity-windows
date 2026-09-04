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
