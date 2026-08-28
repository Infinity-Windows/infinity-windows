// Client seam for the receipt fill-missing-only merge. The pure logic lives
// in the runtime-agnostic shared module (same move estimate.ts/knowledge.ts
// made) so it stays byte-identical to what extract-receipt itself can read,
// and so this file is a one-line indirection rather than a second copy that
// could drift. See supabase/functions/_shared/receiptMerge.ts for the
// implementation and the pointer to apply_receipt_extraction — the SQL
// function that is the actual authority; this is a client-side preview.
export {
  mergeReceiptExtraction,
  receiptFullyFilled,
  type ReceiptCategory,
  type ReceiptCategoryBy,
  type ReceiptExtractableFields,
  type ReceiptExtraction,
} from "../../../supabase/functions/_shared/receiptMerge.ts";
