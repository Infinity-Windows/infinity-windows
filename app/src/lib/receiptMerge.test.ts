import { describe, expect, it } from "vitest";
import {
  mergeReceiptExtraction,
  receiptFullyFilled,
  type ReceiptExtractableFields,
  type ReceiptExtraction,
} from "./receiptMerge";

const EMPTY: ReceiptExtractableFields = {
  amount_cents: null,
  vendor: null,
  purchased_on: null,
  category: null,
  category_by: null,
};

const READING: ReceiptExtraction = {
  amount_cents: 1250,
  vendor: "Home Depot",
  purchased_on: "2026-08-20",
  category: "other",
};

describe("mergeReceiptExtraction — THE LAW: fill-missing-only", () => {
  it("fills every blank field from the extraction on an empty receipt", () => {
    const merged = mergeReceiptExtraction(EMPTY, READING);
    expect(merged.amount_cents).toBe(1250);
    expect(merged.vendor).toBe("Home Depot");
    expect(merged.purchased_on).toBe("2026-08-20");
    expect(merged.category).toBe("other");
    expect(merged.category_by).toBe("ai");
  });

  it("never overwrites a human's typing — amount_cents already set", () => {
    const current: ReceiptExtractableFields = { ...EMPTY, amount_cents: 999 };
    const merged = mergeReceiptExtraction(current, READING);
    expect(merged.amount_cents).toBe(999);
  });

  it("never overwrites a human's typing — vendor already set", () => {
    const current: ReceiptExtractableFields = { ...EMPTY, vendor: "Lowe's" };
    const merged = mergeReceiptExtraction(current, READING);
    expect(merged.vendor).toBe("Lowe's");
  });

  it("never overwrites a human's typing — purchased_on already set", () => {
    const current: ReceiptExtractableFields = { ...EMPTY, purchased_on: "2026-01-01" };
    const merged = mergeReceiptExtraction(current, READING);
    expect(merged.purchased_on).toBe("2026-01-01");
  });

  it("fills only the fields that are actually blank, leaving the rest alone", () => {
    const current: ReceiptExtractableFields = {
      ...EMPTY,
      amount_cents: 500,
      vendor: null,
      purchased_on: null,
    };
    const merged = mergeReceiptExtraction(current, READING);
    expect(merged.amount_cents).toBe(500); // untouched
    expect(merged.vendor).toBe("Home Depot"); // filled
    expect(merged.purchased_on).toBe("2026-08-20"); // filled
  });

  it("a null field stays null when the extraction itself has nothing for it", () => {
    const merged = mergeReceiptExtraction(EMPTY, {
      amount_cents: null,
      vendor: null,
      purchased_on: null,
      category: null,
    });
    expect(merged).toEqual(EMPTY);
  });

  describe("category — the one field with a provenance lock", () => {
    it("fills category and stamps category_by='ai' when unset", () => {
      const merged = mergeReceiptExtraction(EMPTY, READING);
      expect(merged.category).toBe("other");
      expect(merged.category_by).toBe("ai");
    });

    it("a manual classification is never touched, even by a different reading", () => {
      const current: ReceiptExtractableFields = {
        ...EMPTY,
        category: "gas",
        category_by: "manual",
      };
      const merged = mergeReceiptExtraction(current, READING); // extraction says "other"
      expect(merged.category).toBe("gas");
      expect(merged.category_by).toBe("manual");
    });

    it("a prior AI fill is also never touched by a later merge (re-scan refreshes the machine's OWN future guesses, not by clobbering a category that already resolved)", () => {
      const current: ReceiptExtractableFields = {
        ...EMPTY,
        category: "gas",
        category_by: "ai",
      };
      const merged = mergeReceiptExtraction(current, READING); // extraction says "other"
      expect(merged.category).toBe("gas");
      expect(merged.category_by).toBe("ai");
    });

    it("leaves category null when neither side has one", () => {
      const merged = mergeReceiptExtraction(EMPTY, { ...READING, category: null });
      expect(merged.category).toBeNull();
      expect(merged.category_by).toBeNull();
    });
  });

  it("is pure — never mutates its inputs", () => {
    const current: ReceiptExtractableFields = { ...EMPTY };
    const frozenCurrent = Object.freeze({ ...current });
    const frozenReading = Object.freeze({ ...READING });
    expect(() => mergeReceiptExtraction(frozenCurrent, frozenReading)).not.toThrow();
    expect(frozenCurrent).toEqual(EMPTY);
  });
});

describe("receiptFullyFilled", () => {
  it("is false on a fresh receipt", () => {
    expect(receiptFullyFilled(EMPTY)).toBe(false);
  });

  it("is false when only some fields are filled", () => {
    expect(
      receiptFullyFilled({ ...EMPTY, amount_cents: 100, vendor: "Shell" }),
    ).toBe(false);
  });

  it("is true once amount/vendor/date/category are all set", () => {
    expect(
      receiptFullyFilled({
        amount_cents: 100,
        vendor: "Shell",
        purchased_on: "2026-08-20",
        category: "gas",
        category_by: "ai",
      }),
    ).toBe(true);
  });

  it("does not require category_by — category alone is enough (a legacy/manual row with the same shape)", () => {
    expect(
      receiptFullyFilled({
        amount_cents: 100,
        vendor: "Shell",
        purchased_on: "2026-08-20",
        category: "gas",
        category_by: null,
      }),
    ).toBe(true);
  });
});
