import { describe, expect, it, vi } from "vitest";
import type { OutboxEntry } from "../offline/outbox-core";
import {
  deserializeUploadMeta,
  legacyUploadEntry,
  migrateLegacyUploads,
  pendingLegacyUploadCount,
  serializeUploadMeta,
  type LegacyUploadRecord,
  type LegacyUploadSource,
  type QueuedUploadMeta,
} from "./legacyUploadQueue";

const META: QueuedUploadMeta = {
  id: "b7a2f9c0-0000-4000-8000-000000000001",
  bucket: "install-media",
  path: "proj-1/W1/1720000000-memo.webm",
  contentType: "audio/webm",
  kind: "voice_memo",
  installEventId: "e1",
  windowId: "w1",
  createdBy: "installer@crew.com",
  createdAt: "2026-07-15T12:00:00.000Z",
  projectId: "proj-1",
  lat: 37.7749,
  lng: -122.4194,
  accuracyM: 8.6,
  takenAt: "2026-07-15T11:59:00.000Z",
};

describe("upload queue serialization", () => {
  it("round-trips metadata", () => {
    expect(deserializeUploadMeta(serializeUploadMeta(META))).toEqual(META);
  });

  it("round-trips null optional fields", () => {
    const meta = { ...META, installEventId: null, windowId: null, createdBy: null };
    expect(deserializeUploadMeta(serializeUploadMeta(meta))).toEqual(meta);
  });

  it("rejects corrupt JSON instead of throwing", () => {
    expect(deserializeUploadMeta("not json {")).toBeNull();
  });

  it("rejects records missing required fields", () => {
    expect(deserializeUploadMeta(JSON.stringify({ id: "x" }))).toBeNull();
  });

  it("rejects unknown buckets and kinds", () => {
    expect(
      deserializeUploadMeta(JSON.stringify({ ...META, bucket: "other" })),
    ).toBeNull();
    expect(
      deserializeUploadMeta(JSON.stringify({ ...META, kind: "document" })),
    ).toBeNull();
  });

  it("accepts the video kind", () => {
    expect(
      deserializeUploadMeta(JSON.stringify({ ...META, kind: "video" }))?.kind,
    ).toBe("video");
  });

  it("defaults createdAt when absent so old items still move", () => {
    const { createdAt: _omitted, ...rest } = META;
    const out = deserializeUploadMeta(JSON.stringify(rest));
    expect(out).not.toBeNull();
    expect(typeof out!.createdAt).toBe("string");
  });
});

// --- what an old item becomes -------------------------------------------

describe("legacyUploadEntry", () => {
  const NOW = 1_800_000_000_000;

  it("keeps the item's own id as the outbox id, so the move is idempotent", () => {
    expect(legacyUploadEntry(META, NOW).id).toBe(META.id);
  });

  it("keeps the item's original time, so /stuck tells the truth about its age", () => {
    expect(legacyUploadEntry(META, NOW).createdAt).toBe(Date.parse(META.createdAt));
  });

  it("falls back to now for an item with no readable time", () => {
    expect(legacyUploadEntry({ ...META, createdAt: "garbage" }, NOW).createdAt).toBe(NOW);
  });

  it("writes the same payload a unit photo gets today, flagged as an old item", () => {
    const e = legacyUploadEntry(META, NOW);
    expect(e.op).toBe("photo_upload");
    expect(e.hasBlob).toBe(true);
    expect(e.status).toBe("queued");
    expect(e.payload).toEqual({
      bucket: "install-media",
      path: META.path,
      contentType: "audio/webm",
      kind: "voice_memo",
      windowId: "w1",
      installEventId: "e1",
      createdBy: "installer@crew.com",
      projectId: "proj-1",
      packageId: null,
      lat: 37.7749,
      lng: -122.4194,
      accuracyM: 8.6,
      takenAt: "2026-07-15T11:59:00.000Z",
      caption: null,
      legacyUpload: true,
    });
  });
});

// --- the move itself ------------------------------------------------------
//
// The old store and the outbox are both doubles here so the ORDER of the two
// writes, and what a crash between them does, is what is under test.

function record(meta: QueuedUploadMeta): LegacyUploadRecord {
  return { id: meta.id, meta: serializeUploadMeta(meta), blob: new Blob(["x"]) };
}

function fakeSource(records: LegacyUploadRecord[]) {
  const store = new Map(records.map((r) => [r.id, r]));
  const removed: string[] = [];
  let disposed = 0;
  const source: LegacyUploadSource = {
    list: async () => [...store.values()],
    remove: async (id) => {
      store.delete(id);
      removed.push(id);
    },
    dispose: async () => {
      disposed += 1;
    },
  };
  return { source, store, removed, disposed: () => disposed };
}

function fakeTarget() {
  const entries = new Map<string, { entry: OutboxEntry; blob: Blob }>();
  const puts: string[] = [];
  const target = {
    put: vi.fn(async (entry: OutboxEntry, blob: Blob) => {
      puts.push(entry.id);
      entries.set(entry.id, { entry, blob });
    }),
  };
  return { target, entries, puts };
}

const SECOND: QueuedUploadMeta = {
  ...META,
  id: "b7a2f9c0-0000-4000-8000-000000000002",
  path: "proj-1/W1/1720000001-after.jpg",
  contentType: "image/jpeg",
  kind: "photo",
  createdAt: "2026-07-15T12:01:00.000Z",
};

describe("migrateLegacyUploads", () => {
  it("does nothing on a phone with nothing in the old store", async () => {
    const { source, disposed } = fakeSource([]);
    const { target } = fakeTarget();
    expect(await migrateLegacyUploads(target, source)).toEqual({ moved: 0, dropped: 0, left: 0 });
    expect(target.put).not.toHaveBeenCalled();
    // An empty store on a phone that never had one is not disposed of
    // either: list() answered empty without opening anything.
    expect(disposed()).toBe(0);
  });

  it("moves every item into the outbox under its own id, then empties the old store", async () => {
    const { source, store, disposed } = fakeSource([record(SECOND), record(META)]);
    const { target, entries, puts } = fakeTarget();
    const r = await migrateLegacyUploads(target, source);
    expect(r).toEqual({ moved: 2, dropped: 0, left: 0 });
    expect([...entries.keys()].sort()).toEqual([META.id, SECOND.id].sort());
    // Oldest first, whatever order the store handed them back in.
    expect(puts).toEqual([META.id, SECOND.id]);
    expect(store.size).toBe(0);
    expect(disposed()).toBe(1);
    expect(entries.get(META.id)?.blob).toBeInstanceOf(Blob);
  });

  it("never deletes an old item before the outbox write has finished", async () => {
    const order: string[] = [];
    const { source } = fakeSource([record(META)]);
    const sourceSpy: LegacyUploadSource = {
      ...source,
      remove: async (id) => {
        order.push("remove");
        await source.remove(id);
      },
    };
    const target = {
      put: async () => {
        order.push("put-start");
        await new Promise((r) => setTimeout(r, 5));
        order.push("put-done");
      },
    };
    await migrateLegacyUploads(target, sourceSpy);
    expect(order).toEqual(["put-start", "put-done", "remove"]);
  });

  it("leaves an item in the old store when the outbox refuses it, and keeps the store", async () => {
    const { source, store, disposed } = fakeSource([record(META)]);
    const target = { put: vi.fn(async () => { throw new Error("quota"); }) };
    expect(await migrateLegacyUploads(target, source)).toEqual({ moved: 0, dropped: 0, left: 1 });
    expect(store.has(META.id)).toBe(true);
    expect(disposed()).toBe(0);
  });

  it("survives a crash between the outbox write and the delete without doubling the item", async () => {
    // First start: the outbox write lands, then the phone dies before the
    // old record is removed.
    const first = fakeSource([record(META), record(SECOND)]);
    const { target, entries, puts } = fakeTarget();
    let crashed = false;
    const crashing: LegacyUploadSource = {
      ...first.source,
      remove: async (id) => {
        if (id === META.id && !crashed) {
          crashed = true;
          throw new Error("phone died");
        }
        await first.source.remove(id);
      },
    };
    await migrateLegacyUploads(target, crashing);
    // META is in the outbox AND still in the old store.
    expect(entries.has(META.id)).toBe(true);
    expect(first.store.has(META.id)).toBe(true);

    // Second start: the same store, the same outbox.
    await migrateLegacyUploads(target, first.source);
    expect(first.store.size).toBe(0);
    // The put happened again — under the SAME id, so the outbox holds one
    // entry per item, not two.
    expect(puts.filter((id) => id === META.id)).toHaveLength(2);
    expect(entries.size).toBe(2);
  });

  it("drops an item whose metadata cannot be read, as the old flush did", async () => {
    const { source, store } = fakeSource([
      { id: "corrupt", meta: "not json", blob: new Blob(["x"]) },
      record(META),
    ]);
    const { target, entries } = fakeTarget();
    expect(await migrateLegacyUploads(target, source)).toEqual({ moved: 1, dropped: 1, left: 0 });
    expect(entries.has("corrupt")).toBe(false);
    expect(store.size).toBe(0);
  });

  it("counts what is still waiting in the old store", async () => {
    const { source } = fakeSource([record(META), record(SECOND)]);
    expect(await pendingLegacyUploadCount(source)).toBe(2);
    await migrateLegacyUploads(fakeTarget().target, source);
    expect(await pendingLegacyUploadCount(source)).toBe(0);
  });
});
