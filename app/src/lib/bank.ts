// Wave Z, Z5: the card statement, as data.
//
// Every write is an RPC (the tables' direct write grants are revoked), every
// read is gated by can_see_costs, and every read degrades to empty on a
// database that has the app but not yet 20260978000000 — the Receipts page has
// to LOAD on a phone that is ahead of the migration, not white-screen.
//
// No bank credentials anywhere. The handoff is a file somebody exports.

import { supabase } from "./supabase";
import { isMissingTable } from "./schemaErrors";
import type { BankRowInput } from "./bankImport";

export type BankTransactionStatus = "matched" | "unreceipted" | "ignored";

export interface BankTransaction {
  id: string;
  importId: string;
  postedOn: string | null;
  amountCents: number;
  description: string | null;
  vendorGuess: string | null;
  cardholder: string | null;
  receiptId: string | null;
  status: BankTransactionStatus;
}

export interface BankImport {
  id: string;
  filename: string | null;
  importedAt: string;
  rowCount: number;
  undoneAt: string | null;
  importerName: string | null;
}

interface TxnRow {
  id: string;
  import_id: string;
  posted_on: string | null;
  amount_cents: number;
  description: string | null;
  vendor_guess: string | null;
  cardholder: string | null;
  receipt_id: string | null;
  status: BankTransactionStatus;
}

interface ImportRow {
  id: string;
  filename: string | null;
  imported_at: string;
  row_count: number;
  undone_at: string | null;
  profiles?: { display_name: string } | { display_name: string }[] | null;
}

const TXN_COLS =
  "id, import_id, posted_on, amount_cents, description, vendor_guess, cardholder, receipt_id, status";

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

function mapTxn(row: TxnRow): BankTransaction {
  return {
    id: row.id,
    importId: row.import_id,
    postedOn: row.posted_on,
    amountCents: row.amount_cents,
    description: row.description,
    vendorGuess: row.vendor_guess,
    cardholder: row.cardholder,
    receiptId: row.receipt_id,
    status: row.status,
  };
}

/** Every charge on file, newest first. Empty (not an error) without the grant
 * or without the migration. */
export async function listBankTransactions(): Promise<BankTransaction[]> {
  const { data, error } = await supabase
    .from("bank_transactions")
    .select(TXN_COLS)
    .order("posted_on", { ascending: false })
    .limit(1000);
  if (isMissingTable(error, "bank_transactions")) return [];
  if (error) throw error;
  return ((data ?? []) as TxnRow[]).map(mapTxn);
}

/** The import batches, newest first — the undo list. */
export async function listBankImports(): Promise<BankImport[]> {
  const { data, error } = await supabase
    .from("bank_imports")
    .select("id, filename, imported_at, row_count, undone_at, profiles!imported_by(display_name)")
    .order("imported_at", { ascending: false })
    .limit(50);
  if (isMissingTable(error, "bank_imports")) return [];
  if (error) throw error;
  return ((data ?? []) as unknown as ImportRow[]).map((row) => ({
    id: row.id,
    filename: row.filename,
    importedAt: row.imported_at,
    rowCount: row.row_count,
    undoneAt: row.undone_at,
    importerName: one(row.profiles)?.display_name ?? null,
  }));
}

/** File one statement. Returns the batch, whose row_count is what actually
 * LANDED — duplicates already on file are dropped by the database. */
export async function importBankTransactions(
  rows: BankRowInput[],
  filename: string | null,
): Promise<BankImport> {
  const { data, error } = await supabase.rpc("import_bank_transactions", {
    p_rows: rows,
    p_filename: filename,
  });
  if (error) throw error;
  const row = data as ImportRow;
  return {
    id: row.id,
    filename: row.filename,
    importedAt: row.imported_at,
    rowCount: row.row_count,
    undoneAt: row.undone_at,
    importerName: null,
  };
}

export async function matchBankTransaction(
  transactionId: string,
  receiptId: string,
): Promise<void> {
  const { error } = await supabase.rpc("match_bank_transaction", {
    p_txn_id: transactionId,
    p_receipt_id: receiptId,
  });
  if (error) throw error;
}

export async function unmatchBankTransaction(transactionId: string): Promise<void> {
  const { error } = await supabase.rpc("unmatch_bank_transaction", {
    p_txn_id: transactionId,
  });
  if (error) throw error;
}

export async function ignoreBankTransaction(
  transactionId: string,
  ignored = true,
): Promise<void> {
  const { error } = await supabase.rpc("ignore_bank_transaction", {
    p_txn_id: transactionId,
    p_ignored: ignored,
  });
  if (error) throw error;
}

/** Take one whole import back: untouched charges go, matched ones are kept and
 * unmatched. Nothing is ever auto-deleted outside this deliberate tap. */
export async function undoBankImport(importId: string): Promise<void> {
  const { error } = await supabase.rpc("undo_bank_import", { p_import_id: importId });
  if (error) throw error;
}
