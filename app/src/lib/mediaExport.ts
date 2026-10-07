// Photo and receipt export: list every matching saved photo or receipt for a
// job and a local-calendar date range, fetch the raw files with freshly
// minted signed URLs, and hand them back as Files the UI can zip, download
// one by one, or pass to the native share sheet.
//
// What this deliberately does NOT do: sign anything at list time, cache a
// signed URL, write a manifest of links into the download, send anything
// anywhere on its own, or report a partial result as a complete one. Every
// file that could not be fetched comes back in `failed` with a reason code.
//
// Errors and reasons are CODES, not sentences, so the dialog can say them in
// English or Spanish:
//   range:   range_incomplete | range_invalid | range_order
//   listing: MediaExportDataError.code — too_many | schema_missing
//   files:   sign_failed | network | http_<status> | empty | too_large |
//            aborted, prefixed "pdf_" when it was a receipt's original PDF
//   share:   share_unsupported (thrown); cancel = isMediaShareCancel(err)

import {
  listPhotosForExport,
  MediaExportDataError,
  signedMedia,
  type ExportWindow,
} from "./photos";
import { listReceiptsForExport, receiptDocumentSignedUrl, type ReceiptFilter } from "./receipts";

export { MediaExportDataError };

export type MediaExportKind = "photo" | "receipt";

/** Empty `fromDate` AND `throughDate` = all time; otherwise both must be valid
 * YYYY-MM-DD local calendar days with from <= through (inclusive). */
export interface MediaExportFilter {
  kind: MediaExportKind;
  projectId: string | null;
  fromDate: string;
  throughDate: string;
  /** Office exports retain their current category, billing and saved-month filters. */
  receiptFilter?: ReceiptFilter;
}

export interface MediaExportItem {
  id: string;
  projectId: string | null;
  /** The local calendar day the item belongs to (YYYY-MM-DD): a photo's
   * capture day (taken_at, else created_at); a receipt's purchase date as
   * written, else its created_at day. Empty when neither parses. */
  date: string;
  label: string;
  storagePath: string;
  /** A receipt's original PDF (install-media/receipts/<id>.pdf), else null. */
  documentPath: string | null;
  kind: MediaExportKind;
  /** Optional job code for the file name. Receipts fill it from their job;
   * photos carry none — the dialog may set it from its job list. */
  jobCode?: string | null;
}

export interface PreparedMediaExport {
  files: File[];
  failed: { id: string; label: string; reason: string }[];
}

export const MEDIA_EXPORT_CONCURRENCY = 3;
export const MEDIA_EXPORT_MAX_BYTES = 50 * 1024 * 1024;
export const MEDIA_EXPORT_FILE_TIMEOUT_MS = 60_000;

// ------------------------------------------------------------------- dates

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar day written strictly as YYYY-MM-DD (no 2026-02-30). */
export function isMediaExportDay(s: string): boolean {
  const m = DAY_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1000 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

export type MediaExportRangeError = "range_incomplete" | "range_invalid" | "range_order";

export function mediaExportRangeError(
  from: string,
  through: string,
): MediaExportRangeError | null {
  if (!from && !through) return null;
  if (!from || !through) return "range_incomplete";
  if (!isMediaExportDay(from) || !isMediaExportDay(through)) return "range_invalid";
  if (from > through) return "range_order";
  return null;
}

/** The local calendar day of an instant, or null if it does not parse.
 * `timeZone` is for deterministic tests; production uses the device's zone. */
export function mediaLocalDay(iso: string | null | undefined, timeZone?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  }).format(d);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A server prefilter wide enough to hold [from, through] as local days in
 * any zone (UTC-12..+14): a day of slack on each side. The exact local-day
 * test runs on the client afterwards. */
export function mediaExportWindow(from: string, through: string): ExportWindow {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = through.split("-").map(Number);
  return {
    fromDay: from,
    throughDay: through,
    since: new Date(Date.UTC(fy, fm - 1, fd) - DAY_MS).toISOString(),
    before: new Date(Date.UTC(ty, tm - 1, td + 2)).toISOString(),
  };
}

function photoDay(takenAt: string | null, createdAt: string, timeZone?: string): string {
  return mediaLocalDay(takenAt, timeZone) ?? mediaLocalDay(createdAt, timeZone) ?? "";
}

/** A bare purchase date is already a calendar day — never shifted by zone. */
function receiptDay(purchasedOn: string | null, createdAt: string, timeZone?: string): string {
  if (purchasedOn && isMediaExportDay(purchasedOn)) return purchasedOn;
  return mediaLocalDay(createdAt, timeZone) ?? "";
}

// ----------------------------------------------------------------- listing

/**
 * Every saved photo or receipt the signed-in person may see (RLS decides)
 * matching the job and inclusive local-day range. Throws a RangeError carrying
 * the range code for a bad range, and MediaExportDataError when the set is too
 * large to export at once or the database cannot scope it.
 */
export async function listMediaExportItems(
  filter: MediaExportFilter,
  timeZone?: string,
  signal?: AbortSignal,
): Promise<MediaExportItem[]> {
  const rangeError = mediaExportRangeError(filter.fromDate, filter.throughDate);
  if (rangeError) throw new RangeError(rangeError);
  const ranged = Boolean(filter.fromDate);
  const window = ranged ? mediaExportWindow(filter.fromDate, filter.throughDate) : null;
  const inRange = (day: string) =>
    !ranged || (day !== "" && day >= filter.fromDate && day <= filter.throughDate);

  let items: MediaExportItem[];
  if (filter.kind === "photo") {
    const rows = await listPhotosForExport(filter.projectId, window, signal);
    items = rows.map((p) => {
      const date = photoDay(p.takenAt, p.createdAt, timeZone);
      return {
        id: p.id,
        projectId: p.projectId,
        date,
        label: date || p.id,
        storagePath: p.storagePath,
        documentPath: null,
        kind: "photo" as const,
        jobCode: null,
      };
    });
  } else {
    const rows = await listReceiptsForExport({ ...filter.receiptFilter, projectId: filter.projectId }, window, signal);
    items = rows.map((r) => {
      const date = receiptDay(r.purchasedOn, r.createdAt, timeZone);
      return {
        id: r.id,
        projectId: r.projectId,
        date,
        label: [r.vendor, date].filter(Boolean).join(" · ") || r.id,
        storagePath: r.photoPath,
        documentPath: r.documentPath,
        kind: "receipt" as const,
        jobCode: r.jobCode,
      };
    });
  }
  // Newest day first; the read's created_at/id order breaks ties (stable sort).
  return items.filter((i) => inRange(i.date)).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

// ------------------------------------------------------------------- names

function slug(s: string | null | undefined, max = 40): string {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  pdf: "application/pdf",
};

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "application/pdf": "pdf",
};

/** Extension and MIME type from the stored path (deterministic), else the
 * response's Content-Type, else an honest octet-stream. */
export function inferMediaType(
  path: string,
  contentType: string | null,
): { ext: string; mime: string } {
  const pathExt = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  if (pathExt && MIME_BY_EXT[pathExt]) {
    return { ext: pathExt === "jpeg" ? "jpg" : pathExt, mime: MIME_BY_EXT[pathExt] };
  }
  const ct = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (EXT_BY_MIME[ct]) return { ext: EXT_BY_MIME[ct], mime: ct };
  return { ext: "bin", mime: "application/octet-stream" };
}

/** kind_job_date_id — job code, day and row id only: never an email, a name,
 * a caption or a location. */
function baseName(item: MediaExportItem): string {
  return [item.kind, slug(item.jobCode), item.date || "undated", slug(item.id, 64) || "item"]
    .filter(Boolean)
    .join("_");
}

/** Claim `name`, or name-2, name-3… — never overwrite a file already named. */
function claimName(name: string, used: Set<string>): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let candidate = name;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${stem}-${n}${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/** The ZIP's name: photos_<job|all-jobs>_<from>_to_<through|all-time>.zip. */
export function mediaExportName(
  kind: MediaExportKind,
  jobLabel: string,
  from: string,
  through: string,
): string {
  const job = slug(jobLabel) || "all-jobs";
  const range = !from || !through ? "all-time" : from === through ? from : `${from}_to_${through}`;
  return `${kind === "photo" ? "photos" : "receipts"}_${job}_${range}.zip`;
}

// ----------------------------------------------------------------- fetching

class PartFailure extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

interface FetchedPart {
  role: "image" | "pdf";
  blob: Blob;
  path: string;
  contentType: string | null;
}

interface Outcome {
  parts: FetchedPart[];
  failed: { id: string; label: string; reason: string }[];
}

export interface PrepareMediaExportOptions {
  signal?: AbortSignal;
  /** Tests only; production uses MEDIA_EXPORT_MAX_BYTES. */
  maxBytes?: number;
  /** Signing and reading one item share a deadline; tests may lower it. */
  timeoutMs?: number;
  /** Optional owner fence, checked before and after every awaited sign, fetch
   * and read. Once false the item aborts exactly as if `signal` had fired, so a
   * stale export never starts another network read. Undefined = always current. */
  isCurrent?: () => boolean;
}

/**
 * Fetch every item's raw file(s) — a receipt's original PDF beside its image —
 * through a fresh signed URL each, at most three at a time, with a 50 MB total export
 * payload limit. Past the cap, the rest fail `too_large` (narrow the export).
 * Files come back in item order with unique deterministic names; anything that
 * did not arrive is in `failed`, so `failed.length > 0` means NOT complete.
 */
export async function prepareMediaExport(
  items: MediaExportItem[],
  onProgress?: (done: number, total: number) => void,
  options: PrepareMediaExportOptions = {},
): Promise<PreparedMediaExport> {
  const { signal } = options;
  const maxBytes = options.maxBytes ?? MEDIA_EXPORT_MAX_BYTES;
  const total = items.length;
  let bytes = 0;
  let capped = false;
  let next = 0;
  let done = 0;
  const outcomes: Outcome[] = new Array(total);

  const progress = () => {
    try {
      onProgress?.(done, total);
    } catch {
      // A progress callback must not be able to abandon a running export.
    }
  };

  const controllers = new WeakMap<AbortSignal, AbortController>();
  /** partSignal.aborted, after first aborting the item if its owner went stale. */
  function gone(partSignal: AbortSignal): boolean {
    if (!partSignal.aborted && options.isCurrent && !options.isCurrent()) {
      controllers.get(partSignal)?.abort(new PartFailure("aborted"));
    }
    return partSignal.aborted;
  }
  function abortReason(partSignal: AbortSignal): PartFailure {
    return partSignal.reason instanceof PartFailure ? partSignal.reason : new PartFailure("aborted");
  }
  /** `dispose` receives a value that arrived after the read was abandoned
   * (aborted, timed out or stale), so it can be released, never used. */
  function abortable<T>(read: () => Promise<T>, partSignal: AbortSignal, dispose?: (late: T) => void): Promise<T> {
    if (gone(partSignal)) return Promise.reject(abortReason(partSignal));
    return new Promise<T>((resolve, reject) => {
      let abandoned = false;
      const onAbort = () => { abandoned = true; partSignal.removeEventListener("abort", onAbort); reject(abortReason(partSignal)); };
      partSignal.addEventListener("abort", onAbort, { once: true });
      // Signing has no AbortSignal parameter in the storage SDK. Its late
      // result is ignored; it can never start a fetch after cancellation.
      Promise.resolve().then(() => {
        if (gone(partSignal)) throw abortReason(partSignal);
        return read();
      }).then((value) => {
        if (abandoned || gone(partSignal)) {
          try { dispose?.(value); } catch { /* Disposal is best effort. */ }
          reject(abortReason(partSignal));
        } else resolve(value);
      }, reject).finally(() => partSignal.removeEventListener("abort", onAbort));
    });
  }
  /** A response that arrived too late: close its body without waiting, since
   * a transport's cancel promise may never settle. */
  function discardResponse(res: Response): void {
    try { void res.body?.cancel().catch(() => {}); } catch { /* Already locked or closed. */ }
  }
  async function fetchPart(url: string, partSignal: AbortSignal): Promise<{ blob: Blob; contentType: string | null }> {
    if (gone(partSignal)) throw abortReason(partSignal);
    if (capped) throw new PartFailure("too_large");
    let res: Response;
    try { res = await abortable(() => fetch(url, { signal: partSignal, credentials: "omit", cache: "no-store" }), partSignal, discardResponse); }
    catch { throw gone(partSignal) ? abortReason(partSignal) : new PartFailure("network"); }
    if (gone(partSignal)) { void res.body?.cancel().catch(() => {}); throw abortReason(partSignal); }
    if (!res.ok) { void res.body?.cancel().catch(() => {}); throw new PartFailure(`http_${res.status}`); }
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > 0 && bytes + declared > maxBytes) {
      capped = true; void res.body?.cancel().catch(() => {}); throw new PartFailure("too_large");
    }
    if (!res.body) throw new PartFailure("empty");
    const reader = res.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let heldBytes = 0;
    try {
      while (true) {
        const { value, done } = await abortable(() => reader.read(), partSignal);
        if (gone(partSignal)) throw abortReason(partSignal);
        if (done) break;
        if (bytes + value.byteLength > maxBytes) { capped = true; throw new PartFailure("too_large"); }
        const chunk = new Uint8Array(value);
        chunks.push(chunk); heldBytes += chunk.byteLength; bytes += chunk.byteLength;
      }
      if (!heldBytes) throw new PartFailure("empty");
      return { blob: new Blob(chunks), contentType: res.headers.get("content-type") };
    } catch (err) {
      bytes -= heldBytes;
      // A transport's cancel promise may itself never settle. Releasing the
      // UI must not depend on it; no failed chunks enter the prepared files.
      void reader.cancel().catch(() => {});
      throw err instanceof PartFailure ? err : new PartFailure(partSignal.aborted ? abortReason(partSignal).reason : "network");
    } finally { try { reader.releaseLock(); } catch { /* Canceled pending read. */ } }
  }

  async function runItem(item: MediaExportItem): Promise<Outcome> {
    const out: Outcome = { parts: [], failed: [] };
    const ctl = new AbortController();
    controllers.set(ctl.signal, ctl);
    const onAbort = () => ctl.abort(new PartFailure("aborted"));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(new PartFailure("timeout")), options.timeoutMs ?? MEDIA_EXPORT_FILE_TIMEOUT_MS);
    const fail = (reason: string) => out.failed.push({ id: item.id, label: item.label, reason });
    try {
      try {
        if (gone(ctl.signal)) throw abortReason(ctl.signal);
        if (capped) throw new PartFailure("too_large");
        const url = await abortable(() => signedMedia(item.storagePath), ctl.signal);
        if (!url) throw new PartFailure("sign_failed");
        out.parts.push({ role: "image", path: item.storagePath, ...await fetchPart(url, ctl.signal) });
      } catch (err) { fail(err instanceof PartFailure ? err.reason : "network"); }
      if (item.kind === "receipt" && item.documentPath) {
        try {
          let url: string;
          try { url = await abortable(() => receiptDocumentSignedUrl(item.id, item.documentPath!), ctl.signal); }
          catch (err) { throw err instanceof PartFailure ? err : new PartFailure("sign_failed"); }
          out.parts.push({ role: "pdf", path: item.documentPath, ...await fetchPart(url, ctl.signal) });
        } catch (err) { fail(`pdf_${err instanceof PartFailure ? err.reason : "network"}`); }
      }
      return out;
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
  }

  progress();
  const workers = Math.max(1, Math.min(MEDIA_EXPORT_CONCURRENCY, total));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (next < total) {
        const i = next++;
        outcomes[i] = await runItem(items[i]);
        done++;
        progress();
      }
    }),
  );

  const used = new Set<string>();
  const files: File[] = [];
  const failed: PreparedMediaExport["failed"] = [];
  items.forEach((item, i) => {
    const { parts, failed: itemFailed } = outcomes[i];
    const base = baseName(item);
    const hasPdf = item.kind === "receipt" && Boolean(item.documentPath);
    for (const part of parts) {
      const { ext, mime } =
        part.role === "pdf"
          ? { ext: "pdf", mime: "application/pdf" }
          : inferMediaType(part.path, part.contentType);
      const stem = part.role === "image" && hasPdf ? `${base}_page1` : base;
      files.push(new File([part.blob], claimName(`${stem}.${ext}`, used), { type: mime }));
    }
    failed.push(...itemFailed);
  });
  return { files, failed };
}

// --------------------------------------------------------- zip / download / share

/** Raw files only — no manifest, no links. jszip is loaded on first use. */
export async function mediaExportZip(files: File[]): Promise<Blob> {
  if (files.length === 0) throw new Error("no_files");
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const used = new Set<string>();
  for (const f of files) {
    // Bytes rather than the Blob itself: jszip reads Blobs through FileReader.
    zip.file(claimName(f.name, used), await f.arrayBuffer(), { binary: true });
  }
  // Photos and PDFs are already compressed; STORE keeps a phone responsive.
  return zip.generateAsync({ type: "blob", mimeType: "application/zip", compression: "STORE" });
}

export function downloadMediaBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Long enough for a slow phone to start the save; then let the bytes go.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Whether this browser's share sheet will take exactly these files. */
export function canShareMediaFiles(files: File[]): boolean {
  if (files.length === 0 || typeof navigator === "undefined") return false;
  if (typeof navigator.share !== "function" || typeof navigator.canShare !== "function") {
    return false;
  }
  try {
    return navigator.canShare({ files });
  } catch {
    return false;
  }
}

/**
 * Open the native share sheet with the files and nothing else — no text, no
 * URL, no recipient. Call it straight from a tap AFTER prepareMediaExport has
 * finished, so the tap's activation is still live. Rejects on cancel (see
 * isMediaShareCancel) so the caller never reports a share that did not happen.
 */
export async function shareMediaFiles(files: File[]): Promise<void> {
  if (!canShareMediaFiles(files)) throw new Error("share_unsupported");
  await navigator.share({ files });
}

/** The person closed the share sheet — not an error to show, not a success. */
export function isMediaShareCancel(err: unknown): boolean {
  return Boolean(err) && typeof err === "object" && (err as { name?: unknown }).name === "AbortError";
}
