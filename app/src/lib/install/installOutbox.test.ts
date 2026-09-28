import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKOFF_BASE_MS, BACKOFF_CAP_MS, MAX_ATTEMPTS } from "../offline/outbox-core";
import { rememberSignedIn, signedInEmail, signInMark } from "../signedIn";

// The installer submitting in every test below, unless a test signs in
// somebody else itself (the owner tests at the end do).
beforeEach(() => {
  rememberSignedIn({ user: { id: "installer-1", email: "installer@crew.com" } });
  auth.session = { access_token: "token-installer-1", user: { id: "installer-1", email: "installer@crew.com" } };
  auth.afterRead = null;
});
import {
  applyInstallFailure,
  deserializeInstallOutbox,
  isInstallDue,
  nextInstallStep,
  serializeInstallOutbox,
  stageToAttempt,
  type InstallOutboxRecord,
} from "./installOutbox";

// The network edges of a flush, faked so the queue's own decisions are what
// is under test: the RPC that files the install, the points award, and the
// global outbox the media is handed to.
vi.mock("./api", () => ({ submitInstallEvent: vi.fn() }));
// The session the install queue checks before it sends (2026-09-27), and the
// client it sends through: locked to one token, the way lib/supabase.ts's
// clientWithToken is. `afterRead` runs right after the check reads the
// session — a sign-in landing while the send is being prepared.
const auth = vi.hoisted(() => ({
  session: null as null | { access_token: string; user: { id: string; email: string } },
  afterRead: null as null | (() => void),
}));
vi.mock("../supabase", () => ({
  supabase: {
    auth: {
      getSession: async () => {
        const session = auth.session;
        const after = auth.afterRead;
        auth.afterRead = null;
        after?.();
        return { data: { session }, error: null };
      },
    },
  },
  clientWithToken: (token: string) => ({ boundTo: token }),
  supabaseConfigured: true,
}));
vi.mock("../points", () => ({ awardPoints: vi.fn(async () => {}) }));
const outbox = vi.hoisted(() => ({
  /** Every hand-off the media stage made, in order, across every pass. */
  handedOff: [] as Array<{ id?: string; kind: string; path: string; uncapped?: boolean; ownerId?: string | null }>,
  /** Throw on the hand-off with this path, once — a crash mid-stage. */
  failOnce: null as string | null,
  pendingMedia: 0,
  /**
   * ids sitting in the fake global outbox, still queued/unsent — what
   * listAll() reads back. Every enqueueUpload adds its id here; a test can
   * add a stray id itself to stand in for another install's own media, still
   * uploading, that this one's receipt must not count.
   */
  queuedIds: new Set<string>(),
}));
vi.mock("../offline/outbox", () => ({
  enqueueUpload: vi.fn(async (input: { id?: string; kind: string; path: string; uncapped?: boolean; ownerId?: string | null }) => {
    if (outbox.failOnce === input.path) {
      outbox.failOnce = null;
      throw new Error("Couldn't save this offline (storage may be full)");
    }
    outbox.handedOff.push({ id: input.id, kind: input.kind, path: input.path, uncapped: input.uncapped, ownerId: input.ownerId });
    const id = input.id ?? "minted";
    outbox.queuedIds.add(id);
    return id;
  }),
  drain: vi.fn(async () => {}),
  pendingMediaCount: vi.fn(async () => outbox.pendingMedia),
  listAll: vi.fn(async () =>
    [...outbox.queuedIds].map((id) => ({ id, op: "photo_upload", status: "queued" })),
  ),
}));
const RECORD: InstallOutboxRecord = {
  id: "outbox-1",
  step: "queued",
  installEventId: null,
  // A queued install now carries its own retry state, so a permanently broken
  // one can stop and be seen instead of retrying every 30 seconds forever.
  attemptCount: 0,
  // …and its own next-attempt time, so a flaky morning spaces its tries out
  // instead of spending all eight of them inside four minutes.
  nextAttemptAt: 0,
  lastError: null,
  status: "pending",
  payload: {
    clientKey: "client-key-1",
    openingId: "opening-1",
    projectId: "project-1",
    openingCode: "W1",
    assignedWindowId: "window-1",
    createdBy: "installer@crew.com",
    submitParams: {
      openingId: "opening-1",
      minutes: 12,
      qualityGrade: 4,
      estimateMinutes: 15,
      startedAt: "2026-07-18T12:00:00.000Z",
    },
    points: {
      profileId: "profile-1",
      entries: [{ kind: "install", points: 20 }],
      ref: "opening-1",
      status: "pending",
    },
    media: [
      {
        bucket: "install-media",
        path: "project-1/W1/memo.webm",
        contentType: "audio/webm",
        kind: "voice_memo",
      },
    ],
    createdAt: "2026-07-18T12:00:00.000Z",
  },
};

describe("install outbox state machine", () => {
  it("advances queued → rpc → points → media → complete", () => {
    expect(nextInstallStep("queued")).toBe("rpc_done");
    expect(nextInstallStep("rpc_done")).toBe("points_done");
    expect(nextInstallStep("points_done")).toBe("media_done");
    expect(nextInstallStep("media_done")).toBe("complete");
  });

  it("maps each step to exactly one network stage", () => {
    expect(stageToAttempt("queued")).toBe("rpc");
    expect(stageToAttempt("rpc_done")).toBe("points");
    expect(stageToAttempt("points_done")).toBe("media");
    expect(stageToAttempt("media_done")).toBeNull();
  });

  it("round-trips a full outbox record", () => {
    expect(deserializeInstallOutbox(serializeInstallOutbox(RECORD))).toEqual(
      RECORD,
    );
  });

  it("round-trips after rpc_done with an event id", () => {
    const mid: InstallOutboxRecord = {
      ...RECORD,
      step: "rpc_done",
      installEventId: "event-1",
    };
    expect(deserializeInstallOutbox(serializeInstallOutbox(mid))).toEqual(mid);
  });

  it("rejects corrupt JSON", () => {
    expect(deserializeInstallOutbox("not json")).toBeNull();
  });

  it("rejects records missing required payload fields", () => {
    expect(
      deserializeInstallOutbox(
        JSON.stringify({ id: "x", step: "queued", payload: { openingId: "o" } }),
      ),
    ).toBeNull();
  });
});

// --- the wait between tries -----------------------------------------------
//
// 2026-09-04. The failure handler bumped the attempt count and stopped there,
// setting no time to try again — and the pass that drains this queue runs
// every thirty seconds AND on every "online" event. So all eight attempts fit
// inside about four minutes of ordinary "bars but no data", and a FINISHED
// install dead-lettered on the phone of somebody standing in a house with one
// bar. These pin the spacing that turns those same eight tries into about
// fifteen minutes.
describe("a failed install waits before it tries again", () => {
  const NOW = 1_700_000_000_000;
  const DEAD_ZONE = new TypeError("Failed to fetch");

  it("schedules the sibling queue's backoff, and grows it", () => {
    const first = applyInstallFailure(RECORD, DEAD_ZONE, NOW);
    expect(first.status).toBe("pending");
    expect(first.attemptCount).toBe(1);
    expect(first.nextAttemptAt).toBe(NOW + BACKOFF_BASE_MS * 2);

    const second = applyInstallFailure(first, DEAD_ZONE, NOW);
    expect(second.nextAttemptAt).toBe(NOW + BACKOFF_BASE_MS * 4);
  });

  it("stops growing at the five-minute ceiling", () => {
    const late = applyInstallFailure(
      { ...RECORD, attemptCount: 6 },
      DEAD_ZONE,
      NOW,
    );
    expect(late.nextAttemptAt).toBe(NOW + BACKOFF_CAP_MS);
  });

  it("gives up at the cap, and leaves the clock alone once it has", () => {
    const last = applyInstallFailure(
      { ...RECORD, attemptCount: MAX_ATTEMPTS - 1, nextAttemptAt: NOW },
      DEAD_ZONE,
      NOW,
    );
    expect(last.status).toBe("failed");
    // Waiting on a person now, not on a clock — Retry sets its own time.
    expect(last.nextAttemptAt).toBe(NOW);
  });

  it("still refuses a permanent error on the very first attempt", () => {
    const refused = applyInstallFailure(
      RECORD,
      { code: "P0001", message: "this opening needs flashing first" },
      NOW,
    );
    expect(refused.status).toBe("failed");
    expect(refused.attemptCount).toBe(1);
    expect(refused.lastError).toContain("needs flashing");
  });

  it("is not due until its wait has passed", () => {
    const waiting = applyInstallFailure(RECORD, DEAD_ZONE, NOW);
    expect(isInstallDue(waiting, NOW + 1_000)).toBe(false);
    expect(isInstallDue(waiting, waiting.nextAttemptAt)).toBe(true);
    // One that gave up is never due: it needs a person, not another pass.
    expect(isInstallDue({ ...RECORD, status: "failed" }, NOW)).toBe(false);
  });

  it("opens an install that was saved before any of this existed", () => {
    // Records already sitting on phones carry no nextAttemptAt at all. If the
    // loader left it undefined they would never be due again — a finished
    // install, on a real phone, silently stranded by the fix meant to save it.
    const { nextAttemptAt: _dropped, ...older } = RECORD;
    const restored = deserializeInstallOutbox(JSON.stringify(older));
    expect(restored?.nextAttemptAt).toBe(0);
    expect(isInstallDue(restored!, NOW)).toBe(true);
  });
});

// --- the flush itself -----------------------------------------------------
//
// Everything above is pure. These need the IndexedDB the outbox actually
// writes to, and vitest runs in node with no browser storage — so this is the
// smallest store that behaves the way installOutbox uses one: open, one object
// store keyed by id, put / delete / getAll, and transactions that complete on
// their own. Callbacks fire on a macrotask so the handlers assigned right
// after each call are always in place first, which is how a real request
// behaves.

interface FakeRow {
  id: string;
  meta: string;
  blobs: Blob[];
}

function installFakeIndexedDb(): Map<string, FakeRow> {
  const rows = new Map<string, FakeRow>();
  const settle = <T,>(result: T) => {
    const req = { result, onsuccess: null, onerror: null } as unknown as {
      result: T;
      onsuccess: (() => void) | null;
      onerror: (() => void) | null;
    };
    setTimeout(() => req.onsuccess?.(), 0);
    return req;
  };
  const store = {
    put: (row: FakeRow) => {
      rows.set(row.id, row);
      return settle(undefined);
    },
    delete: (id: string) => {
      rows.delete(id);
      return settle(undefined);
    },
    getAll: () => settle([...rows.values()]),
  };
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => store,
    transaction: () => {
      const tx = { objectStore: () => store, oncomplete: null, onerror: null } as {
        objectStore: () => typeof store;
        oncomplete: (() => void) | null;
        onerror: (() => void) | null;
      };
      setTimeout(() => tx.oncomplete?.(), 0);
      return tx;
    },
    close: () => {},
  };
  vi.stubGlobal("indexedDB", {
    open: () => {
      const req = {
        result: db,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      } as unknown as {
        result: typeof db;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        onupgradeneeded: (() => void) | null;
      };
      setTimeout(() => {
        req.onupgradeneeded?.();
        req.onsuccess?.();
      }, 0);
      return req;
    },
  });
  return rows;
}

const INPUT = {
  openingId: "opening-1",
  projectId: "project-1",
  openingCode: "10",
  assignedWindowId: null,
  createdBy: "installer@crew.com",
  /** Whoever is signed in, captured at the moment the input is used — as
   * OpeningSheet captures it at the tap (every test signs someone in first). */
  get submitter() {
    const mark = signInMark();
    return mark.userId ? { userId: mark.userId, email: signedInEmail(), mark } : null;
  },
  submitParams: { openingId: "opening-1" },
  points: null,
  media: [],
};

describe("a refused install reaches the person who submitted it", () => {
  let rows: Map<string, FakeRow>;

  beforeEach(() => {
    rows = installFakeIndexedDb();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  // The 2026-09-02 report: finish_unit refused a BLACK22 unit that still owed
  // flashing, and the sheet said "Install saved on this device — will sync
  // when you're back in signal."
  it("hands back a P0001 refusal instead of calling it queued", async () => {
    const { submitInstallEvent } = await import("./api");
    const refusal = {
      code: "P0001",
      message: "this opening needs flashing submitted before the install is filed",
    };
    vi.mocked(submitInstallEvent).mockRejectedValue(refusal);

    const { submitInstallViaOutbox, listFailedInstalls } = await import(
      "./installOutbox"
    );
    const result = await submitInstallViaOutbox(INPUT);

    expect(result.refused?.error).toBe(refusal);
    // The record is still on the phone (failed, not removed) — its own
    // receipt says so too, the same as any other install still in the store.
    expect(result.queued).toBe(true);

    // And it is parked, not lost: one failed record, still at the RPC step, so
    // a retry after the cause is fixed resumes rather than repeats.
    const failed = await listFailedInstalls();
    expect(failed).toHaveLength(1);
    expect(failed[0]?.step).toBe("queued");
    expect(failed[0]?.lastError).toContain("needs flashing");
    expect(rows.size).toBe(1);
  });

  it("says nothing about a dead zone — that one still just queues", async () => {
    const { submitInstallEvent } = await import("./api");
    vi.mocked(submitInstallEvent).mockRejectedValue(
      new TypeError("Failed to fetch"),
    );

    const { submitInstallViaOutbox, pendingInstallCount, failedInstallCount } =
      await import("./installOutbox");
    const result = await submitInstallViaOutbox(INPUT);

    expect(result.refused).toBeNull();
    expect(result.queued).toBe(true);
    expect(await pendingInstallCount()).toBe(1);
    expect(await failedInstallCount()).toBe(0);
  });

  // The guarantee: an old stuck install from another window must never be
  // reported as the reason THIS Submit didn't go through.
  //
  // The older install has to still be PENDING and be refused in the same
  // flush, with the store handing it back first. An earlier version of this
  // test pre-failed it, which meant the flush skipped it outright — so the
  // pass only ever produced one refusal and "just take the first one" would
  // have passed too. Real IndexedDB orders by key, and the keys are random
  // UUIDs, so which one comes first is a coin toss in the field; the fake
  // store's insertion order lets the losing side of that toss be the case
  // under test every run.
  it("reports the refusal only for the install that was just submitted", async () => {
    const { submitInstallEvent } = await import("./api");
    const { enqueueInstall, failedInstallCount, submitInstallViaOutbox } =
      await import("./installOutbox");

    // Two refusals with different sentences, told apart by which install is
    // being filed.
    vi.mocked(submitInstallEvent).mockImplementation(async (params) => {
      if (params.openingId === "opening-old") {
        throw {
          code: "23505",
          message: "duplicate key value violates unique constraint",
        };
      }
      throw {
        code: "P0001",
        message:
          "this opening needs flashing submitted before the install is filed",
      };
    });

    const older = await enqueueInstall({
      ...INPUT,
      openingId: "opening-old",
      submitParams: { openingId: "opening-old" },
    });
    const result = await submitInstallViaOutbox(INPUT);

    // The premise: the stale one is walked FIRST in this pass.
    expect([...rows.keys()][0]).toBe(older.id);
    // The guarantee: the id, and the sentence, belong to this Submit.
    expect(result.refused?.id).not.toBe(older.id);
    expect((result.refused?.error as { code?: string })?.code).toBe("P0001");
    // Both are parked for a person; neither was lost.
    expect(await failedInstallCount()).toBe(2);
  });

  // Review, 2026-09-02. The re-entrancy guard used to return
  // `failedNow: []` on the spot when a flush was already running, having
  // attempted nothing — and lib/install/queue.ts flushes every 30 seconds, so
  // "already running" is a window an installer hits by tapping Submit at the
  // wrong second. The sheet then said "Install saved on this device" for an
  // install the server was about to refuse: the exact bug this work exists to
  // kill, through the back door.
  it("still gives a verdict when a background flush is already running", async () => {
    const { submitInstallEvent } = await import("./api");
    const { enqueueInstall, flushInstallOutbox, submitInstallViaOutbox } =
      await import("./installOutbox");

    vi.mocked(submitInstallEvent).mockImplementation(async (params) => {
      if (params.openingId === "opening-old") {
        // Hold the background pass open until Submit's own record is on
        // disk. That is precisely the window the guard used to shrug at.
        await vi.waitFor(() => expect(rows.size).toBe(2));
        throw new TypeError("Failed to fetch");
      }
      throw {
        code: "P0001",
        message:
          "this opening needs flashing submitted before the install is filed",
      };
    });

    await enqueueInstall({
      ...INPUT,
      openingId: "opening-old",
      // The RPC is called with submitParams, so the OLD install has to be
      // told apart there, not just on the record.
      submitParams: { openingId: "opening-old" },
    });
    const background = flushInstallOutbox();

    const result = await submitInstallViaOutbox(INPUT);
    await background;

    expect((result.refused?.error as { code?: string })?.code).toBe("P0001");
    // And the older one is untouched by somebody else's verdict: a dead zone
    // is still just a dead zone, still pending, still going to retry.
    const { failedInstallCount } = await import("./installOutbox");
    expect(await failedInstallCount()).toBe(1);
  });

  // The four-minute incident, at the level the record actually lives: a dead
  // zone must buy a wait, and the passes that arrive during it — one every
  // thirty seconds, plus one per "online" event on a flapping connection —
  // must leave the record alone instead of spending its eight tries.
  it("does not attempt an install again on the very next pass", async () => {
    const { submitInstallEvent } = await import("./api");
    vi.mocked(submitInstallEvent).mockRejectedValue(
      new TypeError("Failed to fetch"),
    );

    const { submitInstallViaOutbox, flushInstallOutbox, pendingInstallCount } =
      await import("./installOutbox");
    await submitInstallViaOutbox(INPUT);
    expect(vi.mocked(submitInstallEvent)).toHaveBeenCalledTimes(1);

    await flushInstallOutbox();
    await flushInstallOutbox();
    await flushInstallOutbox();

    expect(vi.mocked(submitInstallEvent)).toHaveBeenCalledTimes(1);
    // Still on the phone and still trying — skipped, not given up on.
    expect(await pendingInstallCount()).toBe(1);
  });

  // A person tapped Retry and is watching. Leaving a five-minute backoff in
  // front of their tap would look exactly like a button that does nothing.
  it("Retry sends now, even with minutes still on the clock", async () => {
    const { submitInstallEvent } = await import("./api");
    vi.mocked(submitInstallEvent).mockResolvedValue({
      id: "event-1",
    } as unknown as Awaited<ReturnType<typeof submitInstallEvent>>);

    const { retryFailedInstall } = await import("./installOutbox");
    const stuck: InstallOutboxRecord = {
      ...RECORD,
      status: "failed",
      attemptCount: MAX_ATTEMPTS,
      nextAttemptAt: Date.now() + 5 * 60_000,
    };
    rows.set(stuck.id, {
      id: stuck.id,
      meta: serializeInstallOutbox(stuck),
      blobs: [],
    });

    await retryFailedInstall(stuck.id);

    expect(vi.mocked(submitInstallEvent)).toHaveBeenCalledTimes(1);
    expect(rows.size).toBe(0);
  });

  it("files a clean install and clears it off the device", async () => {
    const { submitInstallEvent } = await import("./api");
    vi.mocked(submitInstallEvent).mockResolvedValue({
      id: "event-1",
    } as unknown as Awaited<ReturnType<typeof submitInstallEvent>>);

    const { submitInstallViaOutbox } = await import("./installOutbox");
    const result = await submitInstallViaOutbox(INPUT);

    expect(result.refused).toBeNull();
    expect(result.queued).toBe(false);
    expect(rows.size).toBe(0);
  });
});

// --- the media hand-off ----------------------------------------------------
//
// K0.6 (2026-09-23). Once the RPC and the points have landed, the unit's
// photos, memo and video go to the global outbox — under ids this record
// already carries, so a stage that runs twice queues the same entries twice
// rather than two different sets. Before this the media went to a queue of
// its own under a fresh id per pass, and a crash between "queued the second
// photo" and "removed the install record" made every photo a second row.
describe("media is handed to the global outbox under ids decided up front", () => {
  let rows: Map<string, FakeRow>;

  beforeEach(() => {
    rows = installFakeIndexedDb();
    outbox.handedOff.length = 0;
    outbox.failOnce = null;
    outbox.pendingMedia = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  const MEDIA = [
    {
      bucket: "install-media" as const,
      path: "project-1/10/1-before.jpg",
      contentType: "image/jpeg",
      kind: "photo" as const,
      blob: new Blob(["before"], { type: "image/jpeg" }),
    },
    {
      bucket: "install-media" as const,
      path: "project-1/10/1-memo.webm",
      contentType: "audio/webm",
      kind: "voice_memo" as const,
      blob: new Blob(["memo"], { type: "audio/webm" }),
    },
  ];

  async function landTheRpc() {
    const { submitInstallEvent } = await import("./api");
    vi.mocked(submitInstallEvent).mockResolvedValue({
      id: "event-1",
    } as unknown as Awaited<ReturnType<typeof submitInstallEvent>>);
  }

  it("writes each item's outbox id into the record before anything is sent", async () => {
    const { enqueueInstall } = await import("./installOutbox");
    const record = await enqueueInstall({ ...INPUT, media: MEDIA });
    const ids = record.payload.media.map((m) => m.clientId);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(ids).size).toBe(2);
    // And it is on disk that way, which is what a re-run reads.
    const stored = deserializeInstallOutbox(rows.get(record.id)!.meta);
    expect(stored?.payload.media.map((m) => m.clientId)).toEqual(ids);
  });

  it("hands every item over under its recorded id, then clears the record", async () => {
    await landTheRpc();
    const { submitInstallViaOutbox, listInstalls } = await import("./installOutbox");
    const result = await submitInstallViaOutbox({ ...INPUT, media: MEDIA });
    expect(result.queued).toBe(false);
    expect(outbox.handedOff.map((h) => h.path)).toEqual(MEDIA.map((m) => m.path));
    expect(outbox.handedOff.map((h) => h.kind)).toEqual(["photo", "voice_memo"]);
    // Already captured media is never refused for its size at hand-off.
    expect(outbox.handedOff.every((h) => h.uncapped)).toBe(true);
    for (const h of outbox.handedOff) expect(h.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await listInstalls()).toEqual([]);
  });

  it("queues the same ids again when the stage re-runs after a crash, never new ones", async () => {
    await landTheRpc();
    const { submitInstallViaOutbox, sendInstallsNow, listInstalls } = await import(
      "./installOutbox"
    );
    // The second hand-off dies — a full store, a killed app — after the
    // first has landed in the outbox.
    outbox.failOnce = MEDIA[1].path;
    const first = await submitInstallViaOutbox({ ...INPUT, media: MEDIA });
    expect(first.queued).toBe(true);
    expect(outbox.handedOff.map((h) => h.path)).toEqual([MEDIA[0].path]);
    // Still on the phone, at the media step, pending — not lost, not failed.
    const [left] = await listInstalls();
    expect(left?.step).toBe("points_done");
    expect(left?.status).toBe("pending");

    await sendInstallsNow();
    expect(await listInstalls()).toEqual([]);
    // Three hand-offs in total, TWO distinct ids: the photo went twice under
    // the same id, which the outbox store replaces and the server dedupes.
    expect(outbox.handedOff).toHaveLength(3);
    const byPath = new Map<string, Set<string | undefined>>();
    for (const h of outbox.handedOff) {
      byPath.set(h.path, (byPath.get(h.path) ?? new Set()).add(h.id));
    }
    expect(byPath.get(MEDIA[0].path)?.size).toBe(1);
    expect(byPath.get(MEDIA[1].path)?.size).toBe(1);
    expect(new Set(outbox.handedOff.map((h) => h.id)).size).toBe(2);
  });

  it("derives a stable id for a record written before ids were recorded", async () => {
    // What is sitting on phones today: a record at the media step whose
    // items carry no clientId. It must get the same crash-safety without a
    // rewrite of what is on disk.
    const older: InstallOutboxRecord = {
      ...RECORD,
      step: "points_done",
      installEventId: "event-old",
      nextAttemptAt: 0,
    };
    rows.set(older.id, {
      id: older.id,
      meta: serializeInstallOutbox(older),
      blobs: [new Blob(["memo"], { type: "audio/webm" })],
    });
    const { flushInstallOutbox } = await import("./installOutbox");
    const { stableId } = await import("../offline/stableId");

    await flushInstallOutbox();

    expect(outbox.handedOff).toHaveLength(1);
    expect(outbox.handedOff[0]?.id).toBe(await stableId(`${RECORD.payload.clientKey}:media:0`));
    expect(rows.size).toBe(0);
  });

  it("reports the media still waiting after its one attempt, so the sheet can say so", async () => {
    await landTheRpc();
    outbox.pendingMedia = 2;
    const { submitInstallViaOutbox } = await import("./installOutbox");
    const result = await submitInstallViaOutbox({ ...INPUT, media: MEDIA });
    const { drain } = await import("../offline/outbox");
    expect(vi.mocked(drain)).toHaveBeenCalled();
    expect(result.remainingUploads).toBe(2);
  });
});

// --- whose media it is (Codex review of #660, P1 #2) -------------------------
//
// The media stage runs whenever the install queue drains — which can be after
// the person who finished the unit has signed out and someone else has signed
// in. It used to hand the media over with nobody named, and the outbox then
// stamped whoever was signed in AT THAT MOMENT as its owner: A's photos went
// up under B's token. The submitter is now written into the record when it is
// queued, and every hand-off names them.
describe("media goes out as the person who submitted the install", () => {
  beforeEach(() => {
    installFakeIndexedDb();
    outbox.handedOff.length = 0;
    outbox.failOnce = null;
    outbox.pendingMedia = 0;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    const { rememberSignedIn } = await import("../signedIn");
    rememberSignedIn(null);
  });

  const MEDIA = [
    {
      bucket: "install-media" as const,
      path: "project-1/10/1-after.jpg",
      contentType: "image/jpeg",
      kind: "photo" as const,
      blob: new Blob(["after"], { type: "image/jpeg" }),
    },
  ];

  it("writes the submitter into the record, holds the install while someone else is signed in, and hands the media over as the submitter", async () => {
    const { rememberSignedIn } = await import("../signedIn");
    const { enqueueInstall, sendInstallsNow, listInstalls } = await import("./installOutbox");
    const { submitInstallEvent } = await import("./api");
    // The RPC is not answering yet: the install waits on the phone.
    vi.mocked(submitInstallEvent).mockRejectedValue(new TypeError("Failed to fetch"));

    const A = { access_token: "token-A", user: { id: "installer-a", email: "a@crew.com" } };
    rememberSignedIn(A);
    auth.session = A;
    const { signInMark } = await import("../signedIn");
    const submitter = { userId: "installer-a", email: "a@crew.com", mark: signInMark() };
    const record = await enqueueInstall({ ...INPUT, createdBy: "a@crew.com", submitter, media: MEDIA });
    expect(record.payload.ownerId).toBe("installer-a");

    // A signs out; B signs in; signal comes back and the queue drains —
    // and A's install waits, whole (Codex's full re-check of #660).
    const B = { access_token: "token-B", user: { id: "installer-b", email: "b@crew.com" } };
    rememberSignedIn(B);
    auth.session = B;
    vi.mocked(submitInstallEvent).mockResolvedValue({
      id: "event-1",
    } as unknown as Awaited<ReturnType<typeof submitInstallEvent>>);
    await sendInstallsNow();
    const [waiting] = await listInstalls();
    expect(waiting?.payload.ownerId).toBe("installer-a");
    expect(outbox.handedOff).toEqual([]);

    // A is back: the install goes, and its media is handed over as A.
    rememberSignedIn(A);
    auth.session = A;
    await sendInstallsNow();
    expect(outbox.handedOff.map((h) => h.ownerId)).toEqual(["installer-a"]);
    expect(await listInstalls()).toEqual([]);
  });

  it("an install saved before owners were recorded hands its media over as the person its submitter email names — never as whoever drains it", async () => {
    const { rememberSignedIn } = await import("../signedIn");
    const { sendInstallsNow } = await import("./installOutbox");
    const { submitInstallEvent } = await import("./api");
    vi.mocked(submitInstallEvent).mockResolvedValue({
      id: "event-1",
    } as unknown as Awaited<ReturnType<typeof submitInstallEvent>>);

    // A record written by the build before this one: no ownerId in it.
    const rows = installFakeIndexedDb();
    const old: InstallOutboxRecord = {
      ...RECORD,
      id: "old-record",
      payload: { ...RECORD.payload, media: [{ ...RECORD.payload.media[0], kind: "photo", path: "project-1/W1/old.jpg" }] },
    };
    const meta = serializeInstallOutbox(old);
    expect(JSON.parse(meta).payload.ownerId).toBeUndefined();
    rows.set(old.id, { id: old.id, meta, blobs: [new Blob(["old"], { type: "image/jpeg" })] });

    // B drains: not B's install, so nothing moves (Codex's full re-check of
    // #660) — the media is not handed over as B, or as anyone.
    const B = { access_token: "token-B", user: { id: "installer-b", email: "b@crew.com" } };
    rememberSignedIn(B);
    auth.session = B;
    await sendInstallsNow();
    expect(outbox.handedOff).toEqual([]);

    // The person the record names (installer@crew.com) drains: it goes, and
    // the media is bound to that person's id — the check just matched them.
    const named = { access_token: "token-1", user: { id: "installer-1", email: "installer@crew.com" } };
    rememberSignedIn(named);
    auth.session = named;
    await sendInstallsNow();
    expect(outbox.handedOff.map((h) => h.ownerId)).toEqual(["installer-1"]);
  });

  // Codex re-check of #660 (P2): enqueueInstall copied createdBy from the
  // caller and took the owner from whoever memory held, without checking the
  // two agreed. With B signed in and A's email as the photographer it saved
  // {ownerId: B, createdBy: A} — and the photos went up under B's token.
  it("refuses an install whose photographer is someone other than the person saving it — and saves nothing", async () => {
    const { rememberSignedIn, signInMark } = await import("../signedIn");
    const { enqueueInstall, listInstalls } = await import("./installOutbox");
    rememberSignedIn({ user: { id: "installer-b", email: "b@crew.com" } });
    const submitter = { userId: "installer-b", email: "b@crew.com", mark: signInMark() };
    await expect(
      enqueueInstall({ ...INPUT, createdBy: "a@crew.com", submitter, media: MEDIA }),
    ).rejects.toThrow(/different person/);
    expect(await listInstalls()).toEqual([]);
  });

  it("refuses the save when the sign-in changed after Submit was tapped — never the new person's", async () => {
    const { rememberSignedIn, signInMark } = await import("../signedIn");
    const { enqueueInstall, listInstalls } = await import("./installOutbox");
    rememberSignedIn({ user: { id: "installer-a", email: "a@crew.com" } });
    // A taps Submit: the identity is taken right then.
    const submitter = { userId: "installer-a", email: "a@crew.com", mark: signInMark() };
    // ...and while the sheet is still getting the install ready, B signs in.
    rememberSignedIn({ user: { id: "installer-b", email: "b@crew.com" } });
    await expect(
      enqueueInstall({ ...INPUT, createdBy: "a@crew.com", submitter, media: MEDIA }),
    ).rejects.toThrow(/sign-in on this phone changed/);
    expect(await listInstalls()).toEqual([]);
  });

  it("refuses an install with no one to save it as", async () => {
    const { rememberSignedIn } = await import("../signedIn");
    const { enqueueInstall, listInstalls } = await import("./installOutbox");
    rememberSignedIn({ user: { id: "installer-b", email: "b@crew.com" } });
    await expect(
      enqueueInstall({ ...INPUT, createdBy: "b@crew.com", submitter: null, media: MEDIA }),
    ).rejects.toThrow(/Sign in/);
    expect(await listInstalls()).toEqual([]);
  });
});

// --- the install itself goes out only as the person who submitted it -------
//
// Codex's full re-check of #660 (P1): the media hand-off went out as the
// submitter, but the install RPC before it did not. flushInstallOutbox sent
// finish_unit through the shared client, and submitInstallEvent read the
// installer's id and email from whoever was signed in THEN. A submits with no
// signal, B signs in, and A's unit was filed as B's — and finish_unit closes
// the CALLER's unit session, so B's task time could move too.
describe("an install goes out only as the person who submitted it", () => {
  const A = { access_token: "token-A", user: { id: "installer-a", email: "a@crew.com" } };
  const B = { access_token: "token-B", user: { id: "installer-b", email: "b@crew.com" } };
  function signIn(who: typeof A | null) {
    rememberSignedIn(who);
    auth.session = who;
  }
  const POINTS = { profileId: "installer-a", entries: [{ kind: "install" as const, points: 20 }], ref: "opening-1", status: "pending" as const };

  beforeEach(() => {
    installFakeIndexedDb();
    outbox.handedOff.length = 0;
    outbox.failOnce = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  async function landsWhenCalled() {
    const { submitInstallEvent } = await import("./api");
    vi.mocked(submitInstallEvent).mockResolvedValue({
      id: "event-1",
    } as unknown as Awaited<ReturnType<typeof submitInstallEvent>>);
    return submitInstallEvent;
  }

  it("while B is signed in, A's install is not sent, no stage moves and no retry is used — and it goes out as A, on A's token, when A is back", async () => {
    const submit = await landsWhenCalled();
    const { awardPoints } = await import("../points");
    const { enqueueInstall, sendInstallsNow, listInstalls } = await import("./installOutbox");
    signIn(A);
    const record = await enqueueInstall({ ...INPUT, createdBy: A.user.email, points: POINTS, media: [] });

    signIn(B);
    await sendInstallsNow();
    expect(submit).not.toHaveBeenCalled();
    const [held] = await listInstalls();
    expect(held).toMatchObject({
      id: record.id,
      step: "queued",
      attemptCount: 0,
      lastError: null,
      status: "pending",
      nextAttemptAt: record.nextAttemptAt,
    });

    signIn(A);
    await sendInstallsNow();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submit).mock.calls[0][1]).toEqual({
      client: { boundTo: "token-A" },
      installer: { id: "installer-a", email: "a@crew.com" },
    });
    // The points go through the same locked client.
    expect(vi.mocked(awardPoints).mock.calls[0][4]).toEqual({ boundTo: "token-A" });
    expect(await listInstalls()).toEqual([]);
  });

  it("a sign-in landing while the send is being prepared cannot change whose install it is", async () => {
    const submit = await landsWhenCalled();
    const { enqueueInstall, sendInstallsNow } = await import("./installOutbox");
    signIn(A);
    await enqueueInstall({ ...INPUT, createdBy: A.user.email, media: [] });
    // A's session passes the check — and B signs in straight after.
    auth.afterRead = () => signIn(B);
    await sendInstallsNow();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submit).mock.calls[0][1]).toEqual({
      client: { boundTo: "token-A" },
      installer: { id: "installer-a", email: "a@crew.com" },
    });
  });

  it("with nobody signed in, nothing is sent and nothing is used up", async () => {
    const submit = await landsWhenCalled();
    const { enqueueInstall, sendInstallsNow, listInstalls } = await import("./installOutbox");
    signIn(A);
    await enqueueInstall({ ...INPUT, createdBy: A.user.email, media: [] });
    signIn(null);
    await sendInstallsNow();
    expect(submit).not.toHaveBeenCalled();
    expect((await listInstalls())[0]).toMatchObject({ step: "queued", attemptCount: 0 });
  });

  it("an install saved before owners were recorded goes out only as the person its submitter email names — and with no email, it waits", async () => {
    const submit = await landsWhenCalled();
    const { sendInstallsNow, listInstalls } = await import("./installOutbox");
    const rows = installFakeIndexedDb();
    const named: InstallOutboxRecord = { ...RECORD, id: "old-named", payload: { ...RECORD.payload, media: [], points: null, createdBy: "a@crew.com" } };
    const anonymous: InstallOutboxRecord = { ...RECORD, id: "old-anon", payload: { ...RECORD.payload, media: [], points: null, createdBy: null } };
    for (const r of [named, anonymous]) {
      expect(JSON.parse(serializeInstallOutbox(r)).payload.ownerId).toBeUndefined();
      rows.set(r.id, { id: r.id, meta: serializeInstallOutbox(r), blobs: [] });
    }

    signIn(B);
    await sendInstallsNow();
    expect(submit).not.toHaveBeenCalled();

    signIn(A);
    await sendInstallsNow();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submit).mock.calls[0][1]).toMatchObject({ installer: { id: "installer-a" } });
    // The one that names nobody is still waiting, untouched.
    const left = await listInstalls();
    expect(left.map((r) => r.id)).toEqual(["old-anon"]);
    expect(left[0]).toMatchObject({ step: "queued", attemptCount: 0 });
  });

  it("counts and lists someone else's install as theirs, and one naming nobody as unknown — never as this person's queued work", async () => {
    const { enqueueInstall, installCounts, listMyInstalls, listOthersInstalls } = await import("./installOutbox");
    const rows = installFakeIndexedDb();
    signIn(A);
    const mine = await enqueueInstall({ ...INPUT, createdBy: A.user.email, media: [] });
    const anonymous: InstallOutboxRecord = { ...RECORD, id: "old-anon", payload: { ...RECORD.payload, media: [], points: null, createdBy: null } };
    rows.set(anonymous.id, { id: anonymous.id, meta: serializeInstallOutbox(anonymous), blobs: [] });

    signIn(B);
    expect(await installCounts()).toEqual({ pending: 0, failed: 0, theirs: 1, unknown: 1 });
    expect(await listMyInstalls()).toEqual([]);
    const others = await listOthersInstalls();
    expect(others.held.map((r) => r.id)).toEqual([mine.id]);
    expect(others.unknown.map((r) => r.id)).toEqual(["old-anon"]);

    signIn(A);
    expect(await installCounts()).toEqual({ pending: 1, failed: 0, theirs: 0, unknown: 1 });
    expect((await listMyInstalls()).map((r) => r.id)).toEqual([mine.id]);
  });

  it("when the person who submitted signs back in, their install goes at once — not on the next 30-second tick", async () => {
    const submit = await landsWhenCalled();
    const { enqueueInstall, flushInstallOutbox, initInstallOutboxAutoFlush, stopInstallOutboxAutoFlush } = await import("./installOutbox");
    // The interval never fires here: only the sign-in can start the pass.
    vi.stubGlobal("window", { addEventListener: () => {}, setInterval: () => 0 });
    vi.stubGlobal("document", { addEventListener: () => {}, visibilityState: "visible" });
    vi.stubGlobal("navigator", { onLine: true });
    signIn(A);
    await enqueueInstall({ ...INPUT, createdBy: A.user.email, media: [] });
    signIn(B);
    try {
      initInstallOutboxAutoFlush();
      await flushInstallOutbox();
      expect(submit).not.toHaveBeenCalled();

      signIn(A);
      await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
      expect(vi.mocked(submit).mock.calls[0][1]).toMatchObject({ installer: { id: "installer-a" } });
    } finally {
      stopInstallOutboxAutoFlush();
    }
    // Stopped means stopped: a later sign-in starts nothing.
    signIn(B);
    signIn(A);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

// --- the completion receipt describes only the install just submitted ------
//
// submitInstallViaOutbox used to answer `queued` from flush.remaining and
// `remainingUploads` from pendingMediaCount() — both phone-wide. A's install
// stranded on the phone (held while B is signed in) or A's media still
// uploading was enough to make B's own, already-landed submit come back
// `queued: true` and inflate its file count, and OpeningSheet told B their
// own unit was "only saved on this device". Every field below now answers
// for the record `submitInstallViaOutbox` just enqueued, never anyone else's.
describe("the completion receipt is scoped to the install just submitted", () => {
  const A = { id: "installer-a", email: "a@crew.com" };
  const B = { id: "installer-b", email: "b@crew.com" };

  function signIn(who: typeof A) {
    rememberSignedIn({ user: who });
    auth.session = { access_token: `token-${who.id}`, user: who };
  }

  beforeEach(() => {
    installFakeIndexedDb();
    outbox.handedOff.length = 0;
    outbox.failOnce = null;
    outbox.pendingMedia = 0;
    outbox.queuedIds.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  async function submitterFor(who: typeof A) {
    const { signInMark } = await import("../signedIn");
    return { userId: who.id, email: who.email, mark: signInMark() };
  }

  it("does not count a foreign held install in a successful submit's own receipt", async () => {
    const { submitInstallEvent } = await import("./api");
    const { enqueueInstall, submitInstallViaOutbox, pendingInstallCount } =
      await import("./installOutbox");

    // A's install is queued while A is signed in, then B signs in before the
    // next flush ever reaches it — held whole, untouched, never attempted
    // (ownership gates it; see the describe above).
    signIn(A);
    await enqueueInstall({
      ...INPUT,
      createdBy: A.email,
      submitter: await submitterFor(A),
    });

    // B signs in and files their own unit; the server takes it straight away.
    signIn(B);
    vi.mocked(submitInstallEvent).mockResolvedValueOnce({
      id: "event-b",
    } as unknown as Awaited<ReturnType<typeof submitInstallEvent>>);
    const result = await submitInstallViaOutbox({
      ...INPUT,
      createdBy: B.email,
      submitter: await submitterFor(B),
    });

    expect(result.queued).toBe(false);
    expect(result.remainingInstalls).toBe(0);
    expect(result.remainingUploads).toBe(0);
    // A's install is genuinely still there — the general, phone-wide count
    // (the header pill's own source) says so; only this receipt is scoped.
    expect(await pendingInstallCount()).toBe(1);
  });

  it("does not count another install's still-uploading media in this submit's own remainingUploads", async () => {
    const { submitInstallEvent } = await import("./api");
    vi.mocked(submitInstallEvent).mockResolvedValue({
      id: "event-1",
    } as unknown as Awaited<ReturnType<typeof submitInstallEvent>>);
    const { submitInstallViaOutbox } = await import("./installOutbox");

    // A stray upload from some other install, already handed off and still
    // queued in the global outbox — nothing to do with what B is about to
    // submit.
    outbox.queuedIds.add("someone-elses-photo");

    const media = [
      {
        bucket: "install-media" as const,
        path: "project-1/10/1-after.jpg",
        contentType: "image/jpeg",
        kind: "photo" as const,
        blob: new Blob(["after"], { type: "image/jpeg" }),
      },
    ];
    const result = await submitInstallViaOutbox({ ...INPUT, media });

    // Only this install's own item, handed off under its own recorded
    // clientId, counts — the stray one is left exactly where it was.
    expect(result.remainingUploads).toBe(1);
    expect(outbox.handedOff).toHaveLength(1);
    expect(outbox.queuedIds.has("someone-elses-photo")).toBe(true);
  });

  // Offline/retry: both installs are still on the phone, neither has signal,
  // and this receipt must still speak only for the one just submitted.
  it("counts only this submit when it and a foreign held install are both still waiting on signal", async () => {
    const { submitInstallEvent } = await import("./api");
    vi.mocked(submitInstallEvent).mockRejectedValue(
      new TypeError("Failed to fetch"),
    );
    const { enqueueInstall, submitInstallViaOutbox, pendingInstallCount } =
      await import("./installOutbox");

    signIn(A);
    await enqueueInstall({
      ...INPUT,
      createdBy: A.email,
      submitter: await submitterFor(A),
    });

    signIn(B);
    const result = await submitInstallViaOutbox({
      ...INPUT,
      createdBy: B.email,
      submitter: await submitterFor(B),
    });

    expect(result.queued).toBe(true);
    expect(result.remainingInstalls).toBe(1);
    // Two installs are genuinely waiting on the phone; only the general count
    // says so.
    expect(await pendingInstallCount()).toBe(2);

    // Once B is back in signal, sending now picks up B's own record (still
    // signed in as B) and leaves A's held install exactly as it was — held
    // for A, not B's to send.
    vi.mocked(submitInstallEvent).mockResolvedValueOnce({
      id: "event-b-retry",
    } as unknown as Awaited<ReturnType<typeof submitInstallEvent>>);
    const { sendInstallsNow, listInstalls } = await import("./installOutbox");
    await sendInstallsNow();
    const left = await listInstalls();
    expect(left).toHaveLength(1);
    expect(left[0]?.payload.createdBy).toBe(A.email);
  });
});
