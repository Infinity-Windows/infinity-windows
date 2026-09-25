// A finished unit's voice memo, and an item moved out of the retired upload
// queue, going through the SAME upload handler a job photo uses (K0.6).
//
// Two things the retired queue got wrong are pinned here. It asked for the
// memo's row back on the insert itself, so a row the SELECT policy would not
// hand back was saved and then retried forever; the handler now confirms the
// write first and reads the id separately, best-effort. And it inserted with
// no client id, so an item it had already filed — row saved, item never
// removed — would become a second row the moment the outbox sent it; the
// handler now asks the server whether a row already sits under that storage
// path before writing one.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OutboxEntry } from "./outbox-core";

type Answer = { data: { id: string } | null; error: { message: string; code?: string } | null };

const db = vi.hoisted(() => ({
  uploads: [] as Array<{ bucket: string; path: string }>,
  upserts: [] as Array<Record<string, unknown>>,
  /** Answer to "is there a row under this storage path already?" */
  byPath: { data: null, error: null } as Answer,
  /** Answer to "what is the id of the row filed under this client id?" */
  byClientId: { data: null, error: null } as Answer,
  reads: [] as Array<{ column: string; value: unknown }>,
}));

vi.mock("../supabase", () => {
  const select = () => {
    const filters: Array<{ column: string; value: unknown }> = [];
    const builder = {
      eq(column: string, value: unknown) {
        filters.push({ column, value });
        return builder;
      },
      limit() {
        return builder;
      },
      async maybeSingle() {
        db.reads.push(...filters);
        const f = filters[0];
        return f?.column === "storage_path" ? db.byPath : db.byClientId;
      },
    };
    return builder;
  };
  return {
    supabase: {
      storage: {
        from: (bucket: string) => ({
          upload: async (path: string) => {
            db.uploads.push({ bucket, path });
            return { error: null };
          },
        }),
      },
      from: () => ({
        upsert: async (row: Record<string, unknown>) => {
          db.upserts.push(row);
          return { error: null };
        },
        insert: async () => ({ error: null }),
        select,
      }),
    },
    supabaseConfigured: true,
  };
});

const transcribe = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("../install/transcribe", () => ({ transcribeInstallAttachment: transcribe }));

const { createShiftResolver, createSupabaseHandlers } = await import("./outboxHandlers");
const handlers = createSupabaseHandlers(createShiftResolver());

const BLOB = new Blob(["memo"], { type: "audio/webm" });
const ctx = { getBlob: async () => BLOB };

function memo(over: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    op: "photo_upload",
    payload: {
      bucket: "install-media",
      path: "project-1/10/1-memo.webm",
      contentType: "audio/webm",
      kind: "voice_memo",
      installEventId: "event-1",
      windowId: null,
      projectId: "project-1",
      createdBy: "installer@crew.com",
    },
    createdAt: 0,
    attemptCount: 0,
    lastError: null,
    status: "queued",
    nextAttemptAt: 0,
    dependsOn: null,
    hasBlob: true,
    ...over,
  };
}

beforeEach(() => {
  db.uploads.length = 0;
  db.upserts.length = 0;
  db.reads.length = 0;
  db.byPath = { data: null, error: null };
  db.byClientId = { data: null, error: null };
  transcribe.mockClear();
  transcribe.mockResolvedValue({ ok: true });
});

describe("a unit's voice memo through the upload handler", () => {
  it("files the row under the entry's client id, then starts its transcript", async () => {
    db.byClientId = { data: { id: "att-1" }, error: null };
    await handlers.photo_upload!(memo(), ctx);
    expect(db.uploads).toEqual([{ bucket: "install-media", path: "project-1/10/1-memo.webm" }]);
    expect(db.upserts).toHaveLength(1);
    expect(db.upserts[0]).toMatchObject({
      kind: "voice_memo",
      install_event_id: "event-1",
      storage_path: "install-media/project-1/10/1-memo.webm",
      client_id: "aaaaaaaa-0000-4000-8000-000000000001",
    });
    // The id was read back by client id — a second read, never RETURNING.
    expect(db.reads).toEqual([{ column: "client_id", value: "aaaaaaaa-0000-4000-8000-000000000001" }]);
    expect(transcribe).toHaveBeenCalledWith("att-1", BLOB);
  });

  it("still counts as sent when the id cannot be read back", async () => {
    // The old queue's exact failure: row saved, RETURNING refused, retried
    // forever. The write is confirmed on its own; the transcript waits for
    // retryTranscriptions().
    db.byClientId = { data: null, error: { message: "permission denied", code: "42501" } };
    await expect(handlers.photo_upload!(memo(), ctx)).resolves.toBeUndefined();
    expect(db.upserts).toHaveLength(1);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("still counts as sent when the transcript itself fails", async () => {
    db.byClientId = { data: { id: "att-1" }, error: null };
    transcribe.mockRejectedValue(new Error("whisper timed out"));
    await expect(handlers.photo_upload!(memo(), ctx)).resolves.toBeUndefined();
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it("does not ask for an id, or a transcript, for a photo or a video", async () => {
    await handlers.photo_upload!(memo({ payload: { ...memo().payload, kind: "photo" } }), ctx);
    await handlers.photo_upload!(memo({ id: "bbbbbbbb-0000-4000-8000-000000000002", payload: { ...memo().payload, kind: "video" } }), ctx);
    expect(db.reads).toEqual([]);
    expect(transcribe).not.toHaveBeenCalled();
    expect(db.upserts.map((r) => r.kind)).toEqual(["photo", "video"]);
  });
});

describe("an item moved out of the retired upload queue", () => {
  const moved = () => memo({ payload: { ...memo().payload, legacyUpload: true } });

  it("is not filed again when a row already sits under its storage path", async () => {
    db.byPath = { data: { id: "att-old" }, error: null };
    await handlers.photo_upload!(moved(), ctx);
    expect(db.reads[0]).toEqual({
      column: "storage_path",
      value: "install-media/project-1/10/1-memo.webm",
    });
    expect(db.uploads).toEqual([]);
    expect(db.upserts).toEqual([]);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("is filed normally when no row is there yet", async () => {
    db.byPath = { data: null, error: null };
    db.byClientId = { data: { id: "att-1" }, error: null };
    await handlers.photo_upload!(moved(), ctx);
    expect(db.uploads).toHaveLength(1);
    expect(db.upserts).toHaveLength(1);
    expect(transcribe).toHaveBeenCalledWith("att-1", BLOB);
  });

  it("is filed normally when the server refuses to answer the question", async () => {
    // A read the policy will not allow proves nothing either way; the one
    // thing this must never do is drop a photo on the strength of it.
    db.byPath = { data: null, error: { message: "permission denied", code: "42501" } };
    await handlers.photo_upload!(moved(), ctx);
    expect(db.upserts).toHaveLength(1);
  });

  it("waits for signal rather than guessing when the question cannot be sent", async () => {
    db.byPath = { data: null, error: { message: "Failed to fetch" } };
    await expect(handlers.photo_upload!(moved(), ctx)).rejects.toMatchObject({
      message: "Failed to fetch",
    });
    expect(db.uploads).toEqual([]);
    expect(db.upserts).toEqual([]);
  });

  it("never asks the question for an item queued by the outbox itself", async () => {
    await handlers.photo_upload!(memo({ payload: { ...memo().payload, kind: "photo" } }), ctx);
    expect(db.reads).toEqual([]);
  });
});
