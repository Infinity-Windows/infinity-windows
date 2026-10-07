// Data layer for the live job photo feed. Reads attachments (kind 'photo') for
// a project or across all jobs, resolves signed URLs from the private
// install-media bucket, and degrades gracefully when the additive geo/feed
// columns (20260721002000) are not yet applied.

import { supabase } from "./supabase";
import {
  isMissingColumn as isMissingSchemaColumn,
  isMissingFunction,
  isMissingTable,
} from "./schemaErrors";

export interface FeedPhoto {
  id: string;
  storagePath: string;
  signedUrl: string | null;
  createdBy: string | null;
  createdAt: string;
  takenAt: string | null;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  caption: string | null;
  projectId: string | null;
}

const GEO_SELECT =
  "id, kind, storage_path, created_by, created_at, project_id, lat, lng, accuracy_m, taken_at, caption";
const BASE_SELECT = "id, kind, storage_path, created_by, created_at";

function isMissingColumn(err: unknown): boolean {
  return isMissingSchemaColumn(err);
}

interface AttachmentRow {
  id: string;
  storage_path: string;
  created_by: string | null;
  created_at: string;
  project_id?: string | null;
  lat?: number | null;
  lng?: number | null;
  accuracy_m?: number | null;
  taken_at?: string | null;
  caption?: string | null;
}

/** Best-effort signed URL for a "bucket/path" storage reference. Exported for
 * lib/issues.ts, which resolves damage-report photos the same way (ticket 11). */
export async function signedMedia(storagePath: string): Promise<string | null> {
  const slash = storagePath.indexOf("/");
  const bucket = slash >= 0 ? storagePath.slice(0, slash) : "install-media";
  const path = slash >= 0 ? storagePath.slice(slash + 1) : storagePath;
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, 3600);
  if (error) return null;
  return data.signedUrl;
}

/**
 * List job photos newest-first. Pass a projectId to scope to one job, or omit
 * for the "recent across all jobs" view. When the geo columns are missing the
 * project filter can't apply, so we fall back to a recent-all query.
 */
export async function listPhotos(
  projectId?: string | null,
  limit = 60,
): Promise<FeedPhoto[]> {
  let query = supabase
    .from("attachments")
    .select(GEO_SELECT)
    .eq("kind", "photo")
    // Hide soft-deleted photos (slice 3): a removed photo is in the 30-day trash,
    // not on the feed. On a database that predates deleted_at the column filter
    // errors and the fallback below drops it (nothing is deleted there anyway).
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (projectId) query = query.eq("project_id", projectId);
  let res = await query;

  if (res.error && isMissingColumn(res.error)) {
    const fallback = await supabase
      .from("attachments")
      .select(BASE_SELECT)
      .eq("kind", "photo")
      .order("created_at", { ascending: false })
      .limit(limit);
    res = fallback as typeof res;
  }
  if (res.error) throw res.error;

  const rows = (res.data ?? []) as AttachmentRow[];
  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      storagePath: r.storage_path,
      signedUrl: await signedMedia(r.storage_path),
      createdBy: r.created_by ?? null,
      createdAt: r.created_at,
      takenAt: r.taken_at ?? null,
      lat: typeof r.lat === "number" ? r.lat : null,
      lng: typeof r.lng === "number" ? r.lng : null,
      accuracyM: typeof r.accuracy_m === "number" ? r.accuracy_m : null,
      caption: r.caption ?? null,
      projectId: r.project_id ?? null,
    })),
  );
}

/**
 * Photos tagged to THIS job-day's daily log (20261064010000) — not every
 * photo on the same job and date, just the ones the log itself claims.
 * Missing-column fallback is unnecessary here: a database old enough to lack
 * daily_log_id also lacks the daily_logs row this is ever called for.
 */
export async function listDailyLogPhotos(dailyLogId: string): Promise<FeedPhoto[]> {
  const { data, error } = await supabase
    .from("attachments")
    .select(GEO_SELECT)
    .eq("kind", "photo")
    .eq("daily_log_id", dailyLogId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (isMissingColumn(error)) return [];
  if (error) throw error;
  const rows = (data ?? []) as AttachmentRow[];
  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      storagePath: r.storage_path,
      signedUrl: await signedMedia(r.storage_path),
      createdBy: r.created_by ?? null,
      createdAt: r.created_at,
      takenAt: r.taken_at ?? null,
      lat: typeof r.lat === "number" ? r.lat : null,
      lng: typeof r.lng === "number" ? r.lng : null,
      accuracyM: typeof r.accuracy_m === "number" ? r.accuracy_m : null,
      caption: r.caption ?? null,
      projectId: r.project_id ?? null,
    })),
  );
}

// ---------------------------------------------------------------------------
// The jobs a person has worked (20260995000000).
// ---------------------------------------------------------------------------

/** One job in the gallery's job filter. */
export interface WorkedJob {
  id: string;
  jobCode: string;
  name: string;
}

/**
 * The jobs the signed-in person has worked — a shift, a published crew-board
 * assignment, or a unit session on one of the job's openings.
 *
 * ONE SOURCE, and it is the server's. The picker has to offer exactly the set
 * `attachments_select` will return, and both read `my_worked_project_ids()`;
 * a list stitched together on the phone out of recent shifts and today's
 * schedule would drift from the policy and offer jobs whose photos come back
 * empty, which reads as a broken screen rather than as a rule.
 *
 * Returns `null` — not an empty list — on a database that does not have the
 * function yet, because "we cannot tell" and "you have worked nothing" are
 * different answers and the caller shows a different list for each. A phone
 * running ahead of the migration falls back to the full jobs list, which is
 * what it showed yesterday.
 */
export async function listMyWorkedJobs(): Promise<WorkedJob[] | null> {
  const { data, error } = await supabase.rpc("list_my_worked_jobs");
  if (error) {
    if (isMissingFunction(error)) return null;
    throw error;
  }
  const rows = (data ?? []) as { id: string; job_code: string | null; name: string | null }[];
  return rows.map((r) => ({
    id: r.id,
    jobCode: r.job_code ?? "",
    name: r.name ?? "",
  }));
}

// ---------------------------------------------------------------------------
// Export reads (lib/mediaExport.ts). Every matching row, not a feed's worth:
// paged in a stable order until a short page, under a hard ceiling that fails
// loudly instead of quietly dropping the oldest. No URLs are signed here — the
// export mints fresh ones per file only once someone actually asks for them.
// ---------------------------------------------------------------------------

export const EXPORT_PAGE_SIZE = 500;
export const EXPORT_MAX_ROWS = 5000;

/** Why an export read refused. `too_many`: more rows than EXPORT_MAX_ROWS
 * match — narrow the job or dates. `schema_missing`: this database cannot
 * scope photos by job/trash, so exporting would leak the wrong set. */
export class MediaExportDataError extends Error {
  readonly code: "too_many" | "schema_missing";
  readonly limit: number | null;
  constructor(code: "too_many" | "schema_missing", limit: number | null = null) {
    super(
      code === "too_many"
        ? `More than ${limit} items match. Narrow the job or dates.`
        : "This database cannot scope photo exports yet.",
    );
    this.name = "MediaExportDataError";
    this.code = code;
    this.limit = limit;
  }
}

/**
 * A server-side prefilter for an export date range. `since`/`before` are UTC
 * instants that cover every local calendar day in [fromDay, throughDay] in any
 * time zone — a deliberate superset; the caller applies the exact local-day
 * test. `fromDay`/`throughDay` are bare YYYY-MM-DD for date columns.
 */
export interface ExportWindow {
  fromDay: string;
  throughDay: string;
  since: string;
  before: string;
}

/** Page `fetchPage` in EXPORT_PAGE_SIZE steps until a short page; past
 * EXPORT_MAX_ROWS, probe one more row and refuse rather than truncate. Rows
 * seen twice (an insert shifting the offset mid-read) are kept once. */
export async function collectExportPages<T extends { id: string }>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
  signal?: AbortSignal,
): Promise<T[]> {
  const seen = new Map<string, T>();
  for (let offset = 0; offset < EXPORT_MAX_ROWS; offset += EXPORT_PAGE_SIZE) {
    if (signal?.aborted) throw new DOMException("Export canceled", "AbortError");
    const { data, error } = await fetchPage(offset, offset + EXPORT_PAGE_SIZE - 1);
    if (signal?.aborted) throw new DOMException("Export canceled", "AbortError");
    if (error) throw error;
    const rows = (data ?? []) as T[];
    for (const r of rows) if (!seen.has(r.id)) seen.set(r.id, r);
    if (rows.length < EXPORT_PAGE_SIZE) return [...seen.values()];
  }
  if (signal?.aborted) throw new DOMException("Export canceled", "AbortError");
  const probe = await fetchPage(EXPORT_MAX_ROWS, EXPORT_MAX_ROWS);
  if (signal?.aborted) throw new DOMException("Export canceled", "AbortError");
  if (probe.error) throw probe.error;
  if (((probe.data ?? []) as unknown[]).length > 0) {
    throw new MediaExportDataError("too_many", EXPORT_MAX_ROWS);
  }
  return [...seen.values()];
}

/** One exportable photo, unsigned. */
export interface PhotoExportRow {
  id: string;
  storagePath: string;
  createdAt: string;
  takenAt: string | null;
  projectId: string | null;
}

/** Only the app's known receipt storage namespace is excluded. Other photos,
 * including ones with receipt-like names, remain ordinary job photos. */
function isReceiptStoragePath(path: string): boolean {
  return path.startsWith("install-media/receipts/") || path.startsWith("receipts/");
}

/**
 * Every live (not trashed) photo the caller's RLS returns, one job or all,
 * newest-inserted first. Unlike listPhotos there is NO legacy fallback: on a
 * database without project_id/deleted_at the job scope and the trash filter
 * cannot apply, and an export of "every photo, trashed included" is not a
 * degraded answer but a wrong one — so it refuses.
 */
export async function listPhotosForExport(
  projectId?: string | null,
  window?: ExportWindow | null,
  signal?: AbortSignal,
): Promise<PhotoExportRow[]> {
  type Row = {
    id: string;
    storage_path: string;
    created_at: string;
    taken_at: string | null;
    project_id: string | null;
  };
  let rows: Row[];
  try {
    rows = await collectExportPages<Row>((from, to) => {
      let query = supabase
        .from("attachments")
        .select("id, storage_path, created_at, taken_at, project_id")
        .eq("kind", "photo")
        .is("deleted_at", null)
        // Exclude known receipt paths before range/cap evaluation.
        .not("storage_path", "like", "install-media/receipts/%")
        .not("storage_path", "like", "receipts/%");
      if (projectId) query = query.eq("project_id", projectId);
      if (window) {
        // Capture time when there is one, else insert time — photoTime's rule.
        query = query.or(
          `and(taken_at.gte."${window.since}",taken_at.lt."${window.before}"),` +
            `and(taken_at.is.null,created_at.gte."${window.since}",created_at.lt."${window.before}")`,
        );
      }
      const page = query.order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, to);
      return signal ? page.abortSignal(signal) : page;
    }, signal);
  } catch (err) {
    if (isMissingColumn(err)) throw new MediaExportDataError("schema_missing");
    throw err;
  }
  return rows.filter((r) => !isReceiptStoragePath(r.storage_path)).map((r) => ({
    id: r.id,
    storagePath: r.storage_path,
    createdAt: r.created_at,
    takenAt: r.taken_at ?? null,
    projectId: r.project_id ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Grouped photo export reads (lib/groupedPhotoExport.ts). Past the flat
// export's 5000-row ceiling, so it pages by keyset (created_at DESC, id DESC)
// rather than by offset: an insert or delete between pages can neither repeat
// nor skip a row. Still unsigned, still RLS-scoped, still refusing loudly — at
// 50,000 rows or 20 MiB of row metadata it refuses the WHOLE listing rather
// than offer a partial "all".
// ---------------------------------------------------------------------------

export const GROUPED_PHOTO_EXPORT_PAGE_SIZE = 500;
export const GROUPED_PHOTO_EXPORT_MAX_ROWS = 50_000;
export const GROUPED_PHOTO_EXPORT_MAX_METADATA_BYTES = 20 * 1024 * 1024;

/** Tests only; production uses the constants above. */
export interface GroupedPhotoListingOptions {
  pageSize?: number;
  maxRows?: number;
  maxMetadataBytes?: number;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Export canceled", "AbortError");
}

/**
 * Every live photo listPhotosForExport would return — same RLS, kind, trash,
 * receipt-namespace and schema-refusal rules — without its 5000-row ceiling.
 * The cursor is the RAW last row of each page (before the local receipt-path
 * filter), and it is ANDed with the date window, never replacing it.
 */
export async function listAllPhotosForGroupedExport(
  projectId?: string | null,
  window?: ExportWindow | null,
  signal?: AbortSignal,
  options: GroupedPhotoListingOptions = {},
): Promise<PhotoExportRow[]> {
  type Row = {
    id: string;
    storage_path: string;
    created_at: string;
    taken_at: string | null;
    project_id: string | null;
  };
  const pageSize = Math.max(1, options.pageSize ?? GROUPED_PHOTO_EXPORT_PAGE_SIZE);
  const maxRows = options.maxRows ?? GROUPED_PHOTO_EXPORT_MAX_ROWS;
  const maxMetadataBytes = options.maxMetadataBytes ?? GROUPED_PHOTO_EXPORT_MAX_METADATA_BYTES;
  // Capture time when there is one, else insert time — photoTime's rule.
  const dateExpr = window
    ? `and(taken_at.gte."${window.since}",taken_at.lt."${window.before}"),` +
      `and(taken_at.is.null,created_at.gte."${window.since}",created_at.lt."${window.before}")`
    : null;
  const seen = new Map<string, Row>();
  // UTF-8 bytes of each row as serialized, not UTF-16 code units. A budget on
  // the listing's size, not a measurement of the JS heap.
  const encoder = new TextEncoder();
  let rawRows = 0;
  let metadataBytes = 0;
  let cursor: { createdAt: string; id: string } | null = null;
  try {
    for (;;) {
      throwIfAborted(signal);
      // At the ceiling this asks for exactly one more row: the boundary probe.
      const want = Math.min(pageSize, maxRows - rawRows + 1);
      let query = supabase
        .from("attachments")
        .select("id, storage_path, created_at, taken_at, project_id")
        .eq("kind", "photo")
        .is("deleted_at", null)
        .not("storage_path", "like", "install-media/receipts/%")
        .not("storage_path", "like", "receipts/%");
      if (projectId) query = query.eq("project_id", projectId);
      const cursorExpr = cursor
        ? `created_at.lt."${cursor.createdAt}",and(created_at.eq."${cursor.createdAt}",id.lt."${cursor.id}")`
        : null;
      // One `or` parameter: (date window) AND (after cursor) when both apply.
      if (dateExpr && cursorExpr) query = query.or(`and(or(${dateExpr}),or(${cursorExpr}))`);
      else if (dateExpr) query = query.or(dateExpr);
      else if (cursorExpr) query = query.or(cursorExpr);
      let page = query.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(want);
      if (signal) page = page.abortSignal(signal);
      const { data, error } = await page;
      throwIfAborted(signal);
      if (error) throw error;
      const rows = (data ?? []) as Row[];
      rawRows += rows.length;
      if (rawRows > maxRows) throw new MediaExportDataError("too_many", maxRows);
      for (const r of rows) {
        metadataBytes += encoder.encode(JSON.stringify(r)).byteLength;
        if (metadataBytes > maxMetadataBytes) throw new MediaExportDataError("too_many", maxRows);
        if (!seen.has(r.id)) seen.set(r.id, r);
      }
      if (rows.length < want) break;
      const last = rows[rows.length - 1];
      cursor = { createdAt: last.created_at, id: last.id };
    }
  } catch (err) {
    if (isMissingColumn(err)) throw new MediaExportDataError("schema_missing");
    throw err;
  }
  return [...seen.values()].filter((r) => !isReceiptStoragePath(r.storage_path)).map((r) => ({
    id: r.id,
    storagePath: r.storage_path,
    createdAt: r.created_at,
    takenAt: r.taken_at ?? null,
    projectId: r.project_id ?? null,
  }));
}

/** Prefer the true capture time; fall back to the server insert time. */
export function photoTime(p: Pick<FeedPhoto, "takenAt" | "createdAt">): string {
  return p.takenAt ?? p.createdAt;
}

// ---------------------------------------------------------------------------
// Job-photo trash (standard-tracking-jobs slice 3): a foreman removes a bad or
// wrong photo; it drops off the feed into a 30-day recoverable trash, then the
// nightly sweep erases it. deleted_at/deleted_by + the RPCs live in migration
// 20260973000000. Reads degrade to empty on a database without the column.
// ---------------------------------------------------------------------------

/** The removed job photos still recoverable (newest-deleted first). */
export async function listDeletedPhotos(
  projectId?: string | null,
  limit = 60,
): Promise<FeedPhoto[]> {
  let query = supabase
    .from("attachments")
    .select(GEO_SELECT)
    .eq("kind", "photo")
    .not("deleted_at", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (projectId) query = query.eq("project_id", projectId);
  const res = await query;
  // Not migrated yet — no trash is the honest answer, not an error screen.
  if (res.error && (isMissingColumn(res.error) || isMissingTable(res.error, "attachments"))) {
    return [];
  }
  if (res.error) throw res.error;

  const rows = (res.data ?? []) as AttachmentRow[];
  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      storagePath: r.storage_path,
      signedUrl: await signedMedia(r.storage_path),
      createdBy: r.created_by ?? null,
      createdAt: r.created_at,
      takenAt: r.taken_at ?? null,
      lat: typeof r.lat === "number" ? r.lat : null,
      lng: typeof r.lng === "number" ? r.lng : null,
      accuracyM: typeof r.accuracy_m === "number" ? r.accuracy_m : null,
      caption: r.caption ?? null,
      projectId: r.project_id ?? null,
    })),
  );
}

/** Move a job photo to the 30-day trash (foreman+). */
export async function deleteJobPhoto(id: string): Promise<void> {
  const { error } = await supabase.rpc("soft_delete_job_photo", { p_id: id });
  if (error) throw error;
}

/** Bring a job photo back from the trash within 30 days (foreman+). */
export async function restoreJobPhoto(id: string): Promise<void> {
  const { error } = await supabase.rpc("restore_job_photo", { p_id: id });
  if (error) throw error;
}

export interface PhotoDayGroup<T> {
  key: string;
  label: string;
  photos: T[];
}

/**
 * Group an already-sorted (newest-first) photo list into day buckets, keeping
 * input order within and across groups. `timeZone` is exposed for deterministic
 * tests; production uses the device's local zone.
 */
export function groupPhotosByDay<
  T extends Pick<FeedPhoto, "takenAt" | "createdAt">,
>(photos: T[], timeZone?: string): PhotoDayGroup<T>[] {
  const tz = timeZone ? { timeZone } : {};
  const keyFmt = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...tz,
  });
  const labelFmt = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    ...tz,
  });
  const groups: PhotoDayGroup<T>[] = [];
  const byKey = new Map<string, PhotoDayGroup<T>>();
  for (const p of photos) {
    const d = new Date(photoTime(p));
    const key = keyFmt.format(d);
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: labelFmt.format(d), photos: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.photos.push(p);
  }
  return groups;
}
