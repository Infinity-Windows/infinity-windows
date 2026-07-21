// Pure vault-sync logic: diffing scanned notes against the live indexed docs
// and shaping the staged summary. No DOM, filesystem, crypto or Supabase — all
// side-effecting seams live in vaultSync.ts — so this stays fully unit-testable
// and identical in the browser and the test runner.
//
// Hashes MUST be computed with the same hashContent() the server stores in
// knowledge_docs.content_hash, so an unchanged note diffs as "unchanged".

export interface LiveDocLite {
  path: string;
  hash: string;
}

export interface ScannedNote {
  path: string;
  title: string;
  content: string;
  hash: string;
}

export interface VaultDiff {
  added: ScannedNote[];
  changed: ScannedNote[];
  removed: LiveDocLite[];
}

const byPath = (a: { path: string }, b: { path: string }): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/**
 * Classify scanned notes vs the live docs into added / changed / removed, each
 * sorted by path for a stable UI. A note is "changed" when its hash differs
 * from the live hash, "added" when its path isn't live yet, and "removed" when
 * a live path is absent from the scan.
 */
export function diffVault(
  live: LiveDocLite[],
  scanned: ScannedNote[],
): VaultDiff {
  const liveByPath = new Map<string, LiveDocLite>();
  for (const d of live) liveByPath.set(d.path, d);
  const scannedPaths = new Set(scanned.map((n) => n.path));

  const added: ScannedNote[] = [];
  const changed: ScannedNote[] = [];
  for (const note of scanned) {
    const existing = liveByPath.get(note.path);
    if (!existing) added.push(note);
    else if (existing.hash !== note.hash) changed.push(note);
  }

  const removed: LiveDocLite[] = live.filter((d) => !scannedPaths.has(d.path));

  return {
    added: added.sort(byPath),
    changed: changed.sort(byPath),
    removed: removed.sort(byPath),
  };
}

export interface DiffSummary {
  added: number;
  changed: number;
  removed: number;
  /** added + changed + removed. */
  total: number;
  hasChanges: boolean;
}

/** Counts + a single "is there anything to approve?" flag for the staged UI. */
export function summarizeDiff(diff: VaultDiff): DiffSummary {
  const added = diff.added.length;
  const changed = diff.changed.length;
  const removed = diff.removed.length;
  const total = added + changed + removed;
  return { added, changed, removed, total, hasChanges: total > 0 };
}

/** The notes that must be (re-)ingested on approve: everything added or changed. */
export function notesToIngest(diff: VaultDiff): ScannedNote[] {
  return [...diff.added, ...diff.changed].sort(byPath);
}

export type SyncMode = "auto" | "manual";

/**
 * The client's auto-sync-vs-manual-upload decision. The File System Access API
 * (showDirectoryPicker) is required for auto-sync; where it's unavailable
 * (Firefox/Safari/mobile) we fall back to the manual folder/file upload.
 */
export function pickSyncMode(env: { hasDirectoryPicker: boolean }): SyncMode {
  return env.hasDirectoryPicker ? "auto" : "manual";
}
