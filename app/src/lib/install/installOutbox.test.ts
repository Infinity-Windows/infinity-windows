import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deserializeInstallOutbox,
  nextInstallStep,
  serializeInstallOutbox,
  stageToAttempt,
  type InstallOutboxRecord,
} from "./installOutbox";

// The network edges of a flush, faked so the queue's own decisions are what
// is under test: the RPC that files the install, the points award, and the
// media upload queue.
vi.mock("./api", () => ({ submitInstallEvent: vi.fn() }));
vi.mock("../points", () => ({ awardPoints: vi.fn(async () => {}) }));
vi.mock("./queue", () => ({
  enqueueUpload: vi.fn(async () => {}),
  flushQueue: vi.fn(async () => ({ sent: 0, remaining: 0 })),
}));

const RECORD: InstallOutboxRecord = {
  id: "outbox-1",
  step: "queued",
  installEventId: null,
  // A queued install now carries its own retry state, so a permanently broken
  // one can stop and be seen instead of retrying every 30 seconds forever.
  attemptCount: 0,
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
