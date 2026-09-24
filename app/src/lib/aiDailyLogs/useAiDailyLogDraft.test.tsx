// @vitest-environment happy-dom
// The controller under the failures that lose, misattribute or duplicate field
// work: a double tap, a lost response, a reload mid-save, someone else adding
// first, another person signing in at every await, slow or failing phone
// storage, and photos still being prepared when Save is pressed.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../supabase", () => ({ supabase: {}, supabaseConfigured: true }));
vi.mock("../offline/outbox", () => ({
  MAX_BLOB_BYTES: 25 * 1024 * 1024,
  getPhotoUploadProgress: async () => ({ uploaded: 0, pending: 0, failed: 0, unconfirmed: 1 }),
  enqueueUpload: async () => "unused",
  listFailed: async () => [],
  retryFailed: async () => undefined,
  subscribe: () => () => undefined,
  subscribeSynced: () => () => undefined,
}));

const { useAiDailyLogDraft } = await import("./useAiDailyLogDraft");
const { MemoryDailyLogDraftStore } = await import("./draftStore");
const D = await import("./draft");
type Controller = ReturnType<typeof useAiDailyLogDraft>;
type Outcome = import("./draft").SaveOutcome;
type Payload = import("./draft").SavePayload;
type Draft = import("./draft").AiDailyLogDraft;
type Prepared = Awaited<ReturnType<typeof import("./photos").preparePhoto>>;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ANA = { userId: "00000000-0000-4000-8000-000000000001", email: "ana@example.test", displayName: "Ana" };
const BEN = { userId: "00000000-0000-4000-8000-000000000002", email: "ben@example.test", displayName: "Ben" };
const JOB = { projectId: "00000000-0000-4000-8000-000000000090", label: "SMITH · Smith Residence" };
const JOB2 = { projectId: "00000000-0000-4000-8000-000000000091", label: "SMYTHE · Smythe Ranch" };

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}
const receiptFor = (p: Payload, status: "saved" | "already_saved" = "saved"): Outcome => ({
  kind: "receipt",
  receipt: {
    status, contribution_id: p.id, log_id: "log-1", project_id: p.projectId, log_date: p.logDate, actor_id: p.actorId,
    actor_name: "Ana", base_revision: p.expectedRevision, saved_revision: p.expectedRevision + 1, created_log: p.expectedRevision === 0,
    saved_at: "2026-09-22T20:00:00Z", photo_ids: p.photoIds, log: null,
  },
});

/** A phone whose storage can be held (slow IndexedDB) or made to fail. */
class GatedStore extends MemoryDailyLogDraftStore {
  gate: ReturnType<typeof deferred<void>> | null = null;
  clearGate: ReturnType<typeof deferred<void>> | null = null;
  failSaves = false;
  /** When set, every clear waits on its own gate, in call order. */
  clearQueue: ReturnType<typeof deferred<void>>[] | null = null;
  async clear(userId: string, draftId: string) {
    if (this.clearGate) await this.clearGate.promise;
    if (this.clearQueue) { const g = deferred<void>(); this.clearQueue.push(g); await g.promise; }
    return super.clear(userId, draftId);
  }
  saves: Draft[] = [];
  async save(d: Draft) {
    if (this.gate) await this.gate.promise;
    if (this.failSaves) throw new Error("QuotaExceededError");
    this.saves.push(d);
    return super.save(d);
  }
}

let root: Root;
let host: HTMLElement;
let ctl: Controller;
let store: GatedStore;
let sends: Payload[];
let replies: ReturnType<typeof deferred<Outcome>>[];
let enqueued: { clientId?: string; createdBy?: string | null; projectId?: string | null }[];
let photoN = 0;
/** Who the auth session says is signed in — separate from what the screen shows. */
let authUser: string | null;
let prepareGates: ReturnType<typeof deferred<void>>[];
let holdPrepare = false;

function makeDeps(over: Record<string, unknown> = {}) {
  return {
    store,
    send: vi.fn(async (p: Payload) => { sends.push(p); const d = deferred<Outcome>(); replies.push(d); return d.promise; }),
    readLog: vi.fn(async (_projectId: string, _date: string) => null),
    readPhotos: vi.fn(async () => []),
    enqueueUpload: vi.fn(async (i: { clientId?: string; createdBy?: string | null; projectId?: string | null }) => { enqueued.push(i); return i.clientId ?? ""; }),
    prepare: vi.fn(async (file: File): Promise<Prepared> => {
      if (holdPrepare) { const g = deferred<void>(); prepareGates.push(g); await g.promise; }
      if (!file.type.startsWith("image/")) return { ok: false, name: file.name, reason: "not_image" };
      if (file.name.includes("huge")) return { ok: false, name: file.name, reason: "too_large" };
      const id = `00000000-0000-4000-8000-${String(++photoN).padStart(12, "0")}`;
      return { ok: true, blob: file, photo: { id, caption: null, takenAt: "2026-09-22T15:00:00Z", lat: null, lng: null, accuracyM: null, bytes: file.size } };
    }),
    queueView: vi.fn(async () => ({ view: "none" as const })),
    retryUpload: vi.fn(async () => undefined),
    onQueueChange: () => () => undefined,
    authUserId: async () => authUser,
    today: () => "2026-09-23",
    online: () => true,
    ...over,
  };
}
let deps: ReturnType<typeof makeDeps>;

function Harness({ actor }: { actor: typeof ANA | null }) {
  ctl = useAiDailyLogDraft(actor, deps);
  return null;
}
/** Sign in on the phone: the screen and the auth session both change. */
async function signIn(actor: typeof ANA | null) {
  authUser = actor?.userId ?? null;
  await act(async () => { root.render(<Harness actor={actor} />); });
  await flush();
}
async function flush() { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); }
async function readyDraft() {
  await act(async () => { await ctl.start(); });
  await act(async () => { ctl.chooseJob(JOB); });
  await flush(); // reads the shared log (none yet)
  await act(async () => { ctl.editAnswer("work_completed", "Set 6 frames"); });
}
const jpg = (name: string) => new File([name], name, { type: "image/jpeg" });

beforeEach(() => {
  store = new GatedStore();
  sends = [];
  replies = [];
  enqueued = [];
  prepareGates = [];
  holdPrepare = false;
  deps = makeDeps();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("saving a daily log entry", () => {
  it("a double tap sends once; a lost response is resent unchanged and saves once; photos queue once", async () => {
    await signIn(ANA);
    await readyDraft();
    await act(async () => { await ctl.attachFiles([jpg("a.jpg"), jpg("b.jpg")]); });
    expect(ctl.draft?.photos.map((p) => p.destination?.projectId)).toEqual([JOB.projectId, JOB.projectId]);

    let first!: Promise<void>, second!: Promise<void>;
    await act(async () => { first = ctl.save(); second = ctl.save(); });
    await flush();
    expect(sends).toHaveLength(1);
    expect(sends[0].actorId).toBe(ANA.userId);
    expect((await store.load(ANA.userId))?.pending?.payload).toEqual(sends[0]);

    await act(async () => { replies[0].resolve({ kind: "uncertain" }); await first; await second; });
    expect(ctl.draft?.notice).toEqual({ kind: "uncertain" });
    expect(enqueued).toHaveLength(0);

    await act(async () => { ctl.editAnswer("people", "Late edit"); });
    await act(async () => { first = ctl.save(); });
    await flush();
    expect(sends[1]).toEqual(sends[0]);
    await act(async () => { replies[1].resolve(receiptFor(sends[1], "already_saved")); await first; });
    await flush();
    expect(ctl.draft?.receipt?.status).toBe("already_saved");
    expect(enqueued.map((e) => [e.clientId, e.projectId, e.createdBy])).toEqual(sends[0].photoIds.map((id) => [id, JOB.projectId, ANA.email]));
    await act(async () => { await ctl.save(); });
    expect(sends).toHaveLength(2);
    expect(enqueued).toHaveLength(2);
  });

  it("a reload mid-save resends the frozen words, not a newer draft", async () => {
    await signIn(ANA);
    await readyDraft();
    await act(async () => { void ctl.save(); });
    await flush();
    const frozen = sends[0];
    act(() => root.unmount());
    root = createRoot(host);
    deps = makeDeps();
    await signIn(ANA);
    expect(ctl.draft?.pending?.payload).toEqual(frozen);
    await act(async () => { void ctl.save(); });
    await flush();
    expect(sends[1]).toEqual(frozen);
  });

  it("stale: nothing saved, the other person's words are shown, and Save goes again against them", async () => {
    await signIn(ANA);
    await readyDraft();
    let saving!: Promise<void>;
    await act(async () => { saving = ctl.save(); });
    await flush();
    const current = { id: "log-1", revision: 2, notes: "Added by Ben with Forge AI:\nFlashing", headline: null, day_flow: null, weather: null, reflection: null, filed_by: BEN.userId, filed_by_name: "Ben", updated_at: null };
    await act(async () => { replies[0].resolve({ kind: "stale", revision: 2, current }); await saving; });
    expect(ctl.draft?.pending).toBeNull();
    expect(ctl.draft?.base?.log?.notes).toContain("Flashing");
    await act(async () => { saving = ctl.save(); });
    await flush();
    expect(sends[1]).toMatchObject({ id: sends[0].id, expectedRevision: 2 });
  });
});

describe("who pressed Save", () => {
  it("storage slow BEFORE the request, then another person signs in: A's words are never sent as B", async () => {
    await signIn(ANA);
    await readyDraft();
    await flush();
    store.gate = deferred<void>();
    let saving!: Promise<void>;
    await act(async () => { saving = ctl.save(); });
    // The frozen draft is still being written when Ben signs in.
    await signIn(BEN);
    await act(async () => { store.gate!.resolve(); store.gate = null; await saving; });
    await flush();
    expect(sends).toHaveLength(0);
    // Kept for Ana, frozen, to be resent by her.
    const anas = await store.load(ANA.userId);
    expect(anas?.pending?.payload.actorId).toBe(ANA.userId);
    expect(ctl.draft).toBeNull();

    await signIn(ANA);
    expect(ctl.draft?.pending).not.toBeNull();
    let again!: Promise<void>;
    await act(async () => { again = ctl.save(); });
    await flush();
    expect(sends).toHaveLength(1);
    expect(sends[0].actorId).toBe(ANA.userId);
    await act(async () => { replies[0].resolve(receiptFor(sends[0])); await again; });
  });

  it("the screen shows A but the auth session is B: not sent, and the person is told", async () => {
    await signIn(ANA);
    await readyDraft();
    authUser = BEN.userId; // a token refresh landed for another account
    await act(async () => { await ctl.save(); });
    expect(sends).toHaveLength(0);
    expect(ctl.blockedByAccount).toBe(true);
    expect(ctl.draft?.pending?.payload.actorId).toBe(ANA.userId);
  });

  it("a save that finishes after a switch lands on its own account only, and its photos wait for their taker", async () => {
    await signIn(ANA);
    await readyDraft();
    await act(async () => { await ctl.attachFiles([jpg("a.jpg")]); });
    let saving!: Promise<void>;
    await act(async () => { saving = ctl.save(); });
    await flush();
    expect(sends).toHaveLength(1);

    await signIn(BEN);
    await act(async () => { await ctl.start(); });
    const bensDraft = ctl.draft!;
    await act(async () => { replies[0].resolve(receiptFor(sends[0])); await saving; });
    await flush();
    expect(ctl.draft?.id).toBe(bensDraft.id);
    expect(ctl.draft?.receipt).toBeNull();
    expect(enqueued).toHaveLength(0);
    expect((await store.load(ANA.userId))?.receipt?.contribution_id).toBe(sends[0].id);

    await act(async () => { ctl.applyModelReply({ draftId: sends[0].id, userId: ANA.userId, toolInput: { work_completed: "Ana's words" }, requestId: "r1", conversationId: "c1" }); });
    expect(ctl.draft?.answers.work_completed).toBeUndefined();

    await signIn(ANA);
    await flush();
    expect(enqueued.map((e) => [e.clientId, e.createdBy])).toEqual([[sends[0].photoIds[0], ANA.email]]);
  });
});

describe("the phone's own storage", () => {
  it("words typed while a slow write is out are never replaced by an older result", async () => {
    await signIn(ANA);
    await act(async () => { await ctl.start(); });
    // Choosing the job starts the shared-log read; it stays out for a while.
    let readDone!: (v: null) => void;
    deps.readLog.mockImplementationOnce(() => new Promise((r) => { readDone = r; }));
    await act(async () => { ctl.chooseJob(JOB); });
    await flush();
    expect(deps.readLog).toHaveBeenCalledTimes(1);
    store.gate = deferred<void>();
    await act(async () => { ctl.editAnswer("work_completed", "Set "); });
    await act(async () => { ctl.editAnswer("work_completed", "Set six"); });
    // The shared-log read comes back in the middle of typing.
    await act(async () => { readDone?.(null); });
    await act(async () => { ctl.editAnswer("work_completed", "Set six frames"); });
    await act(async () => { store.gate!.resolve(); store.gate = null; });
    await flush();
    expect(ctl.draft?.answers.work_completed).toMatchObject({ value: "Set six frames" });
    expect(ctl.draft?.base).not.toBeNull();
    expect((await store.load(ANA.userId))?.answers.work_completed).toMatchObject({ value: "Set six frames" });
    // Writes landed in order: the last one kept is the newest.
    expect(store.saves.at(-1)?.answers.work_completed).toMatchObject({ value: "Set six frames" });
  });

  it("a write the phone could not keep is shown, and cleared once one succeeds", async () => {
    await signIn(ANA);
    await readyDraft();
    store.failSaves = true;
    await act(async () => { ctl.editAnswer("notes", "Only on screen"); });
    await flush();
    expect(ctl.storageError).toBe("QuotaExceededError");
    store.failSaves = false;
    await act(async () => { ctl.editAnswer("notes", "Only on screen, now kept"); });
    await flush();
    expect(ctl.storageError).toBeNull();
    expect((await store.load(ANA.userId))?.answers.notes).toMatchObject({ value: "Only on screen, now kept" });
  });
});

describe("photos being prepared", () => {
  it("Save waits for a photo still being stamped, and the photo is in the entry", async () => {
    await signIn(ANA);
    await readyDraft();
    holdPrepare = true;
    let attaching!: Promise<void>;
    await act(async () => { attaching = ctl.attachFiles([jpg("slow.jpg")]); });
    await flush();
    expect(ctl.preparingPhotos).toBe(1);
    await act(async () => { await ctl.save(); });
    expect(sends).toHaveLength(0);
    expect(ctl.draft?.pending).toBeNull();
    await act(async () => { prepareGates[0].resolve(); await attaching; });
    await flush();
    expect(ctl.preparingPhotos).toBe(0);
    expect(ctl.draft?.photos).toHaveLength(1);
    await act(async () => { void ctl.save(); });
    await flush();
    expect(sends[0].photoIds).toEqual([ctl.draft!.photos[0].id]);
  });

  it("a job change while a photo is prepared does not reroute it: it keeps the job it was picked for", async () => {
    await signIn(ANA);
    await readyDraft();
    holdPrepare = true;
    let attaching!: Promise<void>;
    await act(async () => { attaching = ctl.attachFiles([jpg("east-wall.jpg")]); });
    await act(async () => { ctl.chooseJob(JOB2); });
    await act(async () => { prepareGates[0].resolve(); await attaching; });
    await flush();
    expect(ctl.draft?.job?.projectId).toBe(JOB2.projectId);
    expect(ctl.draft?.photos[0].destination).toEqual(JOB);
    expect(D.saveProblems(ctl.draft!, "2026-09-23")).toContainEqual({ kind: "photo_other_job", photoId: ctl.draft!.photos[0].id, destination: JOB });
  });

  it("an account switch while a photo is prepared keeps it with its owner's draft, never the next person's", async () => {
    await signIn(ANA);
    await readyDraft();
    const anasDraft = ctl.draft!.id;
    holdPrepare = true;
    let attaching!: Promise<void>;
    await act(async () => { attaching = ctl.attachFiles([jpg("a.jpg")]); });
    await signIn(BEN);
    await act(async () => { await ctl.start(); });
    await act(async () => { prepareGates[0].resolve(); await attaching; });
    await flush();
    expect(ctl.draft?.photos).toEqual([]);
    const anas = await store.load(ANA.userId);
    expect(anas?.id).toBe(anasDraft);
    expect(anas?.photos.map((p) => p.destination)).toEqual([JOB]);
    expect(await store.getPhoto(BEN.userId, anas!.photos[0].id)).toBeNull();
    expect(await store.getPhoto(ANA.userId, anas!.photos[0].id)).not.toBeNull();
  });
});

describe("photos that cannot be kept", () => {
  it("a PDF, an oversized picture and a full phone are reported; the draft keeps everything else", async () => {
    await signIn(ANA);
    await readyDraft();
    await act(async () => { await ctl.attachFiles([new File(["%PDF"], "slip.pdf", { type: "application/pdf" }), jpg("huge.jpg"), jpg("ok.jpg")]); });
    expect(ctl.rejectedPhotos).toEqual([{ name: "slip.pdf", reason: "not_image" }, { name: "huge.jpg", reason: "too_large" }]);
    expect(ctl.draft?.photos).toHaveLength(1);
    store.putPhoto = async () => { throw new Error("QuotaExceededError"); };
    await act(async () => { await ctl.attachFiles([jpg("later.jpg")]); });
    expect(ctl.rejectedPhotos).toEqual([{ name: "later.jpg", reason: "not_kept" }]);
    expect(ctl.draft?.photos).toHaveLength(1);
  });

  it("saved log + a photo the queue refused: Start another entry is refused until retried or explicitly discarded", async () => {
    let refuse = true;
    deps = makeDeps({
      enqueueUpload: vi.fn(async (i: { clientId?: string; createdBy?: string | null }) => {
        if (refuse) throw new Error("Couldn't save this offline (storage may be full)");
        enqueued.push(i);
        return i.clientId ?? "";
      }),
    });
    await signIn(ANA);
    await readyDraft();
    await act(async () => { await ctl.attachFiles([jpg("a.jpg")]); });
    const photoId = ctl.draft!.photos[0].id;
    let saving!: Promise<void>;
    await act(async () => { saving = ctl.save(); });
    await flush();
    await act(async () => { replies[0].resolve(receiptFor(sends[0])); await saving; });
    await flush();
    expect(ctl.queueFailures).toHaveLength(1);

    let result!: Awaited<ReturnType<Controller["startOver"]>>;
    await act(async () => { result = await ctl.startOver(); });
    expect(result).toEqual({ done: false, reason: "unsent_photos", unsent: 1 });
    expect(ctl.draft?.receipt).not.toBeNull();
    expect(await store.getPhoto(ANA.userId, photoId)).not.toBeNull();
    // Even start() (a new "build my daily log") keeps the saved entry while it holds photos.
    await act(async () => { await ctl.start(); });
    expect(ctl.draft?.receipt).not.toBeNull();

    refuse = false;
    await act(async () => { await ctl.retryPhoto(photoId); });
    expect(enqueued.map((e) => e.clientId)).toEqual([photoId]);
    await act(async () => { result = await ctl.startOver(); });
    expect(result).toEqual({ done: true });
    expect(ctl.draft?.receipt).toBeNull();
  });

  it("the explicit discard is the only way past unsent photos", async () => {
    deps = makeDeps({ enqueueUpload: vi.fn(async () => { throw new Error("full"); }) });
    await signIn(ANA);
    await readyDraft();
    await act(async () => { await ctl.attachFiles([jpg("a.jpg")]); });
    const photoId = ctl.draft!.photos[0].id;
    let saving!: Promise<void>;
    await act(async () => { saving = ctl.save(); });
    await flush();
    await act(async () => { replies[0].resolve(receiptFor(sends[0])); await saving; });
    await flush();
    let result!: Awaited<ReturnType<Controller["startOver"]>>;
    await act(async () => { result = await ctl.startOver({ discardUnsent: true }); });
    expect(result).toEqual({ done: true });
    expect(await store.getPhoto(ANA.userId, photoId)).toBeNull();
  });
});

describe("the work date and the first message", () => {
  it("changing the date re-reads that day's shared log and saves against it", async () => {
    await signIn(ANA);
    await readyDraft();
    deps.readLog.mockResolvedValueOnce({ id: "l", revision: 3, notes: "Earlier day", headline: null, day_flow: null, weather: null, reflection: null, filed_by: BEN.userId, filed_by_name: "Ben", updated_at: null } as never);
    await act(async () => { ctl.setLogDate("2026-09-20"); });
    await flush();
    expect(deps.readLog).toHaveBeenLastCalledWith(JOB.projectId, "2026-09-20");
    expect(ctl.draft?.base?.revision).toBe(3);
    await act(async () => { ctl.setLogDate("2026-09-30"); });
    expect(ctl.draft?.logDate).toBe("2026-09-20");
    await act(async () => { void ctl.save(); });
    await flush();
    expect(sends[0]).toMatchObject({ logDate: "2026-09-20", expectedRevision: 3 });
  });

  it("start() returns the fresh draft, even before the rendered value has caught up", async () => {
    await signIn(ANA);
    let started: Draft | null = null;
    await act(async () => { started = await ctl.start(); });
    expect(started).not.toBeNull();
    expect(started!.userId).toBe(ANA.userId);
    expect(ctl.snapshot()?.id).toBe(started!.id);
  });
});

describe("recovery (final review)", () => {
  it("a frozen entry the phone could not keep is NOT sent; once storage works, Save sends exactly it", async () => {
    await signIn(ANA);
    await readyDraft();
    await flush();
    store.failSaves = true;
    await act(async () => { await ctl.save(); });
    await flush();
    expect(sends).toHaveLength(0);
    expect(ctl.storageError).toBe("QuotaExceededError");
    const frozen = ctl.draft!.pending!.payload;
    store.failSaves = false;
    await act(async () => { void ctl.save(); });
    await flush();
    expect(sends).toHaveLength(1);
    expect(sends[0]).toEqual(frozen);
    expect((await store.load(ANA.userId))?.pending?.payload).toEqual(frozen);
    expect(ctl.storageError).toBeNull();
  });

  it("start(): a slow clear of a finished entry, then another sign-in — nothing of Ana's appears on Ben's screen", async () => {
    const finished = { ...D.newDraft(ANA.userId, "2026-09-22", "00000000-0000-4000-8000-00000000f001"), receipt: (receiptFor({
      id: "00000000-0000-4000-8000-00000000f001", actorId: ANA.userId, projectId: JOB.projectId, logDate: "2026-09-22", expectedRevision: 0,
      answers: {}, body: "x", photoIds: [], sourceRequestIds: [] }) as Extract<Outcome, { kind: "receipt" }>).receipt };
    await store.save(finished);
    await signIn(ANA);
    expect(ctl.draft?.receipt).not.toBeNull();
    store.clearGate = deferred<void>();
    let started!: Promise<Draft | null>;
    await act(async () => { started = ctl.start(); });
    await signIn(BEN);
    await act(async () => { store.clearGate!.resolve(); store.clearGate = null; });
    let result: Draft | null = null;
    await act(async () => { result = await started; });
    await flush();
    expect(result).toBeNull();
    expect(ctl.draft?.userId ?? BEN.userId).toBe(BEN.userId);
    expect(ctl.draft).toBeNull();
  });

  it("start() twice at once over a finished entry opens ONE new draft; the second call does not close the first", async () => {
    const finished = { ...D.newDraft(ANA.userId, "2026-09-22", "00000000-0000-4000-8000-00000000f002"), receipt: (receiptFor({
      id: "00000000-0000-4000-8000-00000000f002", actorId: ANA.userId, projectId: JOB.projectId, logDate: "2026-09-22", expectedRevision: 0,
      answers: {}, body: "x", photoIds: [], sourceRequestIds: [] }) as Extract<Outcome, { kind: "receipt" }>).receipt };
    await store.save(finished);
    await signIn(ANA);
    expect(ctl.draft?.receipt).not.toBeNull();
    // Each clear is slow and finishes on its own: the first call completes (its
    // draft may already be in a sent request) before the second one resumes.
    store.clearQueue = [];
    let a!: Promise<Draft | null>, b!: Promise<Draft | null>;
    await act(async () => { a = ctl.start(); b = ctl.start(); });
    await flush();
    let first: Draft | null = null;
    await act(async () => { store.clearQueue![0].resolve(); first = await a; });
    await act(async () => { store.clearQueue![1]?.resolve(); });
    let second: Draft | null = null;
    await act(async () => { second = await b; });
    await flush();
    const ids = [(first as Draft | null)?.id, (second as Draft | null)?.id];
    // The draft the first caller got is still the one open.
    expect(ctl.draft?.id).toBe((first as Draft | null)?.id);
    expect(ids[0]).not.toBe("00000000-0000-4000-8000-00000000f002");
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBe(ids[0]);
    expect(ctl.draft?.id).toBe(ids[0]);
    expect((await store.load(ANA.userId))?.id).toBe(ids[0]);
  });

  it("startOver(): a slow clear, then another sign-in — refused, not shown to the next person", async () => {
    await signIn(ANA);
    await readyDraft();
    store.clearGate = deferred<void>();
    let over!: Promise<Awaited<ReturnType<Controller["startOver"]>>>;
    await act(async () => { over = ctl.startOver(); });
    await signIn(BEN);
    await act(async () => { store.clearGate!.resolve(); store.clearGate = null; });
    let result!: Awaited<ReturnType<Controller["startOver"]>>;
    await act(async () => { result = await over; });
    expect(result).toEqual({ done: false, reason: "account_changed", unsent: 0 });
    expect(ctl.draft).toBeNull();
    expect(await store.load(BEN.userId)).toBeNull();
  });

  it("a photo kept but its listing not stored: shown, the error says so, bytes kept — and listed again after a reload", async () => {
    await signIn(ANA);
    await readyDraft();
    await flush();
    store.failSaves = true;
    await act(async () => { await ctl.attachFiles([jpg("kept.jpg")]); });
    await flush();
    const photoId = ctl.draft!.photos[0].id;
    expect(ctl.storageError).toBe("QuotaExceededError");
    expect(ctl.rejectedPhotos).toEqual([]);
    expect(await store.getPhoto(ANA.userId, photoId)).not.toBeNull();
    expect((await store.load(ANA.userId))?.photos).toEqual([]);
    // The page is reloaded before storage recovers.
    store.failSaves = false;
    act(() => root.unmount());
    root = createRoot(host);
    deps = makeDeps();
    await signIn(ANA);
    await flush();
    expect(ctl.draft?.photos.map((p) => [p.id, p.destination])).toEqual([[photoId, null]]);
    expect(D.saveProblems(ctl.draft!, "2026-09-23")).toContainEqual({ kind: "photo_without_job", photoId });
    expect((await store.load(ANA.userId))?.photos.map((p) => p.id)).toEqual([photoId]);
  });

  it("\"Try keeping it on this phone again\" stores what is on screen once storage works", async () => {
    await signIn(ANA);
    await readyDraft();
    store.failSaves = true;
    await act(async () => { await ctl.attachFiles([jpg("kept.jpg")]); });
    await flush();
    store.failSaves = false;
    let kept = false;
    await act(async () => { kept = await ctl.retryStorage(); });
    expect(kept).toBe(true);
    expect(ctl.storageError).toBeNull();
    expect((await store.load(ANA.userId))?.photos).toHaveLength(1);
  });

  it("one file that throws while being prepared is refused; the next is added and Save is not blocked forever", async () => {
    let calls = 0;
    const real = deps.prepare;
    deps = makeDeps({ prepare: vi.fn(async (file: File) => { if (++calls === 1) throw new Error("decoder crashed"); return real(file); }) });
    await signIn(ANA);
    await readyDraft();
    await act(async () => { await ctl.attachFiles([jpg("broken.jpg"), jpg("fine.jpg")]); });
    await flush();
    expect(ctl.preparingPhotos).toBe(0);
    expect(ctl.rejectedPhotos).toEqual([{ name: "broken.jpg", reason: "unreadable" }]);
    expect(ctl.draft?.photos).toHaveLength(1);
    await act(async () => { void ctl.save(); });
    await flush();
    expect(sends).toHaveLength(1);
  });

  it("a handed-over photo the queue no longer has and the server never got is sent again under the same id", async () => {
    await signIn(ANA);
    await readyDraft();
    await act(async () => { await ctl.attachFiles([jpg("a.jpg")]); });
    const photoId = ctl.draft!.photos[0].id;
    let saving!: Promise<void>;
    await act(async () => { saving = ctl.save(); });
    await flush();
    await act(async () => { replies[0].resolve(receiptFor(sends[0])); await saving; });
    await flush();
    expect(enqueued.map((e) => e.clientId)).toEqual([photoId]);
    // Discarded from Stuck writes: not queued, and the server does not have it.
    deps.readPhotos.mockResolvedValue([{ photo_id: photoId, arrived: false, attachment_id: null, storage_path: null }] as never);
    await act(async () => { await ctl.refreshPhotos(); });
    expect(ctl.photoViews[0].state).toBe("checking");
    await act(async () => { await ctl.retryPhoto(photoId); });
    await flush();
    expect(enqueued.map((e) => e.clientId)).toEqual([photoId, photoId]);
    // If the server DOES have it, nothing is sent again.
    deps.readPhotos.mockResolvedValue([{ photo_id: photoId, arrived: true, attachment_id: "a", storage_path: "s" }] as never);
    await act(async () => { await ctl.retryPhoto(photoId); });
    expect(enqueued).toHaveLength(2);
  });
});
