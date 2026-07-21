// Browser-only seams for auto-sync: File System Access API (showDirectoryPicker)
// to connect an Obsidian vault folder, IndexedDB to persist the directory
// handle across reloads, and a recursive note scan. The pure diff/summary lives
// in vaultDiff.ts; this file holds everything that touches the DOM/FS/IDB.

import { deriveTitle, hashContent } from "./knowledge";
import type { ScannedNote } from "./vaultDiff";

// Minimal typings for the File System Access API (not in the standard DOM lib).
interface FsPermissionDescriptor {
  mode?: "read" | "readwrite";
}
interface VaultFileHandle {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
}
export interface VaultDirHandle {
  kind: "directory";
  name: string;
  entries(): AsyncIterableIterator<[string, VaultFileHandle | VaultDirHandle]>;
  queryPermission?(desc?: FsPermissionDescriptor): Promise<PermissionState>;
  requestPermission?(desc?: FsPermissionDescriptor): Promise<PermissionState>;
}

const NOTE_RE = /\.(md|markdown|mdx|txt)$/i;
const IDB_NAME = "infinity-vault-sync";
const IDB_STORE = "handles";
const HANDLE_KEY = "vaultDir";

/** True when this browser can auto-sync (Chromium desktop). */
export function hasFileSystemAccess(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as unknown as { showDirectoryPicker?: unknown })
      .showDirectoryPicker === "function"
  );
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(key: string, value: unknown): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).put(value, key);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      }),
  );
}

function idbGet<T>(key: string): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readonly");
        const req = tx.objectStore(IDB_STORE).get(key);
        req.onsuccess = () => {
          db.close();
          resolve((req.result as T) ?? null);
        };
        req.onerror = () => {
          db.close();
          reject(req.error);
        };
      }),
  );
}

function idbDelete(key: string): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).delete(key);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      }),
  );
}

/** Prompt the user to pick their vault folder and persist the handle. */
export async function connectVaultFolder(): Promise<VaultDirHandle> {
  const picker = (
    window as unknown as {
      showDirectoryPicker: (opts?: { mode?: "read" | "readwrite" }) => Promise<VaultDirHandle>;
    }
  ).showDirectoryPicker;
  const handle = await picker({ mode: "read" });
  await idbPut(HANDLE_KEY, handle).catch(() => {
    // Persisting is best-effort; the handle still works this session.
  });
  return handle;
}

/** The persisted handle from a previous session, if any. */
export async function getSavedVaultHandle(): Promise<VaultDirHandle | null> {
  try {
    return await idbGet<VaultDirHandle>(HANDLE_KEY);
  } catch {
    return null;
  }
}

/** Forget the connected folder (user disconnect / handle no longer valid). */
export async function forgetVaultFolder(): Promise<void> {
  await idbDelete(HANDLE_KEY).catch(() => {});
}

/**
 * Ensure we hold read permission for the handle, re-requesting if the browser
 * downgraded it to "prompt" after a reload. Returns false when denied.
 */
export async function ensureReadPermission(handle: VaultDirHandle): Promise<boolean> {
  const desc: FsPermissionDescriptor = { mode: "read" };
  try {
    if (handle.queryPermission) {
      const state = await handle.queryPermission(desc);
      if (state === "granted") return true;
    }
    if (handle.requestPermission) {
      const state = await handle.requestPermission(desc);
      return state === "granted";
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively read notes (.md/.markdown/.mdx/.txt) from the folder, skipping
 * `.obsidian` and other dot-directories. Each note carries the same content
 * hash the server stores, so the diff matches knowledge_docs.content_hash.
 * Resilient: an unreadable file is skipped, not fatal.
 */
export async function scanVaultFolder(handle: VaultDirHandle): Promise<ScannedNote[]> {
  const notes: ScannedNote[] = [];

  async function walk(dir: VaultDirHandle, prefix: string): Promise<void> {
    for await (const [name, child] of dir.entries()) {
      if (name.startsWith(".")) continue;
      const path = prefix ? `${prefix}/${name}` : name;
      if (child.kind === "directory") {
        await walk(child, path);
      } else if (NOTE_RE.test(name)) {
        try {
          const file = await child.getFile();
          const content = await file.text();
          if (!content.trim()) continue;
          notes.push({
            path,
            title: deriveTitle(path, content),
            content,
            hash: hashContent(content),
          });
        } catch {
          // Skip a file that vanished / can't be read; keep scanning.
        }
      }
    }
  }

  await walk(handle, "");
  return notes;
}
