// Whose work goes out under whose name (2026-09-25, Codex review of #654,
// finding 3).
//
// A queues a clock-in with no signal, signs out, and B signs in on the same
// phone. The drain used to send A's punch the moment it could — and the
// shared client puts whoever is signed in NOW on every request, so the
// request carried B's token with A's punch id and tap time. clock_in files
// the shift for auth.uid(): A's morning became B's shift.
//
// These run the real outbox runtime on its in-memory store with the server
// stubbed. The stub's shared client does what supabase-js does — each request
// carries the session that is current when it goes out — and the bound client
// the fix sends through records the one token it was built with, so a test can
// read exactly which person every write went out as.

import { beforeEach, describe, expect, it, vi } from "vitest";

interface FakeSession {
  access_token: string;
  user: { id: string; email: string };
}
const A: FakeSession = { access_token: "token-A", user: { id: "aaaaaaaa-0000-4000-8000-00000000000a", email: "a@example.test" } };
const B: FakeSession = { access_token: "token-B", user: { id: "bbbbbbbb-0000-4000-8000-00000000000b", email: "b@example.test" } };

/** The auth client's current session — what a sign-out / sign-in changes. */
let current: FakeSession | null = A;
/** Every request that reached the "server": which op, as whom. */
const sent: { fn: string; token: string | null; args: Record<string, unknown> }[] = [];
/** Lets a test run something in the middle of a request, before it goes out. */
let beforeRequest: (() => Promise<void>) | null = null;

function clientSendingAs(token: () => string | null) {
  const request = async (fn: string, args: Record<string, unknown>) => {
    if (beforeRequest) {
      const hook = beforeRequest;
      beforeRequest = null;
      await hook();
    }
    sent.push({ fn, token: token(), args });
    return { data: { id: `shift-for-${token()}` }, error: null };
  };
  return {
    rpc: (fn: string, args: Record<string, unknown>) => request(fn, args),
    functions: {
      invoke: (fn: string, opts: { body: unknown }) => request(`function:${fn}`, { body: opts.body }),
    },
    from: (table: string) => ({
      upsert: (row: Record<string, unknown>) => request(`upsert:${table}`, row),
      insert: (row: Record<string, unknown>) => request(`insert:${table}`, row),
      // The memo path reads back the id of the row it just filed.
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { id: `attachment-in-${table}` }, error: null }) }),
      }),
    }),
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string) => {
          await request(`upload:${bucket}`, { path });
          return { data: {}, error: null };
        },
      }),
    },
    auth: {
      getSession: async () => ({ data: { session: current }, error: null }),
      getUser: async () => ({ data: { user: current?.user ?? null }, error: null }),
    },
  };
}

vi.mock("../supabase", () => ({
  // The shared client: the token on a request is whoever is signed in at the
  // moment it is sent — supabase-js's fetchWithAuth asks auth every time.
  supabase: clientSendingAs(() => current?.access_token ?? null),
  // A client that only ever sends the one token it was made with — and, like
  // the real one (supabase-js with `accessToken`), has no auth to ask.
  clientWithToken: (token: string) => ({
    ...clientSendingAs(() => token),
    auth: new Proxy({}, {
      get: (_t, prop) => {
        throw new Error(`a client built with accessToken has no auth.${String(prop)}`);
      },
    }),
  }),
  supabaseConfigured: true,
}));

let signedIn: FakeSession | null = A;
vi.mock("../signedIn", () => ({
  signedInEmail: () => signedIn?.user.email ?? null,
  signedInUserId: () => signedIn?.user.id ?? null,
  rememberSignedIn: () => {},
  subscribeSignedIn: () => () => {},
}));
vi.mock("./telemetry", () => ({ logOfflineEvent: () => {} }));
/** Run while a memo's audio is prepared for transcription (Codex's P2 hook). */
let duringSpeechAudio: (() => void) | null = null;
vi.mock("../voiceAudio", () => ({
  speechAudio: async (blob: Blob) => {
    duringSpeechAudio?.();
    return blob;
  },
}));

const outbox = await import("./outbox");

const PUNCH = (clientId: string) => ({
  clientId,
  tappedAt: "2026-09-25T13:02:11.000Z",
  clockCheckedAt: null,
  clockSkewMs: null,
});

function setOnline(value: boolean) {
  Object.defineProperty(navigator, "onLine", { value, configurable: true });
}
/** Sign out and sign in as somebody else (or nobody), the way the phone would. */
function switchTo(who: FakeSession | null) {
  current = who;
  signedIn = who;
}

async function clearQueue() {
  // listAll arrived with this fix; before it there is nothing to clear between
  // tests but the first, which starts on an empty store anyway.
  const list = (outbox as { listAll?: () => Promise<{ id: string }[]> }).listAll;
  if (!list) return;
  for (const e of await list()) await outbox.discardFailed(e.id);
}

beforeEach(async () => {
  setOnline(false);
  switchTo(A);
  await clearQueue();
  sent.length = 0;
  beforeRequest = null;
  duringSpeechAudio = null;
});

describe("a queued write goes out only as the person who saved it", () => {
  it("A's queued clock-in is not sent as B after A signs out and B signs in — it waits, untouched", async () => {
    await outbox.enqueueClockIn({ projectId: "p1", costCodeId: "cc1", punch: PUNCH("punch-A") });
    switchTo(B);
    setOnline(true);
    await outbox.drain();

    // Nothing of A's left the phone — not as B, not as anybody.
    expect(sent.filter((s) => s.fn === "clock_in")).toEqual([]);
    const [entry] = await outbox.listAll();
    expect(entry).toMatchObject({ op: "clock_in", status: "queued", attemptCount: 0, lastError: null });
    expect(entry.ownerId).toBe(A.user.id);
    // It is shown as someone else's, and not as B's own pending work.
    expect(outbox.getHeldCount()).toBe(1);
    expect(outbox.getCounts().clock).toBe(0);
  });

  it("B's own clock-in goes out as B while A's waits", async () => {
    await outbox.enqueueClockIn({ projectId: "p1", costCodeId: "cc1", punch: PUNCH("punch-A") });
    switchTo(B);
    await outbox.enqueueClockIn({ projectId: "p2", costCodeId: "cc1", punch: PUNCH("punch-B") });
    setOnline(true);
    await outbox.drain();

    const ins = sent.filter((s) => s.fn === "clock_in");
    expect(ins).toHaveLength(1);
    expect(ins[0]).toMatchObject({ token: "token-B", args: { p_client_id: "punch-B" } });
    expect((await outbox.listAll()).map((e) => e.payload.clientId)).toEqual(["punch-A"]);
  });

  it("A → signed out → A again: A's clock-in goes out, as A", async () => {
    await outbox.enqueueClockIn({ projectId: "p1", costCodeId: "cc1", punch: PUNCH("punch-A") });
    switchTo(null);
    setOnline(true);
    await outbox.drain();
    expect(sent).toEqual([]);
    expect(await outbox.listAll()).toHaveLength(1);

    switchTo(A);
    await outbox.drain();
    const ins = sent.filter((s) => s.fn === "clock_in");
    expect(ins).toHaveLength(1);
    expect(ins[0]).toMatchObject({ token: "token-A", args: { p_client_id: "punch-A" } });
    expect(await outbox.listAll()).toEqual([]);
  });

  it("a mixed queue: only the signed-in person's writes go, each as its owner, punches first", async () => {
    const blob = new Blob(["x"], { type: "image/jpeg" });
    await outbox.enqueueUpload({ kind: "photo", path: "job/feed/a.jpg", contentType: "image/jpeg", projectId: "p1", createdBy: A.user.email, blob });
    await outbox.enqueueClockOut({ shiftRef: "shift-A", injured: false, timeConfirmed: true, breakSeconds: 0, punch: PUNCH("out-A") });
    switchTo(B);
    await outbox.enqueueUpload({ kind: "photo", path: "job/feed/b.jpg", contentType: "image/jpeg", projectId: "p1", createdBy: B.user.email, blob });
    setOnline(true);
    await outbox.drain();

    expect(sent.map((s) => [s.fn, s.token])).toEqual([
      ["upload:install-media", "token-B"],
      ["upsert:attachments", "token-B"],
    ]);
    expect(outbox.getHeldCount()).toBe(2);

    sent.length = 0;
    switchTo(A);
    await outbox.drain();
    expect(sent.map((s) => [s.fn, s.token])).toEqual([
      ["clock_out", "token-A"],
      ["upload:install-media", "token-A"],
      ["upsert:attachments", "token-A"],
    ]);
    expect(await outbox.listAll()).toEqual([]);
    expect(outbox.getHeldCount()).toBe(0);
  });

  it("A's held clock-in and the clock-out waiting on it do not hold B up, and both go as A when A is back", async () => {
    // Codex's held/dependent-clock check from the review of #660.
    const ref = await outbox.enqueueClockIn({ projectId: "p1", costCodeId: "cc1", punch: PUNCH("held-A") });
    await outbox.enqueueClockOut({ shiftRef: `pending:${ref}`, injured: false, timeConfirmed: true, breakSeconds: 0, punch: PUNCH("out-held-A") });
    switchTo(B);
    await outbox.enqueueClockIn({ projectId: "p2", costCodeId: "cc1", punch: PUNCH("own-B") });
    setOnline(true);
    await outbox.drain();
    expect(sent.map((s) => [s.fn, s.token])).toEqual([["clock_in", "token-B"]]);
    expect(await outbox.listAll()).toHaveLength(2);
    // B is not shown A's punches as B's own.
    expect(outbox.getClockQueueSnapshot().entries).toEqual([]);

    switchTo(A);
    sent.length = 0;
    await outbox.drain();
    expect(sent.map((s) => [s.fn, s.token])).toEqual([["clock_in", "token-A"], ["clock_out", "token-A"]]);
    // The clock-out lands on the shift A's own clock-in became.
    expect(sent[1].args.p_shift_id).toBe("shift-for-token-A");
  });

  it("the token is fixed when the send starts: a sign-in in the middle of it cannot change whose write it is", async () => {
    await outbox.enqueueClockIn({ projectId: "p1", costCodeId: "cc1", punch: PUNCH("punch-A") });
    setOnline(true);
    // A's send has been checked and is on its way out when B signs in.
    beforeRequest = async () => switchTo(B);
    await outbox.drain();
    const ins = sent.filter((s) => s.fn === "clock_in");
    expect(ins).toHaveLength(1);
    expect(ins[0]).toMatchObject({ token: "token-A", args: { p_client_id: "punch-A" } });
  });

  it("with nobody signed in, nothing is sent and nothing is given up on", async () => {
    await outbox.enqueueClockIn({ projectId: "p1", costCodeId: "cc1", punch: PUNCH("punch-A") });
    switchTo(null);
    setOnline(true);
    for (let i = 0; i < 3; i++) await outbox.drain();
    expect(sent).toEqual([]);
    const [entry] = await outbox.listAll();
    expect(entry).toMatchObject({ status: "queued", attemptCount: 0 });
  });

  it("an older write that names no one is never sent as anyone — not as the person on at launch, nor the next — and can be thrown away", async () => {
    // Codex review of #660, P1 #1: a punch queued by a build from before
    // writes carried their owner. A signed out; B is the first person the new
    // build ever sees. It used to be adopted as B and sent with token-B.
    switchTo(null);
    await outbox.enqueueClockIn({ projectId: "p1", costCodeId: "cc1", punch: PUNCH("legacy-punch-of-A") });
    const [legacy] = await outbox.listAll();
    expect(legacy.ownerId).toBeUndefined();

    setOnline(true);
    for (const who of [B, A, B]) {
      switchTo(who);
      await outbox.drain();
    }
    // Not as B, not as A — the phone cannot know whose it is.
    expect(sent).toEqual([]);
    const [still] = await outbox.listAll();
    expect(still).toMatchObject({ id: legacy.id, status: "queued", attemptCount: 0, lastError: null });
    expect(still.ownerId).toBeUndefined();
    // Shown for what it is — owner unknown — not as anyone's own pending work.
    expect((await outbox.listUnknownOwner()).map((e) => e.id)).toEqual([legacy.id]);
    expect(outbox.getUnknownOwnerCount()).toBe(1);
    expect(outbox.getHeldCount()).toBe(0);
    expect(outbox.getCounts().clock).toBe(0);
    expect(outbox.getClockQueueSnapshot().entries).toEqual([]);

    // The way out is throwing it away, by hand.
    await outbox.discardFailed(legacy.id);
    expect(await outbox.listAll()).toEqual([]);
    expect(outbox.getUnknownOwnerCount()).toBe(0);
  });

  it("install media handed over while someone else is signed in stays its photographer's, never the drainer's", async () => {
    // Codex review of #660, P1 #2, at the hand-off boundary: A's photo,
    // handed to the outbox by the install queue while B is signed in.
    switchTo(B);
    const blob = new Blob(["A photo"], { type: "image/jpeg" });
    await outbox.enqueueUpload({ id: "install-media-of-A", kind: "photo", path: "job/feed/a.jpg", contentType: "image/jpeg", projectId: "p1", installEventId: "install-A", createdBy: A.user.email, blob });
    const [entry] = await outbox.listAll();
    // Not stamped as B: the evidence it carries names A.
    expect(entry.ownerId).toBeUndefined();
    setOnline(true);
    await outbox.drain();
    expect(sent).toEqual([]);
    expect(outbox.getHeldCount()).toBe(1);

    switchTo(A);
    await outbox.drain();
    expect(sent.map((s) => [s.fn, s.token])).toEqual([
      ["upload:install-media", "token-A"],
      ["upsert:attachments", "token-A"],
    ]);
  });

  it("an owner named at hand-off is kept, whoever is signed in", async () => {
    switchTo(B);
    const blob = new Blob(["A photo"], { type: "image/jpeg" });
    await outbox.enqueueUpload({ id: "install-media-2", kind: "photo", path: "job/feed/a2.jpg", contentType: "image/jpeg", projectId: "p1", installEventId: "install-A", createdBy: null, ownerId: A.user.id, blob });
    expect((await outbox.listAll())[0].ownerId).toBe(A.user.id);
    // And "nobody can say" is kept as that, too — never filled in with B.
    await outbox.enqueueUpload({ id: "install-media-3", kind: "photo", path: "job/feed/a3.jpg", contentType: "image/jpeg", projectId: "p1", installEventId: "install-old", createdBy: null, ownerId: null, blob });
    const third = (await outbox.listAll()).find((e) => e.id === "install-media-3")!;
    expect(third.ownerId).toBeUndefined();
    expect((await outbox.listUnknownOwner()).map((e) => e.id)).toEqual(["install-media-3"]);
  });

  it("a voice memo's transcript is asked for as the memo's owner, even if someone else signs in while its audio is prepared", async () => {
    // Codex review of #660, P2 #3: transcription ran on the shared client, so
    // a sign-in during speechAudio sent A's memo to the transcriber as B.
    await outbox.enqueueUpload({ kind: "voice_memo", path: "job/feed/a.webm", contentType: "audio/webm", projectId: "p1", createdBy: A.user.email, blob: new Blob(["memo"], { type: "audio/webm" }) });
    duringSpeechAudio = () => switchTo(B);
    setOnline(true);
    await outbox.drain();
    await vi.waitFor(() => expect(sent.some((s) => s.fn === "function:transcribe-install-memo")).toBe(true));
    expect(sent.map((s) => [s.fn, s.token])).toEqual([
      ["upload:install-media", "token-A"],
      ["upsert:attachments", "token-A"],
      ["function:transcribe-install-memo", "token-A"],
    ]);
  });

  it("an older photo with no owner goes out as the photographer it names, and no one else", async () => {
    const blob = new Blob(["x"], { type: "image/jpeg" });
    switchTo(null);
    await outbox.enqueueUpload({ kind: "photo", path: "job/feed/old.jpg", contentType: "image/jpeg", projectId: "p1", createdBy: B.user.email, blob });
    switchTo(A);
    setOnline(true);
    await outbox.drain();
    expect(sent).toEqual([]);
    expect((await outbox.listAll())[0].ownerId).toBeUndefined();

    switchTo(B);
    await outbox.drain();
    expect(sent.map((s) => [s.fn, s.token])).toEqual([
      ["upload:install-media", "token-B"],
      ["upsert:attachments", "token-B"],
    ]);
  });

  it("someone else's given-up write is not this person's to retry or throw away", async () => {
    await outbox.enqueueClockIn({ projectId: "p1", costCodeId: "cc1", punch: PUNCH("punch-A") });
    const [entry] = await outbox.listAll();
    // A's punch gave up while A was signed in.
    switchTo(A);
    setOnline(true);
    beforeRequest = async () => {
      throw Object.assign(new Error("complete today's toolbox talk before clocking in"), { code: "P0001" });
    };
    await outbox.drain().catch(() => {});
    expect((await outbox.listFailed()).map((e) => e.id)).toEqual([entry.id]);

    switchTo(B);
    expect(await outbox.listFailed()).toEqual([]);
    expect((await outbox.listHeld()).map((e) => e.id)).toEqual([entry.id]);
  });

  it("a Hex-Portal case goes out as the person who wrote it, without asking the bound client who that is", async () => {
    const { saveLearningCase } = await import("../hexPortal");
    await saveLearningCase(
      { actorId: A.user.id, projectId: "p1", unitLabel: "U1", question: "q", answer: "a", sources: [] } as never,
      "case-1",
    );
    switchTo(B);
    setOnline(true);
    await outbox.drain();
    expect(sent).toEqual([]);

    switchTo(A);
    await outbox.drain();
    expect(sent.map((s) => [s.fn, s.token])).toEqual([["hex_portal_save_case", "token-A"]]);
    expect(await outbox.listAll()).toEqual([]);
  });
});
