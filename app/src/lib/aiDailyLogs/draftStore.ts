// Where a Forge AI daily log draft and its photos wait on this phone: one
// current draft per account, the photo bytes beside it. IndexedDB, so a
// reload, a dead battery or an app switch keeps both.
//
// Every read is by account. Another person signing in on the same phone gets
// their own draft or none; they never see, send or upload someone else's.
// A write resolves only when its transaction commits (the rule
// lib/fieldAsk.ts `tx` follows): the card never says "kept on this phone"
// about bytes the phone did not keep.
import { readDraft, type AiDailyLogDraft } from "./draft";

export interface DailyLogDraftStore {
  /** False when this browser has no IndexedDB: the card must say so. */
  readonly durable: boolean;
  load(userId: string): Promise<AiDailyLogDraft | null>;
  save(draft: AiDailyLogDraft): Promise<void>;
  /** Forget the account's current draft. Its photo bytes go with it. */
  clear(userId: string, draftId: string): Promise<void>;
  putPhoto(userId: string, draftId: string, photoId: string, blob: Blob): Promise<void>;
  getPhoto(userId: string, photoId: string): Promise<Blob | null>;
  deletePhoto(userId: string, photoId: string): Promise<void>;
  /** Every photo kept for one account's draft (to find ones never listed). */
  photoIdsFor(userId: string, draftId: string): Promise<string[]>;
}

interface PhotoRow { id: string; userId: string; draftId: string; blob: Blob }

export class MemoryDailyLogDraftStore implements DailyLogDraftStore {
  readonly durable: boolean = false;
  drafts = new Map<string, string>();
  photos = new Map<string, PhotoRow>();
  async load(userId: string) {
    const raw = this.drafts.get(userId);
    return raw ? readDraft(JSON.parse(raw), userId) : null;
  }
  async save(draft: AiDailyLogDraft) { this.drafts.set(draft.userId, JSON.stringify(draft)); }
  async clear(userId: string, draftId: string) {
    const current = await this.load(userId);
    if (current?.id === draftId) this.drafts.delete(userId);
    for (const [id, row] of this.photos) if (row.userId === userId && row.draftId === draftId) this.photos.delete(id);
  }
  async putPhoto(userId: string, draftId: string, photoId: string, blob: Blob) { this.photos.set(photoId, { id: photoId, userId, draftId, blob }); }
  async getPhoto(userId: string, photoId: string) {
    const row = this.photos.get(photoId);
    return row && row.userId === userId ? row.blob : null;
  }
  async deletePhoto(userId: string, photoId: string) {
    if (this.photos.get(photoId)?.userId === userId) this.photos.delete(photoId);
  }
  async photoIdsFor(userId: string, draftId: string) {
    return [...this.photos.values()].filter((r) => r.userId === userId && r.draftId === draftId).map((r) => r.id);
  }
}

const DB = "forge-ai-daily-log";
const DRAFTS = "drafts";
const PHOTOS = "photos";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(DRAFTS, { keyPath: "userId" });
      req.result.createObjectStore(PHOTOS, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(stores: string[], mode: IDBTransactionMode, body: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction(stores, mode);
      let result: T | undefined;
      const r = body(t);
      if (r) r.onsuccess = () => { result = r.result; };
      t.oncomplete = () => resolve(result);
      t.onabort = () => reject(t.error ?? new Error("storage_aborted"));
      t.onerror = () => reject(t.error ?? new Error("storage_failed"));
    });
  } finally {
    db.close();
  }
}

export class IndexedDbDailyLogDraftStore implements DailyLogDraftStore {
  readonly durable: boolean = true;
  async load(userId: string) {
    const row = await run<AiDailyLogDraft>([DRAFTS], "readonly", (t) => t.objectStore(DRAFTS).get(userId));
    return readDraft(row, userId);
  }
  async save(draft: AiDailyLogDraft) {
    await run([DRAFTS], "readwrite", (t) => { t.objectStore(DRAFTS).put(draft); });
  }
  async clear(userId: string, draftId: string) {
    await run([DRAFTS, PHOTOS], "readwrite", (t) => {
      const drafts = t.objectStore(DRAFTS);
      const get = drafts.get(userId);
      get.onsuccess = () => { if ((get.result as AiDailyLogDraft | undefined)?.id === draftId) drafts.delete(userId); };
      const photos = t.objectStore(PHOTOS);
      const all = photos.getAll();
      all.onsuccess = () => {
        for (const row of all.result as PhotoRow[]) if (row.userId === userId && row.draftId === draftId) photos.delete(row.id);
      };
    });
  }
  async putPhoto(userId: string, draftId: string, photoId: string, blob: Blob) {
    await run([PHOTOS], "readwrite", (t) => { t.objectStore(PHOTOS).put({ id: photoId, userId, draftId, blob } satisfies PhotoRow); });
  }
  async getPhoto(userId: string, photoId: string) {
    const row = await run<PhotoRow>([PHOTOS], "readonly", (t) => t.objectStore(PHOTOS).get(photoId));
    return row && row.userId === userId ? row.blob : null;
  }
  async deletePhoto(userId: string, photoId: string) {
    await run([PHOTOS], "readwrite", (t) => {
      const photos = t.objectStore(PHOTOS);
      const get = photos.get(photoId);
      get.onsuccess = () => { if ((get.result as PhotoRow | undefined)?.userId === userId) photos.delete(photoId); };
    });
  }
  async photoIdsFor(userId: string, draftId: string) {
    const rows = await run<PhotoRow[]>([PHOTOS], "readonly", (t) => t.objectStore(PHOTOS).getAll() as IDBRequest<PhotoRow[]>);
    return (rows ?? []).filter((r) => r.userId === userId && r.draftId === draftId).map((r) => r.id);
  }
}

export function defaultDraftStore(): DailyLogDraftStore {
  return typeof indexedDB === "undefined" ? new MemoryDailyLogDraftStore() : new IndexedDbDailyLogDraftStore();
}
