// Wave Z, Z5: which card charge is which receipt.
//
// The rule, in the owner's words: equal amount, posted within three days of the
// purchase, and vendor overlap as the tiebreaker — one charge to one receipt,
// one receipt to one charge. Everything here is pure so it can be argued with
// in a test rather than in production.
//
// AMOUNT IS NEVER FUZZY. Two charges a day apart for $47.13 are the same
// purchase far more often than they are two purchases; two charges for
// different amounts are never the same purchase. So the amount is an equality
// and the date is the window, not the other way round.
//
// The equality includes the SIGN, and that is deliberate. In this app money out
// is positive and a refund is negative; a receipt's amount can never be
// negative at all (update_receipt refuses one), so a refund matching a receipt
// would always be wrong and is never proposed. What made this look like a bug
// was upstream: most card exports write purchases as negatives, and the import
// used to carry that convention straight through, so every charge arrived
// negative and nothing ever matched. That is fixed where it belongs — the
// mapping step now asks which way round the file is (bankImport.ts,
// `purchasesAreNegative`) and toBankRows flips it once, so everything
// downstream reads one convention. Comparing magnitudes here instead would
// have hidden that and started proposing refunds as if they were purchases.

export interface MatchableTransaction {
  id: string;
  amountCents: number;
  postedOn: string | null;
  vendorGuess: string | null;
  description: string | null;
}

export interface MatchableReceipt {
  id: string;
  amountCents: number | null;
  purchasedOn: string | null;
  vendor: string | null;
}

export interface ProposedMatch {
  transactionId: string;
  receiptId: string;
  /** Days between the charge and the purchase, for the person deciding. */
  daysApart: number;
  /** True when the vendor words overlap — the tiebreaker, surfaced. */
  vendorAgrees: boolean;
}

/** Whole days between two "YYYY-MM-DD" days, or null if either is missing. */
export function daysBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const left = Date.parse(`${a}T00:00:00Z`);
  const right = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(left) || Number.isNaN(right)) return null;
  return Math.round(Math.abs(left - right) / 86_400_000);
}

/**
 * Words worth comparing between a card description and a receipt's vendor.
 * Lowercased, punctuation and store numbers gone, and anything under three
 * letters dropped — "of", "in" and "co" overlap between every vendor on earth
 * and would make the tiebreaker agree with everything.
 */
export function vendorTokens(text: string | null): Set<string> {
  if (!text) return new Set();
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !/^\d+$/.test(w)),
  );
}

/** Do the charge and the receipt name the same vendor, as far as words go? */
export function vendorOverlap(
  txn: MatchableTransaction,
  receipt: MatchableReceipt,
): boolean {
  const left = vendorTokens([txn.vendorGuess, txn.description].filter(Boolean).join(" "));
  const right = vendorTokens(receipt.vendor);
  for (const word of right) if (left.has(word)) return true;
  return false;
}

const WINDOW_DAYS = 3;

/**
 * One-to-one pairings between unmatched charges and unmatched receipts.
 *
 * Greedy, over candidates sorted best-first: vendor agreement beats no
 * agreement, then fewer days apart. Greedy rather than optimal on purpose — a
 * bookkeeper reviewing forty charges needs an answer they can check line by
 * line, and "the closest date with the vendor agreeing" is a rule a person can
 * hold in their head. Every pairing is a PROPOSAL; the page asks before it
 * writes anything.
 */
export function proposeMatches(
  transactions: MatchableTransaction[],
  receipts: MatchableReceipt[],
): ProposedMatch[] {
  const candidates: (ProposedMatch & { rank: number })[] = [];

  for (const txn of transactions) {
    for (const receipt of receipts) {
      if (receipt.amountCents == null) continue;
      if (receipt.amountCents !== txn.amountCents) continue;
      const apart = daysBetween(txn.postedOn, receipt.purchasedOn);
      // A charge or a receipt with no date cannot be placed in the window, and
      // guessing would be how the wrong receipt gets attached to real money.
      if (apart == null || apart > WINDOW_DAYS) continue;
      const agrees = vendorOverlap(txn, receipt);
      candidates.push({
        transactionId: txn.id,
        receiptId: receipt.id,
        daysApart: apart,
        vendorAgrees: agrees,
        rank: (agrees ? 0 : 100) + apart,
      });
    }
  }

  candidates.sort((a, b) =>
    a.rank !== b.rank
      ? a.rank - b.rank
      : a.transactionId < b.transactionId
        ? -1
        : a.transactionId > b.transactionId
          ? 1
          : a.receiptId < b.receiptId
            ? -1
            : 1,
  );

  const usedTxn = new Set<string>();
  const usedReceipt = new Set<string>();
  const out: ProposedMatch[] = [];
  for (const c of candidates) {
    if (usedTxn.has(c.transactionId) || usedReceipt.has(c.receiptId)) continue;
    usedTxn.add(c.transactionId);
    usedReceipt.add(c.receiptId);
    out.push({
      transactionId: c.transactionId,
      receiptId: c.receiptId,
      daysApart: c.daysApart,
      vendorAgrees: c.vendorAgrees,
    });
  }
  return out;
}

/**
 * Charges nobody has handed a receipt in for — the one question this whole
 * feature exists to answer. Ignored charges are out: somebody already said
 * those need no receipt.
 */
export function withoutReceipts<T extends { status: string; receiptId: string | null }>(
  transactions: T[],
): T[] {
  return transactions.filter((t) => t.status === "unreceipted" && t.receiptId == null);
}
