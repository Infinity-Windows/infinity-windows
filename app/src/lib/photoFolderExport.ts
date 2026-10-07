// Save-all-to-folder photo export: the owner has too many photos for one
// extraction, so on a browser that can write to a folder the grouped photo
// session's numbered ZIP parts are saved one after another into a fresh
// subfolder the person picked — no tap per part, and no giant archive.
//
// The session (groupedPhotoExport.ts) is unchanged and still holds one part at
// a time. This file only adds the folder writes, strictly in order:
//   nextPart -> getFileHandle -> createWritable -> write -> close
//   -> count as saved -> releasePart -> nextPart
// The next ZIP is never prepared before the current one's close succeeded, and
// a failed write keeps the exact same part (same token, same bytes) so it can
// be written again or downloaded by hand without being rebuilt.
//
// What this deliberately does NOT do: persist a folder handle (handles live in
// the running operation only), write into the picked folder itself or into a
// folder or file name that is already taken when checked, keep more than one
// ZIP, or click downloads in a loop. Where the File System Access API is
// missing — iPhone Safari, Firefox, an insecure origin — the existing
// one-ZIP-at-a-time flow is the only option.
//
// The API has no exclusive create: "is the name free?" and "create it" are two
// calls, so another program writing the same name in between could still be
// opened. The export subfolder's 128-bit random suffix makes that practically
// impossible for the folder, and every ZIP name is checked before its first
// write, but this is a check, not a lock.

import type { PhotoExportSession, PreparedPhotoPart } from "./groupedPhotoExport";

// Structural slices of the File System Access API — only what is used, so the
// tests can hand in plain objects and nothing depends on lib.dom's version.
export interface FolderWritable {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}
export interface FolderFileHandle {
  createWritable(): Promise<FolderWritable>;
}
export interface ExportFolderHandle {
  readonly name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<ExportFolderHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FolderFileHandle>;
}

type PickerScope = {
  isSecureContext?: boolean;
  showDirectoryPicker?: (options?: { mode?: "read" | "readwrite"; startIn?: string }) => Promise<ExportFolderHandle>;
};

export type FolderExportErrorCode = "unsupported" | "folder_exists" | "file_exists" | "write_failed";

export class FolderExportError extends Error {
  readonly code: FolderExportErrorCode;
  constructor(code: FolderExportErrorCode, options?: { cause?: unknown }) {
    super(code, options);
    this.name = "FolderExportError";
    this.code = code;
  }
}

/** The owner fence for one run: aborted or not current = stop. */
export interface FolderExportGuard {
  signal: AbortSignal;
  isCurrent: () => boolean;
}

function abortError(): DOMException {
  return new DOMException("Export canceled", "AbortError");
}

function current(guard: FolderExportGuard): boolean {
  try {
    return !guard.signal.aborted && guard.isCurrent();
  } catch {
    return false;
  }
}

function check(guard: FolderExportGuard): void {
  if (!current(guard)) throw abortError();
}

/** Start `call` on a later microtask — checking the guard INSIDE that
 * microtask, immediately before the file-system call, so a stop that lands
 * between an outer check and the deferred call still prevents it. */
function deferredCall<T>(guard: FolderExportGuard, call: () => Promise<T>): Promise<T> {
  return Promise.resolve().then(() => {
    check(guard);
    return call();
  });
}

function guarded<T>(guard: FolderExportGuard, call: () => Promise<T>): Promise<T> {
  return abortable(deferredCall(guard, call), guard.signal);
}

/** Writers are aborted, never just dropped: an abandoned writer's swap file
 * would otherwise linger until the browser collects it. */
function discard(writer: FolderWritable): void {
  try {
    void Promise.resolve(writer.abort()).catch(() => {});
  } catch {
    // Already closed or errored — nothing left to discard.
  }
}

/**
 * Settle with AbortError the moment `signal` aborts, without waiting for
 * `work` — a folder write can hang (a slow disk, a permission prompt) and
 * Cancel must still answer at once. `work`'s late rejection is swallowed.
 */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  work.catch(() => {});
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (err) => { signal.removeEventListener("abort", onAbort); reject(err); },
    );
  });
}

/** True only where a folder can be picked for writing: a secure page with
 * showDirectoryPicker. Everywhere else the dialog keeps the manual flow. */
export function canSaveZipsToFolder(scope: unknown = globalThis): boolean {
  const w = scope as PickerScope | null | undefined;
  return !!w && w.isSecureContext === true && typeof w.showDirectoryPicker === "function";
}

/**
 * Open the folder picker. Call it DIRECTLY from the tap, before any await —
 * browsers refuse the picker once the user activation is spent. Rejects
 * AbortError (isFolderPickerCancel) when the person closes the picker.
 */
export function pickExportFolder(scope: unknown = globalThis): Promise<ExportFolderHandle> {
  if (!canSaveZipsToFolder(scope)) return Promise.reject(new FolderExportError("unsupported"));
  const w = scope as Required<PickerScope>;
  return w.showDirectoryPicker({ mode: "readwrite", startIn: "downloads" });
}

export function isFolderPickerCancel(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === "AbortError";
}

/** 128 random bits as 32 hex characters. */
function randomId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `<base>_<YYYY-MM-DD_HHMMSS>_<random>` — local time, [A-Za-z0-9._-] only, so
 * nothing can escape the picked folder; the 128-bit suffix (never shortened)
 * makes two runs sharing a name practically impossible. */
export function exportFolderName(base: string, now = new Date(), random = randomId()): string {
  const safe = base.replace(/\.zip$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(0, 80) || "photos";
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${safe}_${stamp}_${random.replace(/[^A-Za-z0-9]+/g, "") || "x"}`;
}

/**
 * Create `name` as a NEW subfolder of `parent`. Refuses (folder_exists) when
 * anything of that name is already there — a folder or a file — rather than
 * writing into it. The check and the create are separate calls (the API has
 * no exclusive create); see the note at the top of this file.
 */
export async function createExportFolder(parent: ExportFolderHandle, name: string, guard: FolderExportGuard): Promise<ExportFolderHandle> {
  check(guard);
  let exists = true;
  try {
    await guarded(guard, () => parent.getDirectoryHandle(name));
  } catch (err) {
    check(guard);
    const kind = (err as { name?: string } | null)?.name;
    if (kind === "NotFoundError") exists = false;
    else if (kind !== "TypeMismatchError") throw err; // TypeMismatch: a FILE has that name
  }
  check(guard);
  if (exists) throw new FolderExportError("folder_exists");
  const folder = await guarded(guard, () => parent.getDirectoryHandle(name, { create: true }));
  check(guard);
  return folder;
}

/** First attempt at a ZIP name: refuse (file_exists) when the name is already
 * taken — by a file or a folder — instead of opening and replacing it. */
async function createTargetFile(folder: ExportFolderHandle, name: string, guard: FolderExportGuard): Promise<FolderFileHandle> {
  let exists = true;
  try {
    await guarded(guard, () => folder.getFileHandle(name));
  } catch (err) {
    check(guard);
    const kind = (err as { name?: string } | null)?.name;
    if (kind === "NotFoundError") exists = false;
    else if (kind !== "TypeMismatchError") throw err; // TypeMismatch: a FOLDER has that name
  }
  check(guard);
  if (exists) throw new FolderExportError("file_exists");
  return guarded(guard, () => folder.getFileHandle(name, { create: true }));
}

function writeFailure(err: unknown, guard: FolderExportGuard): unknown {
  if (!current(guard)) return abortError();
  return err instanceof FolderExportError ? err : new FolderExportError("write_failed", { cause: err });
}

/** The one file handle this run created for the part it is writing, so a
 * retry of the SAME token reopens exactly that file and nothing else. */
interface OwnedFile {
  token: string;
  name: string;
  file: FolderFileHandle;
}

/** ZIPs whose close() succeeded in this run. Keyed by token so a part written
 * again (a retry) is never counted twice. Also holds at most one owned file
 * handle — the current part's — for its retries. */
export interface FolderSaveTally {
  readonly tokens: Set<string>;
  parts: number;
  files: number;
  owned: OwnedFile | null;
}

export function createFolderSaveTally(): FolderSaveTally {
  return { tokens: new Set(), parts: 0, files: 0, owned: null };
}

/**
 * Write one prepared ZIP into `folder` and close it. Resolves only after
 * close() succeeded. Rejects AbortError once stopped and FolderExportError
 * ("file_exists" / "write_failed") on any file-system failure — in both cases
 * the caller still holds the part, so nothing is lost or rebuilt.
 *
 * The part's name, bytes and token are read once, on entry. Its first attempt
 * refuses a name that is already taken; a retry of the same token reuses the
 * file handle that attempt created (kept in `tally`, one at a time).
 *
 * Any failure or stop aborts the writer (the browser discards the unfinished
 * file). A stop or failure after close() was invoked also aborts it, but only
 * as best effort: an invoked close may still commit the file, so the UI says
 * the current ZIP may have finished saving.
 */
export async function writePartToFolder(
  folder: ExportFolderHandle,
  part: Pick<PreparedPhotoPart, "name" | "zip" | "token">,
  guard: FolderExportGuard,
  tally: FolderSaveTally = createFolderSaveTally(),
): Promise<void> {
  const { name, zip, token } = part;
  check(guard);
  let file: FolderFileHandle;
  const owned = tally.owned;
  if (owned && owned.token === token && owned.name === name) {
    file = owned.file;
  } else {
    try {
      file = await createTargetFile(folder, name, guard);
    } catch (err) {
      throw writeFailure(err, guard);
    }
    check(guard);
    tally.owned = { token, name, file };
  }

  const creating = deferredCall(guard, () => file.createWritable());
  let writer: FolderWritable;
  try {
    writer = await abortable(creating, guard.signal);
  } catch (err) {
    // Stopped while the writer was being opened: one that arrives late is
    // aborted on arrival.
    void creating.then(discard, () => {});
    throw writeFailure(err, guard);
  }
  if (!current(guard)) {
    discard(writer);
    throw abortError();
  }

  // A stop aborts the writer at once, whatever it is waiting on.
  const onAbort = () => discard(writer);
  guard.signal.addEventListener("abort", onAbort, { once: true });
  try {
    try {
      await guarded(guard, () => writer.write(zip));
    } catch (err) {
      discard(writer);
      throw writeFailure(err, guard);
    }
    if (!current(guard)) {
      discard(writer);
      throw abortError();
    }
    try {
      // The guard is checked again inside, so close is never invoked after a stop.
      await guarded(guard, () => writer.close());
    } catch (err) {
      discard(writer);
      throw writeFailure(err, guard);
    }
  } finally {
    guard.signal.removeEventListener("abort", onAbort);
  }
  check(guard);
}

export type FolderRunResult =
  | { status: "done" }
  | { status: "write_failed"; part: PreparedPhotoPart; error: FolderExportError };

export interface FolderRunOptions extends FolderExportGuard {
  session: Pick<PhotoExportSession, "nextPart" | "releasePart">;
  folder: ExportFolderHandle;
  tally: FolderSaveTally;
  /** A part kept after a failed write: written first, without rebuilding. */
  retained?: PreparedPhotoPart | null;
  /** The part about to be written — the caller keeps it for retry/download. */
  onPart?: (part: PreparedPhotoPart) => void;
  /** Called after close() succeeded and the part was counted and released. */
  onSaved?: (part: PreparedPhotoPart) => void;
}

/** Observers only display; one that throws can neither undo a save nor turn
 * into a ZIP failure. */
function notify(observer: ((part: PreparedPhotoPart) => void) | undefined, part: PreparedPhotoPart): void {
  try {
    observer?.(part);
  } catch {
    // Ignored on purpose — see above.
  }
}

/**
 * Drive the session into the folder until it is exhausted, stopped, or a write
 * fails. A failed write returns the SAME part (a snapshot taken when it was
 * received: same token, name and bytes), unreleased and uncounted. A ZIP that
 * could not be built rejects with the session's error (its photos are in the
 * session's failed list) and nothing after it is attempted.
 */
export async function saveSessionToFolder(options: FolderRunOptions): Promise<FolderRunResult> {
  // Capture observers separately: saveOne must not retain options.retained
  // (the retried ZIP) while later parts are being prepared.
  const { session, folder, tally, onPart, onSaved } = options;
  const guard: FolderExportGuard = { signal: options.signal, isCurrent: options.isCurrent };
  check(guard);

  /** One part, start to finish. Its own frame, so nothing here still holds
   * the saved ZIP while the caller waits for the next one. */
  async function saveOne(received: PreparedPhotoPart): Promise<FolderRunResult | "next" | "last"> {
    // Read once: nothing an observer does to the object can change what is
    // written, counted or released.
    const itemIds = [...received.itemIds];
    Object.freeze(itemIds);
    const part: PreparedPhotoPart = Object.freeze({ ...received, itemIds });
    notify(onPart, part);
    check(guard);
    try {
      await writePartToFolder(folder, part, guard, tally);
    } catch (err) {
      check(guard);
      if (err instanceof FolderExportError) return { status: "write_failed", part, error: err };
      throw err;
    }
    // A stale continuation after a successful close publishes nothing.
    check(guard);
    // Count and let the session drop it in one synchronous step, before any
    // observer runs, so a throwing observer can never strand a counted part.
    if (!tally.tokens.has(part.token)) {
      tally.tokens.add(part.token);
      tally.parts++;
      tally.files += part.itemIds.length;
    }
    session.releasePart(part.token);
    if (tally.owned?.token === part.token) tally.owned = null;
    notify(onSaved, part);
    check(guard);
    return part.last ? "last" : "next";
  }

  let received = options.retained ?? null;
  if (!received) {
    received = await abortable(session.nextPart(), guard.signal);
    check(guard);
  }
  while (received) {
    const outcome = await saveOne(received);
    received = null;
    check(guard);
    if (outcome === "last") break;
    if (outcome !== "next") return outcome;
    received = await abortable(session.nextPart(), guard.signal);
    check(guard);
  }
  check(guard);
  return { status: "done" };
}
