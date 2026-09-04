// Wave P: receipts that read themselves — the office-facing data layer.
//
// The upload flow itself lives in the offline outbox (op "receipt_capture",
// lib/offline/outbox.ts / outboxHandlers.ts) since it has to survive a dead
// conex wall the same way a photo does. This file is everything that reads
// or edits a receipt once it exists: the office table (P4), the upload
// flow's job-suggestion chips and passthrough question (P3), and the
// extract-receipt call (P2). RPC names/shapes mirror
// supabase/migrations/20260957000000_receipts.sql exactly — read that
// migration's comments for the authorization and fill-missing-only rules
// this file is just a thin client for.

import { supabase } from "./supabase";
import { signedMedia } from "./photos";
import { isMissingColumn } from "./schemaErrors";
import { weekRange } from "./timeclock";
import type { ReceiptCategory } from "./receiptMerge";

export type { ReceiptCategory, ReceiptCategoryBy } from "./receiptMerge";

export interface Receipt {
  id: string;
  uploadedBy: string;
  uploaderName: string | null;
  projectId: string | null;
  pendingJobName: string | null;
  jobCode: string | null;
  jobName: string | null;
  photoPath: string;
  signedUrl: string | null;
  amountCents: number | null;
  vendor: string | null;
  purchasedOn: string | null;
  category: ReceiptCategory | null;
  categoryBy: "ai" | "manual" | null;
  isPassthrough: boolean | null;
  note: string | null;
  ocr: Record<string, unknown> | null;
  createdAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  /** Wave Z: which kind of purchase, from the same library the clock picks
   * from. Null on a receipt filed before the picker existed, or skipped. */
  costCodeId: string | null;
  /** Wave Z: the one job_costs line this receipt became. Set once and never
   * cleared, so a receipt reads "posted" for good once it has. */
  jobCostId: string | null;
}

interface ReceiptRow {
  id: string;
  uploaded_by: string;
  project_id: string | null;
  pending_job_name: string | null;
  photo_path: string;
  amount_cents: number | null;
  vendor: string | null;
  purchased_on: string | null;
  category: ReceiptCategory | null;
  category_by: "ai" | "manual" | null;
  is_passthrough: boolean | null;
  note: string | null;
  ocr: Record<string, unknown> | null;
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  cost_code_id?: string | null;
  job_cost_id?: string | null;
  projects?: { job_code: string; name: string } | { job_code: string; name: string }[] | null;
  profiles?: { display_name: string } | { display_name: string }[] | null;
}

const RECEIPT_BASE_COLS =
  "id, uploaded_by, project_id, pending_job_name, photo_path, amount_cents, vendor, " +
  "purchased_on, category, category_by, is_passthrough, note, ocr, created_at, " +
  "reviewed_by, reviewed_at, projects(job_code, name), profiles!uploaded_by(display_name)";

/** Wave Z's two columns (20260978000000), asked for separately so the office
 * table can fall back to the list without them. */
const RECEIPT_SELECT = `${RECEIPT_BASE_COLS}, cost_code_id, job_cost_id`;

/**
 * Narrowed once, for the life of the tab, the first time the database says it
 * has no wave Z columns. The house rule: a phone running a bundle ahead of the
 * migration still LOADS the Receipts screen — it just shows no cost codes and
 * no "posted" chips until the backend catches up.
 */
let receiptCols = RECEIPT_SELECT;

async function readReceipts(
  run: (cols: string) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<{ data: unknown; error: unknown }> {
  const first = await run(receiptCols);
  if (
    first.error &&
    receiptCols !== RECEIPT_BASE_COLS &&
    isMissingColumn(first.error, "cost_code_id")
  ) {
    receiptCols = RECEIPT_BASE_COLS;
    return run(receiptCols);
  }
  return first;
}

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

async function mapRow(row: ReceiptRow): Promise<Receipt> {
  const proj = one(row.projects);
  const uploader = one(row.profiles);
  return {
    id: row.id,
    uploadedBy: row.uploaded_by,
    uploaderName: uploader?.display_name ?? null,
    projectId: row.project_id,
    pendingJobName: row.pending_job_name,
    jobCode: proj?.job_code ?? null,
    jobName: proj?.name ?? null,
    photoPath: row.photo_path,
    signedUrl: await signedMedia(row.photo_path),
    amountCents: row.amount_cents,
    vendor: row.vendor,
    purchasedOn: row.purchased_on,
    category: row.category,
    categoryBy: row.category_by,
    isPassthrough: row.is_passthrough,
    note: row.note,
    ocr: row.ocr,
    createdAt: row.created_at,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    costCodeId: row.cost_code_id ?? null,
    jobCostId: row.job_cost_id ?? null,
  };
}

export interface ReceiptFilter {
  /** ISO "YYYY-MM" — filters created_at to that calendar month. */
  month?: string | null;
  projectId?: string | null;
  category?: ReceiptCategory | "uncategorized" | null;
  passthrough?: boolean | null;
  /** true = only unreviewed, matching the office table's "unreviewed-first" default. */
  unreviewedOnly?: boolean;
}

/** The office table's filtered feed (P4). Foreman+ per receipts' own RLS;
 * an installer calling this sees only their own uploads — the same floor
 * the database itself enforces, so a filter here can never leak a row RLS
 * would have refused. */
export async function listReceipts(filter: ReceiptFilter = {}): Promise<Receipt[]> {
  const { data, error } = await readReceipts((cols) => {
    let query = supabase
      .from("receipts")
      .select(cols)
      .order("created_at", { ascending: false })
      .limit(500);

    if (filter.month) {
      const [y, m] = filter.month.split("-").map(Number);
      const start = new Date(Date.UTC(y, m - 1, 1));
      const end = new Date(Date.UTC(y, m, 1));
      query = query.gte("created_at", start.toISOString()).lt("created_at", end.toISOString());
    }
    if (filter.projectId) query = query.eq("project_id", filter.projectId);
    if (filter.category === "uncategorized") query = query.is("category", null);
    else if (filter.category) query = query.eq("category", filter.category);
    if (filter.passthrough != null) query = query.eq("is_passthrough", filter.passthrough);
    if (filter.unreviewedOnly) query = query.is("reviewed_at", null);
    return query;
  });
  if (error) throw error;
  return Promise.all(((data ?? []) as ReceiptRow[]).map(mapRow));
}

export async function getReceipt(id: string): Promise<Receipt | null> {
  const { data, error } = await readReceipts((cols) =>
    supabase.from("receipts").select(cols).eq("id", id).maybeSingle(),
  );
  if (error) throw error;
  return data ? mapRow(data as ReceiptRow) : null;
}

export interface FileReceiptInput {
  /** Client-minted (crypto.randomUUID()) so the storage upload and this
   * call can travel the offline outbox independently — see
   * receiptPhotoPath below. */
  id: string;
  photoPath: string;
  projectId?: string | null;
  pendingJobName?: string | null;
  note?: string | null;
}

export async function fileReceipt(input: FileReceiptInput): Promise<Receipt> {
  const { data, error } = await supabase.rpc("file_receipt", {
    p_id: input.id,
    p_photo_path: input.photoPath,
    p_project_id: input.projectId ?? null,
    p_pending_job_name: input.pendingJobName ?? null,
    p_note: input.note ?? null,
  });
  if (error) throw error;
  return mapRow(data as ReceiptRow);
}

export interface UpdateReceiptInput {
  id: string;
  projectId: string | null;
  pendingJobName: string | null;
  amountCents: number | null;
  vendor: string | null;
  purchasedOn: string | null;
  category: ReceiptCategory | null;
  isPassthrough: boolean | null;
  note: string | null;
}

/** Full-record overwrite (see update_receipt's own comment) — pass the
 * complete edited set, including fields left unchanged. */
export async function updateReceipt(input: UpdateReceiptInput): Promise<Receipt> {
  const { data, error } = await supabase.rpc("update_receipt", {
    p_id: input.id,
    p_project_id: input.projectId,
    p_pending_job_name: input.pendingJobName,
    p_amount_cents: input.amountCents,
    p_vendor: input.vendor,
    p_purchased_on: input.purchasedOn,
    p_category: input.category,
    p_is_passthrough: input.isPassthrough,
    p_note: input.note,
  });
  if (error) throw error;
  return mapRow(data as ReceiptRow);
}

/** The upload flow's one skippable question ("Bill this to the customer?"),
 * as a narrow patch that still goes through the full-record RPC — reads the
 * row first so the other fields survive the resend unchanged. */
export async function setPassthrough(id: string, value: boolean | null): Promise<Receipt> {
  const current = await getReceipt(id);
  if (!current) throw new Error("no such receipt");
  return updateReceipt({
    id,
    projectId: current.projectId,
    pendingJobName: current.pendingJobName,
    amountCents: current.amountCents,
    vendor: current.vendor,
    purchasedOn: current.purchasedOn,
    category: current.category,
    isPassthrough: value,
    note: current.note,
  });
}

/** The office table's category chip flip — same narrow-patch-over-full-
 * record shape as setPassthrough. Locks category_by='manual' server-side
 * (update_receipt) whenever this actually changes the stored value. */
export async function setCategory(id: string, value: ReceiptCategory | null): Promise<Receipt> {
  const current = await getReceipt(id);
  if (!current) throw new Error("no such receipt");
  return updateReceipt({
    id,
    projectId: current.projectId,
    pendingJobName: current.pendingJobName,
    amountCents: current.amountCents,
    vendor: current.vendor,
    purchasedOn: current.purchasedOn,
    category: value,
    isPassthrough: current.isPassthrough,
    note: current.note,
  });
}

/**
 * Which kind of purchase this receipt was. A narrow RPC, not a field on
 * update_receipt's full record — see set_receipt_cost_code's own comment in
 * 20260978000000 for why.
 */
export async function setReceiptCostCode(
  id: string,
  costCodeId: string | null,
): Promise<Receipt> {
  const { data, error } = await supabase.rpc("set_receipt_cost_code", {
    p_id: id,
    p_cost_code_id: costCodeId,
  });
  if (error) throw error;
  return mapRow(data as ReceiptRow);
}

export async function reviewReceipt(id: string, reviewed = true): Promise<Receipt> {
  const { data, error } = await supabase.rpc("review_receipt", {
    p_id: id,
    p_reviewed: reviewed,
  });
  if (error) throw error;
  return mapRow(data as ReceiptRow);
}

export interface ApplyReceiptExtractionInput {
  id: string;
  amountCents: number | null;
  vendor: string | null;
  purchasedOn: string | null;
  category: ReceiptCategory | null;
  ocr: Record<string, unknown> | null;
}

/** The fill-missing-only merge, server-enforced — see
 * apply_receipt_extraction's own comment for THE LAW this writes under. */
export async function applyReceiptExtraction(
  input: ApplyReceiptExtractionInput,
): Promise<Receipt> {
  const { data, error } = await supabase.rpc("apply_receipt_extraction", {
    p_id: input.id,
    p_amount_cents: input.amountCents,
    p_vendor: input.vendor,
    p_purchased_on: input.purchasedOn,
    p_category: input.category,
    p_ocr: input.ocr,
  });
  if (error) throw error;
  return mapRow(data as ReceiptRow);
}

export interface ExtractReceiptLineItem {
  description: string;
  amount_cents: number | null;
}

export interface ExtractReceiptResponse {
  ok: boolean;
  skipped: boolean;
  limited?: boolean;
  limit_reason?: string | null;
  note?: string | null;
  extraction: {
    amount_cents: number | null;
    vendor: string | null;
    purchased_on: string | null;
    category: ReceiptCategory | null;
    line_items: ExtractReceiptLineItem[];
  } | null;
}

/** Calls the extract-receipt edge function (P2) — read-only against the
 * database; the caller applies the result via applyReceiptExtraction. */
export async function extractReceipt(
  receiptId: string,
  force = false,
): Promise<ExtractReceiptResponse> {
  const { data, error } = await supabase.functions.invoke("extract-receipt", {
    body: { receiptId, force },
  });
  if (error) throw error;
  return data as ExtractReceiptResponse;
}

/**
 * Bucket-relative path for a receipt photo: `receipts/<id>.jpg`. The id is
 * the receipt row's own id (client-minted before either the upload or the
 * file_receipt call goes out), so this needs no timestamp/rand suffix the
 * way packagePhotoPath does — one receipt, one photo, one path, forever.
 */
export function receiptPhotoPath(id: string): string {
  return `receipts/${id}.jpg`;
}

// ---------------------------------------------------------------- suggestions

export interface JobSuggestion {
  projectId: string;
  jobCode: string;
  name: string;
  /** Horizon mechanism ported per the spec: a suggestion always says why. */
  reason: string;
}

interface RecentShiftRow {
  projectId: string;
  jobCode: string;
  name: string;
  clockInAt: string;
}

/**
 * Pure: turn this week's shifts (already date-filtered by the caller's
 * query) into one suggestion per job, most-recent first, with a visible
 * reason. Exported for its own vitest coverage (P5).
 */
export function buildJobSuggestions(shifts: RecentShiftRow[]): JobSuggestion[] {
  const seen = new Set<string>();
  const out: JobSuggestion[] = [];
  for (const s of shifts) {
    if (!s.projectId || seen.has(s.projectId)) continue;
    seen.add(s.projectId);
    out.push({
      projectId: s.projectId,
      jobCode: s.jobCode,
      name: s.name,
      reason: "Recent — you clocked this job this week",
    });
  }
  return out;
}

/** Jobs the uploader clocked on THIS calendar week (Monday-anchored, same
 * window timeclock.ts's weekRange uses everywhere else), for the upload
 * flow's suggestion chips. */
export async function listThisWeekJobSuggestions(profileId: string): Promise<JobSuggestion[]> {
  const { start } = weekRange();
  const { data, error } = await supabase
    .from("time_shifts")
    .select("project_id, clock_in_at, projects(job_code, name)")
    .eq("profile_id", profileId)
    .not("project_id", "is", null)
    .gte("clock_in_at", start.toISOString())
    .order("clock_in_at", { ascending: false })
    .limit(30);
  if (error) throw error;
  const rows = (data ?? []) as unknown as Array<{
    project_id: string | null;
    clock_in_at: string;
    projects?: { job_code: string; name: string } | { job_code: string; name: string }[] | null;
  }>;
  const shifts: RecentShiftRow[] = rows
    .filter((r): r is typeof r & { project_id: string } => Boolean(r.project_id))
    .map((r) => {
      const proj = one(r.projects);
      return {
        projectId: r.project_id,
        jobCode: proj?.job_code ?? "",
        name: proj?.name ?? "Job",
        clockInAt: r.clock_in_at,
      };
    });
  return buildJobSuggestions(shifts);
}

// ---------------------------------------------------------------------- CSV

function csvEscape(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Cents to a plain decimal string ("1250" -> "12.50"), empty for null —
 * CSV wants a raw number Excel can sum, not the "$12.50" display string. */
function centsToDecimal(cents: number | null): string {
  if (cents == null) return "";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

const CSV_HEADER = [
  "date",
  "vendor",
  "amount",
  "category",
  "job_code",
  "job_name",
  "pending_job_name",
  "billed_to_customer",
  "uploaded_by",
  "reviewed",
  "note",
];

/**
 * The current filter's receipts as accounting-bridge CSV — "their gap, our
 * feature" per the spec header. Pure (rows in, string out) so it is unit-
 * tested directly (P5); the page only handles the download.
 */
export function buildReceiptsCsv(receipts: Receipt[]): string {
  const lines = [CSV_HEADER.join(",")];
  for (const r of receipts) {
    const row = [
      r.purchasedOn ?? "",
      r.vendor ?? "",
      centsToDecimal(r.amountCents),
      r.category ?? "",
      r.jobCode ?? "",
      r.jobName ?? "",
      r.pendingJobName ?? "",
      r.isPassthrough == null ? "" : r.isPassthrough ? "yes" : "no",
      r.uploaderName ?? "",
      r.reviewedAt ? "yes" : "no",
      r.note ?? "",
    ];
    lines.push(row.map(csvEscape).join(","));
  }
  // UTF-8 BOM, same as timecardExport.ts's buildTimecardCsv, so Excel on
  // Windows decodes non-ASCII vendor names correctly.
  return `﻿${lines.join("\r\n")}`;
}
