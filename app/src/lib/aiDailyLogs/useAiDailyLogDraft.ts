// The controller behind the Forge AI daily log card. Binds the pure draft
// (draft.ts) to the phone's storage, the save RPC and the upload queue, for the
// account that is signed in NOW.
//
// Four rules this is written around:
//  * Every change is a FUNCTION of the draft as it is when it lands (apply /
//    applyTo), never a copy taken before an await. A shared-log read, a photo
//    finishing its stamp or a save receipt cannot overwrite words typed while it
//    was in flight.
//  * Writes to the phone go out one at a time, in order, and a failed one is
//    shown (storageError) — the card never says "kept on this phone" about a
//    change the phone did not keep.
//  * Identity is checked where it matters, not remembered: immediately before
//    the save request and before each photo hand-off, the account on screen and
//    the signed-in auth session must both be the draft's owner. The request
//    also names that owner (p_actor) and the server refuses anyone else.
//  * A photo is pointed at the job showing when it was picked. Save waits until
//    every picked file is either kept on the phone or visibly refused.
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../supabase";
import {
  getPhotoUploadProgress,
  enqueueUpload as enqueueUploadDefault,
  listFailed,
  retryFailed,
  subscribe,
  subscribeSynced,
} from "../offline/outbox";
import { localDateISO } from "../dailyLogDay";
import type { DailyLogField } from "../../../../supabase/functions/_shared/aiDailyLog";
import * as D from "./draft";
import { defaultDraftStore, type DailyLogDraftStore } from "./draftStore";
import { preparePhoto, photoState, type PhotoRejection, type PhotoState, type QueueView } from "./photos";
import {
  queueSavedPhotos,
  readServerPhotoStatus,
  readSharedLog,
  sendContribution,
  type ServerPhotoStatus,
} from "./save";

export interface DailyLogActor {
  userId: string;
  email: string | null;
  displayName: string | null;
}

export interface AiDailyLogDeps {
  store: DailyLogDraftStore;
  send: typeof sendContribution;
  readLog: typeof readSharedLog;
  readPhotos: typeof readServerPhotoStatus;
  enqueueUpload: typeof enqueueUploadDefault;
  prepare: typeof preparePhoto;
  queueView: (photoId: string) => Promise<{ view: QueueView; error?: string }>;
  retryUpload: (photoId: string) => Promise<void>;
  onQueueChange: (cb: () => void) => () => void;
  /** The user id of the auth session requests will actually be sent with. */
  authUserId: () => Promise<string | null>;
  today: () => string;
  online: () => boolean;
}

async function defaultQueueView(photoId: string): Promise<{ view: QueueView; error?: string }> {
  const p = await getPhotoUploadProgress([photoId]);
  if (p.failed) {
    const entry = (await listFailed()).find((e) => e.id === photoId);
    return { view: "failed", error: entry?.lastError ?? undefined };
  }
  if (p.pending) return { view: "pending" };
  if (p.uploaded) return { view: "uploaded" };
  return { view: "none" };
}

const defaultDeps = (): AiDailyLogDeps => ({
  store: defaultDraftStore(),
  send: sendContribution,
  readLog: readSharedLog,
  readPhotos: readServerPhotoStatus,
  enqueueUpload: enqueueUploadDefault,
  prepare: preparePhoto,
  queueView: defaultQueueView,
  retryUpload: retryFailed,
  onQueueChange: (cb) => { const a = subscribe(cb); const b = subscribeSynced(cb); return () => { a(); b(); }; },
  authUserId: async () => {
    try { return (await supabase.auth.getSession()).data.session?.user?.id ?? null; } catch { return null; }
  },
  today: () => localDateISO(),
  online: () => typeof navigator === "undefined" || navigator.onLine !== false,
});

export interface PhotoView { photo: D.DraftPhoto; state: PhotoState; error?: string }
export type RejectReason = PhotoRejection | "not_kept" | "too_many" | "draft_closed";
export type StartOverResult = { done: true } | { done: false; reason: "saving" | "unsent_photos" | "account_changed"; unsent: number };

export interface AiDailyLogController {
  actor: DailyLogActor | null;
  draft: D.AiDailyLogDraft | null;
  /** The draft as it is this instant — for code that runs after an await,
   * where a rendered `draft` would be a stale closure. */
  snapshot: () => D.AiDailyLogDraft | null;
  loading: boolean;
  /** False when this browser cannot keep the draft through a reload. */
  durable: boolean;
  /** The last write to this phone failed: what is on screen is not all kept. */
  storageError: string | null;
  saving: boolean;
  /** Picked photos still being stamped/kept for the draft on screen. Save waits. */
  preparingPhotos: number;
  /** Save was pressed but not sent: the signed-in account is not this draft's. */
  blockedByAccount: boolean;
  checkingLog: boolean;
  logError: string | null;
  photoViews: PhotoView[];
  rejectedPhotos: { name: string; reason: RejectReason }[];
  queueFailures: { photoId: string; message: string }[];
  /**
   * Open (or resume) the draft and return it — the value to build the very
   * first Ask request from. A finished entry whose photos are all with the
   * upload queue is closed and a new one started. `suggestedJob` is offered only.
   */
  start: (opts?: { logDate?: string; suggestedJob?: D.DailyLogJobRef | null }) => Promise<D.AiDailyLogDraft | null>;
  chooseJob: (job: D.DailyLogJobRef, source?: D.DraftJob["source"]) => void;
  offerJobs: (candidates: D.DailyLogJobRef[]) => void;
  setLogDate: (logDate: string) => void;
  /** A Forge AI reply for this draft (see askBridge.ts / INTEGRATION.md). */
  applyModelReply: (reply: D.ModelReply) => void;
  /** Words held back at the message limit, kept as the person's typed answers. */
  keepHeldAsTyped: () => void;
  /** Try again to keep the draft on this phone after a storage error. */
  retryStorage: () => Promise<boolean>;
  editAnswer: (key: DailyLogField, value: string | { unknown: true } | null) => void;
  acceptSuggestion: (key: DailyLogField, value: string, source: "job_clock" | "unit_records" | "earlier_log") => void;
  attachFiles: (files: File[]) => Promise<void>;
  removePhoto: (photoId: string) => void;
  movePhoto: (photoId: string, job: D.DailyLogJobRef) => void;
  setCaption: (photoId: string, caption: string) => void;
  refreshLog: () => Promise<void>;
  save: () => Promise<void>;
  retryPhoto: (photoId: string) => Promise<void>;
  refreshPhotos: () => Promise<void>;
  /** Close this entry and start fresh. Refused while photos of a SAVED entry
   * are still only in this draft, unless `discardUnsent` is passed. */
  startOver: (opts?: { discardUnsent?: boolean }) => Promise<StartOverResult>;
  photoBlob: (photoId: string) => Promise<Blob | null>;
}

export function useAiDailyLogDraft(actor: DailyLogActor | null, overrides: Partial<AiDailyLogDeps> = {}): AiDailyLogController {
  const depsRef = useRef<AiDailyLogDeps | null>(null);
  if (!depsRef.current) depsRef.current = { ...defaultDeps(), ...overrides };
  const deps = depsRef.current;

  const [draft, setDraftState] = useState<D.AiDailyLogDraft | null>(null);
  const [loading, setLoading] = useState(Boolean(actor));
  const [saving, setSaving] = useState(false);
  const [checkingLog, setCheckingLog] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [blockedByAccount, setBlockedByAccount] = useState(false);
  const [server, setServer] = useState<ServerPhotoStatus[] | null>(null);
  const [queue, setQueue] = useState<Record<string, { view: QueueView; error?: string }>>({});
  const [rejectedPhotos, setRejected] = useState<AiDailyLogController["rejectedPhotos"]>([]);
  const [queueFailures, setQueueFailures] = useState<AiDailyLogController["queueFailures"]>([]);
  const [preparing, setPreparing] = useState<Record<string, number>>({});

  const actorId = actor?.userId ?? null;
  const actorRef = useRef(actor);
  actorRef.current = actor;
  const draftRef = useRef<D.AiDailyLogDraft | null>(null);
  const savingRef = useRef(false);
  const preparingRef = useRef<Record<string, number>>({});

  // ---------------------------------------------------------------- storage
  const writeChain = useRef<Promise<unknown>>(Promise.resolve());
  const writeSeq = useRef(0);
  /** Queue one write behind the others; the newest decides the error state. */
  const persist = useCallback((next: D.AiDailyLogDraft): Promise<boolean> => {
    const seq = ++writeSeq.current;
    const run = writeChain.current.then(() => deps.store.save(next)).then(
      () => { if (seq === writeSeq.current && actorRef.current?.userId === next.userId) setStorageError(null); return true; },
      (e: unknown) => {
        if (actorRef.current?.userId === next.userId) setStorageError(e instanceof Error && e.message ? e.message : "storage_failed");
        return false;
      },
    );
    writeChain.current = run;
    return run;
  }, [deps]);

  const show = useCallback((next: D.AiDailyLogDraft) => {
    draftRef.current = next;
    setDraftState(next);
  }, []);

  /** Change the draft on screen, synchronously, from its current value. */
  const apply = useCallback((fn: (d: D.AiDailyLogDraft) => D.AiDailyLogDraft): D.AiDailyLogDraft | null => {
    const current = draftRef.current;
    if (!current || current.userId !== actorRef.current?.userId) return null;
    const next = fn(current);
    if (next === current) return current;
    show(next);
    void persist(next);
    return next;
  }, [persist, show]);

  /**
   * Change ONE account's ONE draft wherever it is: on screen if it still is,
   * otherwise in storage (the account switched away while this was in flight).
   * `changed`: the draft existed and took the change. `kept`: the phone
   * stored it — false means it is on screen only (storageError says so).
   */
  const applyTo = useCallback(async (userId: string, draftId: string, fn: (d: D.AiDailyLogDraft) => D.AiDailyLogDraft): Promise<{ changed: boolean; kept: boolean }> => {
    const current = draftRef.current;
    if (current && current.id === draftId && current.userId === userId && actorRef.current?.userId === userId) {
      const next = fn(current);
      if (next === current) return { changed: false, kept: true };
      show(next);
      return { changed: true, kept: await persist(next) };
    }
    let changed = false;
    const run = writeChain.current.then(async () => {
      const stored = await deps.store.load(userId);
      if (!stored || stored.id !== draftId) return;
      const next = fn(stored);
      if (next === stored) return;
      await deps.store.save(next);
      changed = true;
    }).catch(() => undefined);
    writeChain.current = run;
    await run;
    // Off screen, a change is only "made" once it is stored.
    return { changed, kept: changed };
  }, [deps, persist, show]);

  /** The account on screen AND in the auth session, or null if they differ. */
  const currentAccount = useCallback(async () => {
    const who = actorRef.current;
    if (!who?.email) return null;
    const authId = await deps.authUserId();
    const still = actorRef.current;
    if (!still || still.userId !== who.userId || authId !== who.userId) return null;
    return { userId: who.userId, email: who.email };
  }, [deps]);

  const bumpPreparing = useCallback((draftId: string, delta: number) => {
    const next = { ...preparingRef.current, [draftId]: Math.max(0, (preparingRef.current[draftId] ?? 0) + delta) };
    if (!next[draftId]) delete next[draftId];
    preparingRef.current = next;
    setPreparing(next);
  }, []);

  // A different account: forget everything on screen, load theirs.
  useEffect(() => {
    let alive = true;
    draftRef.current = null;
    setDraftState(null);
    setServer(null);
    setQueue({});
    setRejected([]);
    setQueueFailures([]);
    setLogError(null);
    setStorageError(null);
    setBlockedByAccount(false);
    if (!actorId) { setLoading(false); return; }
    setLoading(true);
    deps.store.load(actorId).then(async (d) => {
      if (!alive || actorRef.current?.userId !== actorId) return;
      // Bytes kept on the phone whose listing in the draft was never stored (a
      // write failed after the photo was kept): list them again, pointed at no
      // job, so the person decides — never silently orphaned.
      if (d && !D.isFrozen(d)) {
        const known = new Set(d.photos.map((p) => p.id));
        const orphans = (await deps.store.photoIdsFor(actorId, d.id).catch(() => [] as string[])).filter((id) => !known.has(id));
        for (const id of orphans) {
          const blob = await deps.store.getPhoto(actorId, id).catch(() => null);
          if (blob) d = D.addPhoto(d, { id, caption: null, takenAt: new Date().toISOString(), lat: null, lng: null, accuracyM: null, bytes: blob.size }, null);
        }
        if (!alive || actorRef.current?.userId !== actorId) return;
        if (orphans.length && !draftRef.current) { show(d); void persist(d); return; }
      }
      // A draft started (start()) while this read was out wins.
      if (!draftRef.current) show(d as D.AiDailyLogDraft);
    }).catch(() => undefined).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [actorId, deps, persist, show]);

  const refreshLog = useCallback(async () => {
    const d = draftRef.current;
    if (!d?.job || d.pending || d.receipt) return;
    const { id, userId, logDate } = d;
    const { projectId } = d.job;
    setCheckingLog(true);
    setLogError(null);
    try {
      const log = await deps.readLog(projectId, logDate);
      // Applied only if the job and day are still the ones that were read.
      await applyTo(userId, id, (x) => (x.job?.projectId === projectId && x.logDate === logDate && !x.pending && !x.receipt ? D.setBase(x, log) : x));
    } catch {
      if (draftRef.current?.id === id) setLogError("load_failed");
    } finally {
      setCheckingLog(false);
    }
  }, [applyTo, deps]);

  const refreshPhotos = useCallback(async () => {
    const d = draftRef.current;
    if (!d) return;
    const entries = await Promise.all(d.photos.filter((p) => p.queuedAt).map(async (p) => [p.id, await deps.queueView(p.id).catch(() => ({ view: "none" as const }))] as const));
    if (draftRef.current?.id !== d.id) return;
    setQueue(Object.fromEntries(entries));
    if (d.receipt && d.photos.length) {
      const s = await deps.readPhotos(d.receipt.contribution_id).catch(() => null);
      if (draftRef.current?.id === d.id && s) setServer(s);
    }
  }, [deps]);

  useEffect(() => {
    if (!draft?.receipt) return;
    void refreshPhotos();
    return deps.onQueueChange(() => { void refreshPhotos(); });
  }, [draft?.receipt, draft?.id, deps, refreshPhotos]);

  // A job or date chosen (or reopened) whose shared-log preview is not read yet.
  useEffect(() => {
    if (draft?.job && !draft.base && !draft.pending && !draft.receipt) void refreshLog();
  }, [draft?.job, draft?.logDate, draft?.base, draft?.pending, draft?.receipt, refreshLog]);

  // One start at a time: a second call (the first message and the preset in
  // quick succession) waits for the first and gets the same draft, rather than
  // closing the draft the first one just opened.
  const starting = useRef<{ userId: string; run: Promise<D.AiDailyLogDraft | null> } | null>(null);
  const start: AiDailyLogController["start"] = useCallback((opts = {}) => {
    const who = actorRef.current;
    if (!who) return Promise.resolve(null);
    if (starting.current?.userId === who.userId) return starting.current.run;
    const stillHere = () => actorRef.current?.userId === who.userId;
    const run = (async () => {
      let d = draftRef.current ?? (await deps.store.load(who.userId));
      if (!stillHere()) return null;
      // A draft may have been shown while the read was out; take that one.
      if (draftRef.current) d = draftRef.current;
      const today = deps.today();
      // A finished entry is closed only when nothing of it is left on the phone
      // alone; otherwise it stays so its photos can still be handed over.
      if (d?.receipt && d.photos.every((p) => p.queuedAt)) {
        await deps.store.clear(d.userId, d.id).catch(() => undefined);
        // Another person may be on screen now: nothing of this account is shown.
        if (!stillHere()) return null;
        d = null;
      }
      if (!d) d = D.newDraft(who.userId, opts.logDate && D.validLogDate(opts.logDate, today) ? opts.logDate : today);
      else if (opts.logDate) d = D.setLogDate(d, opts.logDate, today);
      if (opts.suggestedJob && !d.job) d = D.offerJobs(d, [opts.suggestedJob]);
      if (!stillHere()) return null;
      show(d);
      await persist(d);
      return stillHere() ? draftRef.current : null;
    })();
    const entry = { userId: who.userId, run };
    starting.current = entry;
    void run.finally(() => { if (starting.current === entry) starting.current = null; });
    return run;
  }, [deps, persist, show]);

  const attachFiles = useCallback(async (files: File[]) => {
    const d = draftRef.current;
    const who = actorRef.current;
    if (!d || !who || d.userId !== who.userId || D.isFrozen(d)) return;
    // Where these photos go is decided NOW, by what the person is looking at —
    // not after decoding, when the job on screen may be a different one.
    const destination = D.destinationNow(d);
    const { id: draftId, userId } = d;
    const rejected: AiDailyLogController["rejectedPhotos"] = [];
    bumpPreparing(draftId, files.length);
    for (const file of files) {
      try {
        let prepared: Awaited<ReturnType<typeof deps.prepare>>;
        try {
          prepared = await deps.prepare(file, { label: destination?.label ?? null });
        } catch {
          // One file that cannot be stamped must not leave Save waiting forever
          // or stop the rest: it is refused, and the next one goes on.
          rejected.push({ name: file.name, reason: "unreadable" });
          continue;
        }
        if (!prepared.ok) { rejected.push({ name: prepared.name, reason: prepared.reason }); continue; }
        try {
          // The bytes first: a photo is listed only once the phone really holds it.
          await deps.store.putPhoto(userId, draftId, prepared.photo.id, prepared.blob);
        } catch {
          rejected.push({ name: file.name, reason: "not_kept" });
          continue;
        }
        let full = false;
        const added = await applyTo(userId, draftId, (x) => {
          if (x.photos.length >= D.MAX_DRAFT_PHOTOS) { full = true; return x; }
          return D.addPhoto(x, prepared.photo, destination);
        });
        // Listed on screen but the listing was not stored (storageError shows):
        // the bytes stay, and are listed again on reload if never stored.
        if (!added.changed) {
          // Its draft is closed or full: these bytes belong to nothing now.
          await deps.store.deletePhoto(userId, prepared.photo.id).catch(() => undefined);
          rejected.push({ name: file.name, reason: full ? "too_many" : "draft_closed" });
        }
      } finally {
        bumpPreparing(draftId, -1);
      }
    }
    if (actorRef.current?.userId === userId && draftRef.current?.id === draftId) setRejected(rejected);
  }, [applyTo, bumpPreparing, deps]);

  const removePhoto = useCallback((photoId: string) => {
    const d = draftRef.current;
    if (!d || D.isFrozen(d)) return;
    apply((x) => D.removePhoto(x, photoId));
    void deps.store.deletePhoto(d.userId, photoId).catch(() => undefined);
  }, [apply, deps]);

  /**
   * Give the saved log's photos to the upload queue — after the receipt, on
   * reopening a saved draft whose hand-off never finished (a reload, or the
   * account that saved it switching away mid-save), and on Retry.
   */
  const handingOff = useRef(false);
  const handOff = useCallback(async () => {
    const d = draftRef.current;
    const who = actorRef.current;
    if (!d?.receipt || !who || d.userId !== who.userId || handingOff.current || !D.photosReadyToQueue(d).length) return;
    handingOff.current = true;
    try {
      const handed = await queueSavedPhotos(d, {
        account: currentAccount,
        getBlob: (id) => deps.store.getPhoto(d.userId, id),
        enqueueUpload: deps.enqueueUpload,
        recordQueued: async (photoId) => { await applyTo(d.userId, d.id, (x) => D.markQueued(x, photoId)); },
        // Kept until the entry is closed: the thumbnail, and a second copy if
        // the queued one is ever discarded from Stuck writes.
        dropBlob: async () => undefined,
      });
      if (actorRef.current?.userId === d.userId) setQueueFailures(handed.failed);
    } finally {
      handingOff.current = false;
    }
    void refreshPhotos();
  }, [applyTo, currentAccount, deps, refreshPhotos]);

  useEffect(() => {
    if (draft?.receipt && !saving) void handOff();
  }, [draft?.receipt, draft?.id, saving, handOff]);

  const save = useCallback(async () => {
    const d = draftRef.current;
    const who = actorRef.current;
    // One press at a time. A second tap while the first is out is ignored; a
    // tap after an uncertain answer resends the same frozen payload.
    if (!d || !who || d.userId !== who.userId || savingRef.current || d.receipt) return;
    // A picked photo still being stamped would be left out of a frozen entry.
    if ((preparingRef.current[d.id] ?? 0) > 0) return;
    const begun = D.beginSave(d, deps.today());
    if (!("payload" in begun)) return;
    savingRef.current = true;
    setSaving(true);
    setRejected([]);
    setBlockedByAccount(false);
    try {
      // Frozen on screen at once and on the phone BEFORE it leaves, so a reload
      // mid-flight resends the same words instead of a newer edit.
      show(begun.draft);
      // If the phone could not keep what is about to be sent, do not send it:
      // a lost answer could then never be resent as exactly these words. It
      // stays frozen on screen; Save again tries the same payload once storage
      // works (storageError says why nothing happened).
      if (!(await persist(begun.draft))) return;
      // The last moment before the request: is the person holding the phone,
      // and the session the request will carry, still this draft's owner?
      const account = await currentAccount();
      if (!account || account.userId !== begun.payload.actorId) {
        // Not sent. It stays frozen under its owner, to resend when they are back.
        if (actorRef.current?.userId === begun.payload.actorId) setBlockedByAccount(true);
        return;
      }
      const outcome = await deps.send(begun.payload);
      await applyTo(begun.payload.actorId, begun.payload.id, (x) => D.applySaveOutcome(x, begun.payload.id, outcome));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
    await handOff();
  }, [applyTo, currentAccount, deps, handOff, persist, show]);

  const retryPhoto = useCallback(async (photoId: string) => {
    const d = draftRef.current;
    if (!d?.receipt) return;
    const photo = d.photos.find((p) => p.id === photoId);
    if (!photo) return;
    if (photo.queuedAt) {
      const view = (await deps.queueView(photoId).catch(() => ({ view: "none" as const }))).view;
      // The queue gave up on it: resend the same entry.
      if (view === "failed") await deps.retryUpload(photoId);
      else if (view === "none") {
        // Not in the queue any more (e.g. discarded from Stuck writes). Only if
        // the server does not have it either is it handed over again — same
        // id, from the bytes this draft kept. Never reported as uploaded.
        const server = await deps.readPhotos(d.receipt.contribution_id).catch(() => null);
        if (server && !server.some((s) => s.photo_id === photoId && s.arrived)) {
          await applyTo(d.userId, d.id, (x) => D.unmarkQueued(x, photoId));
          await handOff();
        }
      }
    } else {
      // Never handed over (the queue refused it): try the hand-off again.
      await handOff();
    }
    await refreshPhotos();
  }, [applyTo, deps, handOff, refreshPhotos]);

  /** Write the draft on screen to the phone again (after a storage error). */
  const retryStorage = useCallback(async () => {
    const d = draftRef.current;
    if (!d || d.userId !== actorRef.current?.userId) return false;
    return persist(d);
  }, [persist]);

  const startOver = useCallback(async (opts: { discardUnsent?: boolean } = {}): Promise<StartOverResult> => {
    const d = draftRef.current;
    const who = actorRef.current;
    if (!who || (d && d.userId !== who.userId) || savingRef.current || d?.pending) {
      return { done: false, reason: "saving", unsent: 0 };
    }
    // A saved entry's photos that never reached the upload queue exist only
    // here. Closing it would lose them, so that takes an explicit discard.
    const unsent = d?.receipt ? d.photos.filter((p) => !p.queuedAt).length : 0;
    if (unsent && !opts.discardUnsent) return { done: false, reason: "unsent_photos", unsent };
    if (d) await deps.store.clear(d.userId, d.id);
    // The account may have changed during the clear: never show the old
    // account a new draft on the next person's screen.
    if (actorRef.current?.userId !== who.userId) return { done: false, reason: "account_changed", unsent: 0 };
    const fresh = D.newDraft(who.userId, deps.today());
    setServer(null); setQueue({}); setRejected([]); setQueueFailures([]); setBlockedByAccount(false);
    show(fresh);
    await persist(fresh);
    return { done: true };
  }, [deps, persist, show]);

  const photoBlob = useCallback(
    (photoId: string) => (draftRef.current ? deps.store.getPhoto(draftRef.current.userId, photoId) : Promise.resolve(null)),
    [deps],
  );
  const snapshot = useCallback(() => draftRef.current, []);

  const photoViews: PhotoView[] = (draft?.photos ?? []).map((photo) => {
    const q = queue[photo.id] ?? { view: "none" as const };
    return { photo, state: photoState(photo, q.view, server, deps.online()), error: q.error };
  });

  return {
    actor, draft, snapshot, loading, durable: deps.store.durable, storageError, saving,
    preparingPhotos: draft ? preparing[draft.id] ?? 0 : 0,
    blockedByAccount, checkingLog, logError, photoViews, rejectedPhotos, queueFailures,
    start,
    chooseJob: (job, source) => { apply((d) => D.chooseJob(d, job, source)); },
    offerJobs: (c) => { apply((d) => D.offerJobs(d, c)); },
    setLogDate: (logDate) => { apply((d) => D.setLogDate(d, logDate, deps.today())); },
    applyModelReply: (reply) => { apply((d) => D.applyModelAnswers(d, reply)); },
    keepHeldAsTyped: () => { apply((d) => D.keepHeldAsTyped(d)); },
    retryStorage,
    editAnswer: (key, value) => { apply((d) => D.editAnswer(d, key, value)); },
    acceptSuggestion: (key, value, source) => { apply((d) => D.acceptSuggestion(d, key, value, source)); },
    attachFiles,
    removePhoto,
    movePhoto: (photoId, job) => { apply((d) => D.setPhotoDestination(d, photoId, job)); },
    setCaption: (photoId, caption) => { apply((d) => D.setCaption(d, photoId, caption)); },
    refreshLog,
    save,
    retryPhoto,
    refreshPhotos,
    startOver,
    photoBlob,
  };
}
