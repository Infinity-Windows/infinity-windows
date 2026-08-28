/**
 * Pure fill-missing-only merge for a snapped receipt's OCR reading. Runtime-
 * agnostic (no Deno/browser imports) so it loads under both Deno (the
 * extract-receipt edge function, if it ever wants a local preview of what a
 * reading will change) and Vite/vitest — same move estimate.ts and
 * knowledge.ts made; app/src/lib/receiptMerge.ts re-exports this file for the
 * app side.
 *
 * THE LAW — and the ONLY place it is actually enforced — lives in
 * apply_receipt_extraction (supabase/migrations/20260957000000_receipts.sql):
 * a null column takes the machine's value; a column that already holds
 * something, human-typed or a prior machine fill, is left exactly as it is.
 * This module mirrors that SQL function's semantics field-for-field so a
 * reviewer can check the two against each other. It is used client-side to
 * show a receipt updating the instant extract-receipt answers, before the
 * refetch that confirms what the database actually wrote — the SQL RPC
 * above is the authority; this is a preview.
 */

export type ReceiptCategory = "gas" | "other";
export type ReceiptCategoryBy = "ai" | "manual";

/** The fields a receipt extraction can touch. */
export interface ReceiptExtractableFields {
  amount_cents: number | null;
  vendor: string | null;
  /** ISO date (YYYY-MM-DD), or null. */
  purchased_on: string | null;
  category: ReceiptCategory | null;
  category_by: ReceiptCategoryBy | null;
}

/** One machine reading — extract-receipt's raw output for the four fields
 * the merge can fill. Never carries a category_by: the machine cannot pin a
 * manual lock, only a human can (via update_receipt). */
export interface ReceiptExtraction {
  amount_cents: number | null;
  vendor: string | null;
  purchased_on: string | null;
  category: ReceiptCategory | null;
}

/**
 * Merge one extracted reading onto a receipt's current fields, fill-
 * missing-only. Every field: current wins if it is set; the extraction
 * fills it only when current is null. category additionally respects
 * category_by — once it is non-null (a human classified this receipt, or a
 * PRIOR extraction already filled it), the category is locked and this
 * merge never touches it again, matching apply_receipt_extraction exactly.
 */
export function mergeReceiptExtraction(
  current: ReceiptExtractableFields,
  extracted: ReceiptExtraction,
): ReceiptExtractableFields {
  const categoryLocked = current.category_by != null;
  const nextCategory = categoryLocked
    ? current.category
    : (current.category ?? extracted.category);
  const nextCategoryBy: ReceiptCategoryBy | null = categoryLocked
    ? current.category_by
    : nextCategory != null
      ? "ai"
      : null;

  return {
    amount_cents: current.amount_cents ?? extracted.amount_cents,
    vendor: current.vendor ?? extracted.vendor,
    purchased_on: current.purchased_on ?? extracted.purchased_on,
    category: nextCategory,
    category_by: nextCategoryBy,
  };
}

/**
 * True once nothing an extraction could fill is still blank. Lets a caller
 * (extract-receipt itself, and the office table's "Re-scan" affordance) skip
 * a wasted AI call on a receipt that is already fully read — the spend-
 * conscious default this whole app follows (docs/ai-spend-limits.md).
 */
export function receiptFullyFilled(current: ReceiptExtractableFields): boolean {
  return (
    current.amount_cents != null &&
    current.vendor != null &&
    current.purchased_on != null &&
    current.category != null
  );
}
