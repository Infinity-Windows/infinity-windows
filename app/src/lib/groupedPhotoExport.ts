// Grouped photo export: every regular job photo the person picked, packed into
// ZIPs with one folder per job (plus Unassigned), automatically split into
// numbered parts when the selection is large.
//
// Memory is the constraint on a phone. A session REFERENCES at most one
// published part's ZIP, the photos of the one part being built, and one
// fetched photo carried over to the next part; it drops its references to
// source Files, read buffers and the JSZip instance once a part is built or
// abandoned. This bounds what the session holds, not the JS heap: a canceled
// ZIP generation is not terminable and may finish computing inside JSZip
// before its result is discarded unpublished.
// The caller must hand back each part (releasePart) before asking for the next,
// so a part the person has not saved yet can be downloaded or shared again.
//
// What this deliberately does NOT do: sign URLs at list time, write a manifest
// or any link into a ZIP, group by parsing file names, click more than once on
// its own, or claim anything was SAVED — a browser never says when a download
// finished, so the session only ever reports what it PREPARED.
//
// Receipts are untouched: receipt mode keeps listMediaExportItems and
// prepareMediaExport exactly as they were.

import {
  canShareMediaFiles,
  MEDIA_EXPORT_FILE_TIMEOUT_MS,
  MEDIA_EXPORT_MAX_BYTES,
  mediaExportRangeError,
  mediaExportWindow,
  mediaLocalDay,
  prepareMediaExport,
  shareMediaFiles,
  type MediaExportFilter,
  type MediaExportItem,
} from "./mediaExport";
import type JSZipType from "jszip";
import { listAllPhotosForGroupedExport, type GroupedPhotoListingOptions } from "./photos";

/** A part closes once its photos reach this many bytes… */
export const PHOTO_EXPORT_PART_TARGET_BYTES = 20 * 1024 * 1024;
/** …or this many files, whichever comes first. */
export const PHOTO_EXPORT_PART_MAX_FILES = 200;
/** One photo larger than this fails `too_large`; one larger than the target
 * (but within this) simply gets a part of its own. */
export const PHOTO_EXPORT_FILE_MAX_BYTES = MEDIA_EXPORT_MAX_BYTES;

export const UNASSIGNED_PHOTO_FOLDER = "Unassigned";

// ----------------------------------------------------------------- listing

/**
 * Every live photo matching the job and inclusive local-day range — the same
 * rows and rules as listMediaExportItems' photo mode, without its 5000 cap
 * (see listAllPhotosForGroupedExport for the 50,000 / 20 MiB refusal).
 * Throws RangeError(code) for a bad range and MediaExportDataError when the
 * set is too large or the database cannot scope it.
 */
export async function listGroupedPhotoExportItems(
  filter: MediaExportFilter,
  timeZone?: string,
  signal?: AbortSignal,
  listing?: GroupedPhotoListingOptions,
): Promise<MediaExportItem[]> {
  if (filter.kind !== "photo") throw new TypeError("photo_only");
  const rangeError = mediaExportRangeError(filter.fromDate, filter.throughDate);
  if (rangeError) throw new RangeError(rangeError);
  const ranged = Boolean(filter.fromDate);
  const window = ranged ? mediaExportWindow(filter.fromDate, filter.throughDate) : null;
  const rows = await listAllPhotosForGroupedExport(filter.projectId, window, signal, listing);
  const items: MediaExportItem[] = [];
  for (const p of rows) {
    const date = mediaLocalDay(p.takenAt, timeZone) ?? mediaLocalDay(p.createdAt, timeZone) ?? "";
    if (ranged && (date === "" || date < filter.fromDate || date > filter.throughDate)) continue;
    items.push({
      id: p.id,
      projectId: p.projectId,
      date,
      label: date || p.id,
      storagePath: p.storagePath,
      documentPath: null,
      kind: "photo",
      jobCode: null,
    });
  }
  // Newest day first; the read's created_at/id order breaks ties (stable sort).
  return items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

// ----------------------------------------------------------------- folders

function slug(s: string | null | undefined, max = 40): string {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

/**
 * One folder per project id, deterministic for a given set of ids and labels:
 * `<job label>_<id prefix>` (or `Job-<id prefix>` with no label), widened to
 * the full id on a case-insensitive clash, then numbered. Only a null project
 * id is `Unassigned`; every segment is [A-Za-z0-9-_] so no path can escape.
 */
export function photoExportFolders(
  projectIds: Iterable<string | null>,
  projectLabels: ReadonlyMap<string, string>,
): Map<string | null, string> {
  const ids = [...new Set(projectIds)].filter((id): id is string => id !== null).sort();
  const folders = new Map<string | null, string>();
  const used = new Set<string>([UNASSIGNED_PHOTO_FOLDER.toLowerCase()]);
  const named = (id: string, idPart: string) => {
    const label = slug(projectLabels.get(id));
    return label ? `${label}_${idPart}` : `Job-${idPart}`;
  };
  for (const id of ids) {
    const fullId = slug(id, 64) || "job";
    let folder = named(id, fullId.slice(0, 8));
    if (used.has(folder.toLowerCase())) folder = named(id, fullId);
    const stem = folder;
    for (let n = 2; used.has(folder.toLowerCase()); n++) folder = `${stem}-${n}`;
    used.add(folder.toLowerCase());
    folders.set(id, folder);
  }
  folders.set(null, UNASSIGNED_PHOTO_FOLDER);
  return folders;
}

export interface PhotoExportGroup {
  projectId: string | null;
  label: string;
  folder: string;
  items: MediaExportItem[];
}

/** Items grouped by project id — alphabetical by label, Unassigned last. Item
 * order inside a group is the listing's (newest first). */
export function groupPhotoExportItems(
  items: readonly MediaExportItem[],
  projectLabels: ReadonlyMap<string, string>,
): PhotoExportGroup[] {
  const byProject = new Map<string | null, MediaExportItem[]>();
  for (const item of items) {
    const list = byProject.get(item.projectId);
    if (list) list.push(item);
    else byProject.set(item.projectId, [item]);
  }
  const folders = photoExportFolders(byProject.keys(), projectLabels);
  const groups = [...byProject].map(([projectId, groupItems]) => ({
    projectId,
    label:
      projectId === null
        ? UNASSIGNED_PHOTO_FOLDER
        : projectLabels.get(projectId)?.trim() || folders.get(projectId)!,
    folder: folders.get(projectId)!,
    items: groupItems,
  }));
  return groups.sort((a, b) => {
    if ((a.projectId === null) !== (b.projectId === null)) return a.projectId === null ? 1 : -1;
    return a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) || a.folder.localeCompare(b.folder);
  });
}

// ----------------------------------------------------------------- session

export interface PhotoExportFailure {
  id: string;
  projectId: string | null;
  label: string;
  reason: string;
}

/** `selected === packaged + failed.length + remaining`, always. `complete`
 * and `partial` mean every photo was PREPARED (or failed) — never saved. */
export interface PhotoExportSummary {
  selected: number;
  packaged: number;
  failed: PhotoExportFailure[];
  remaining: number;
  partsPrepared: number;
  state: "active" | "complete" | "partial" | "canceled";
}

export interface PreparedPhotoPart {
  token: string;
  /** 1-based. */
  number: number;
  name: string;
  zip: File;
  itemIds: string[];
  /** Nothing is left to prepare after this part. */
  last: boolean;
}

export interface PhotoExportSession {
  /** The next part, or null when nothing is left. Rejects `export_busy` while
   * another call is running and `part_retained` until the current part is
   * released; rejects AbortError once canceled or no longer current. */
  nextPart(): Promise<PreparedPhotoPart | null>;
  /** Drop the session's reference to a part (after the person says it is
   * saved, or on reset). Unknown or stale tokens are ignored. */
  releasePart(token: string): void;
  summary(): PhotoExportSummary;
  /** Stop and drop retained part/carry references; nextPart rejects AbortError.
   * An in-flight JSZip computation may still settle internally. */
  cancel(): void;
}

export interface PhotoExportProgress {
  /** Photos packaged or failed so far, including those in the part being built. */
  processed: number;
  selected: number;
  /** The part being built (1-based). */
  partNumber: number;
}

export interface PhotoExportSessionOptions {
  signal: AbortSignal;
  /** The owner fence: checked before and after every await. False = canceled. */
  isCurrent: () => boolean;
  projectLabels: ReadonlyMap<string, string>;
  /** e.g. mediaExportName(...) — a trailing .zip is dropped, the rest made safe. */
  archiveBaseName: string;
  onProgress?: (progress: PhotoExportProgress) => void;
  /** Tests only. */
  targetBytes?: number;
  maxFiles?: number;
  maxFileBytes?: number;
  timeoutMs?: number;
}

function abortError(): DOMException {
  return new DOMException("Export canceled", "AbortError");
}

function safeArchiveBase(name: string): string {
  return name.replace(/\.zip$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "") || "photos";
}

let sessionSeq = 0;

/**
 * Pack `selectedSnapshot` (deduplicated by id; the caller's array is copied)
 * into numbered ZIP parts, one at a time, fetching photos sequentially. Each
 * photo is in exactly one part or in `failed` — never in two parts.
 */
export function createPhotoExportSession(
  selectedSnapshot: readonly MediaExportItem[],
  options: PhotoExportSessionOptions,
): PhotoExportSession {
  const targetBytes = options.targetBytes ?? PHOTO_EXPORT_PART_TARGET_BYTES;
  const maxFiles = Math.max(1, options.maxFiles ?? PHOTO_EXPORT_PART_MAX_FILES);
  const maxFileBytes = options.maxFileBytes ?? PHOTO_EXPORT_FILE_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? MEDIA_EXPORT_FILE_TIMEOUT_MS;
  const base = safeArchiveBase(options.archiveBaseName);
  const sessionId = `${Date.now().toString(36)}-${(++sessionSeq).toString(36)}`;

  const unique = new Map<string, MediaExportItem>();
  for (const item of selectedSnapshot) if (item.kind === "photo" && !unique.has(item.id)) unique.set(item.id, { ...item });
  // Folder by folder (alphabetical, Unassigned last) so a job's photos stay
  // together across as few parts as possible.
  const queue = groupPhotoExportItems([...unique.values()], options.projectLabels).flatMap((g) => g.items);
  const folders = photoExportFolders(queue.map((i) => i.projectId), options.projectLabels);
  const selected = queue.length;
  const usedPaths = new Set<string>();

  const ctl = new AbortController();

  let next = 0;
  let carry: { item: MediaExportItem; file: File } | null = null;
  let current: PreparedPhotoPart | null = null;
  let busy = false;
  let canceled = false;
  let packaged = 0;
  let partsPrepared = 0;
  const failed: PhotoExportFailure[] = [];
  /** Byte-free descriptors of the part being built, kept until it is published
   * so a failed ZIP accounts for exactly these photos. */
  let pending: MediaExportItem[] = [];

  // The caller's abort is a cancel: drop the idle part and carry at once.
  const onOuterAbort = () => cancel();

  function cancel(): void {
    if (canceled) return;
    canceled = true;
    current = null;
    carry = null;
    ctl.abort();
    options.signal.removeEventListener("abort", onOuterAbort);
  }
  if (options.signal.aborted) cancel();
  else options.signal.addEventListener("abort", onOuterAbort, { once: true });

  /** Settle with AbortError as soon as the session is canceled, without
   * waiting for `work` (which cannot be stopped); its late result is dropped. */
  function race<T>(work: Promise<T>): Promise<T> {
    work.catch(() => {});
    if (ctl.signal.aborted) return Promise.reject(abortError());
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(abortError());
      ctl.signal.addEventListener("abort", onAbort, { once: true });
      work.then(
        (value) => { ctl.signal.removeEventListener("abort", onAbort); resolve(value); },
        (err) => { ctl.signal.removeEventListener("abort", onAbort); reject(err); },
      );
    });
  }
  /** Throws AbortError (and cancels) once aborted or no longer current. */
  function checkpoint(): void {
    if (!isCurrent()) {
      cancel();
      throw abortError();
    }
  }
  const isCurrent = () => {
    try {
      return !canceled && !ctl.signal.aborted && options.isCurrent();
    } catch {
      return false;
    }
  };

  function pathFor(item: MediaExportItem, file: File): string {
    const folder = folders.get(item.projectId) ?? UNASSIGNED_PHOTO_FOLDER;
    const ext = /\.([A-Za-z0-9]+)$/.exec(file.name)?.[1]?.toLowerCase() ?? "bin";
    const stem = `${folder}/photo_${item.date || "undated"}_${slug(item.id, 64) || "item"}`;
    let path = `${stem}.${ext}`;
    for (let n = 2; usedPaths.has(path.toLowerCase()); n++) path = `${stem}-${n}.${ext}`;
    usedPaths.add(path.toLowerCase());
    return path;
  }

  function fail(item: MediaExportItem, reason: string): void {
    failed.push({ id: item.id, projectId: item.projectId, label: item.label, reason });
  }

  /** Builds a part but does NOT publish it or count it: nextPart does both,
   * synchronously, after its final owner check. */
  async function build(number: number): Promise<PreparedPhotoPart | null> {
    // Only this part's photos, then only its ZIP. Never a list of all parts.
    let entries: { item: MediaExportItem; file: File }[] = [];
    let bytes = 0;
    pending = [];
    const progress = () => {
      try {
        options.onProgress?.({ processed: packaged + failed.length + pending.length, selected, partNumber: number });
      } catch {
        // A progress callback must not be able to abandon a running export.
      }
    };
    try {
      if (carry) {
        entries.push(carry);
        pending.push(carry.item);
        bytes += carry.file.size;
        carry = null;
      }
      progress();
      while (next < selected && entries.length < maxFiles && bytes < targetBytes) {
        checkpoint();
        const item = queue[next];
        const { files, failed: itemFailed } = await prepareMediaExport([item], undefined, {
          signal: ctl.signal,
          maxBytes: maxFileBytes,
          timeoutMs,
          isCurrent,
        });
        checkpoint();
        next++;
        const file = files[0];
        if (!file || itemFailed.length > 0) {
          fail(item, itemFailed[0]?.reason ?? "network");
        } else if (entries.length > 0 && bytes + file.size > targetBytes) {
          // Part is full: roll this photo into the next part — not a failure.
          carry = { item, file };
          break;
        } else {
          entries.push({ item, file });
          pending.push(item);
          bytes += file.size;
        }
        progress();
      }
      if (entries.length === 0) return null;

      const { default: JSZip } = await race(import("jszip"));
      checkpoint();
      let zip: JSZipType | null = new JSZip();
      const itemIds: string[] = [];
      for (const { item, file } of entries) {
        const data = await race(file.arrayBuffer());
        checkpoint();
        zip.file(pathFor(item, file), data, { binary: true });
        itemIds.push(item.id);
      }
      entries = [];
      // Photos are already compressed; STORE keeps a phone responsive.
      const generating = zip.generateAsync({ type: "blob", mimeType: "application/zip", compression: "STORE" });
      zip = null;
      const blob = await race(generating);
      checkpoint();
      const last = next >= selected && !carry;
      const name = number === 1 && last ? `${base}.zip` : `${base}_part-${String(number).padStart(2, "0")}.zip`;
      const part: PreparedPhotoPart = {
        token: `${sessionId}-${number}`,
        number,
        name,
        zip: new File([blob], name, { type: "application/zip" }),
        itemIds,
        last,
      };
      return part;
    } catch (err) {
      if (canceled || ctl.signal.aborted) {
        cancel();
        throw abortError();
      }
      // The ZIP itself could not be built: exactly this part's photos were
      // not packaged. A carried photo is the NEXT part's and stays reachable.
      for (const item of pending) fail(item, "zip_failed");
      pending = [];
      throw err;
    } finally {
      entries = [];
      progress();
    }
  }

  return {
    async nextPart() {
      // A stale owner cancels; it never sees a generic busy/retained refusal.
      checkpoint();
      if (busy) throw new Error("export_busy");
      if (current) throw new Error("part_retained");
      busy = true;
      try {
        const part = await build(partsPrepared + 1);
        checkpoint();
        // Publish and count in one synchronous step.
        if (part) {
          packaged += part.itemIds.length;
          partsPrepared = part.number;
        }
        pending = [];
        current = part;
        return part;
      } finally {
        busy = false;
      }
    },
    releasePart(token) {
      if (current?.token === token) current = null;
    },
    summary() {
      const remaining = selected - packaged - failed.length;
      return {
        selected,
        packaged,
        failed: failed.map((f) => ({ ...f })),
        remaining,
        partsPrepared,
        state: canceled ? "canceled" : remaining > 0 ? "active" : failed.length > 0 ? "partial" : "complete",
      };
    },
    cancel,
  };
}

// --------------------------------------------------------- download / share

export interface PhotoPartDownload {
  /** Start the download again (a retry) from the SAME object URL — never a new
   * one, so an earlier, possibly still running save is not cut off. After
   * revoke() it does nothing. Returns whether a download was started. */
  download(): boolean;
  /** Release the object URL. Idempotent; call on continue, reset, close. */
  revoke(): void;
}

/**
 * Start ONE browser download of an already-prepared part, now, and return the
 * handle that owns its object URL — kept alive until the caller revokes it,
 * because the browser never reports when (or whether) the save finished. Say
 * "Download started", never "saved". Each download() is one click; nothing
 * here clicks on its own.
 */
export function downloadPhotoPart(part: Pick<PreparedPhotoPart, "zip" | "name">): PhotoPartDownload {
  let url: string | null = URL.createObjectURL(part.zip);
  const handle: PhotoPartDownload = {
    download() {
      if (!url) return false;
      const a = document.createElement("a");
      a.href = url;
      a.download = part.name;
      a.rel = "noopener";
      a.style.display = "none";
      try {
        document.body.appendChild(a);
        a.click();
      } finally {
        a.remove();
      }
      return true;
    },
    revoke() {
      if (url) URL.revokeObjectURL(url);
      url = null;
    },
  };
  try {
    handle.download();
  } catch (err) {
    // The caller never receives the handle, so it could never revoke the URL.
    handle.revoke();
    throw err;
  }
  return handle;
}

export function canSharePhotoPart(part: Pick<PreparedPhotoPart, "zip">): boolean {
  return canShareMediaFiles([part.zip]);
}

/** Share the already-prepared ZIP. Call directly from the tap — never in a
 * loop, never after an await. Rejects on cancel (isMediaShareCancel). */
export function sharePhotoPart(part: Pick<PreparedPhotoPart, "zip">): Promise<void> {
  return shareMediaFiles([part.zip]);
}
