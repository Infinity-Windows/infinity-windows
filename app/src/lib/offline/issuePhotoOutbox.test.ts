// The queued half of a damage report's photo (ticket 11).
//
// arrive_packages (lib/storage.ts) is a direct call, not queued — it already
// wrote issues.photo_path to this exact bucket/path before this entry was
// ever queued (see damagePhotoPath). So this handler has exactly one job: get
// the bytes to the path the issue already points at. Nothing here writes to
// a table, unlike the generic photo_upload/receipt_upload handler, which
// would try (and fail) to write an attachments row — a damaged package has
// neither a window_id nor an install_event_id for attachments_target to
// accept.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OutboxEntry } from "./outbox-core";

const upload = vi.fn();
vi.mock("../supabase", () => ({
  supabase: {
    storage: {
      from: (bucket: string) => ({
        upload: (path: string, blob: Blob, opts: Record<string, unknown>) =>
          upload(bucket, path, blob, opts),
      }),
    },
  },
  supabaseConfigured: true,
}));

const { createShiftResolver, createSupabaseHandlers } = await import("./outboxHandlers");
const handlers = createSupabaseHandlers(createShiftResolver());

function entryFor(payload: Record<string, unknown>): OutboxEntry {
  return {
    id: "outbox-entry-1",
    op: "issue_photo_upload",
    payload,
    createdAt: 0,
    attemptCount: 0,
    lastError: null,
    status: "queued",
    nextAttemptAt: 0,
    hasBlob: true,
  };
}

const BLOB = new Blob(["x"], { type: "image/jpeg" });

async function send(
  payload: Record<string, unknown>,
  blob: Blob | null = BLOB,
): Promise<void> {
  const handler = handlers.issue_photo_upload;
  if (!handler) throw new Error("no issue_photo_upload handler is registered");
  await handler(entryFor(payload), { getBlob: async () => blob });
}

beforeEach(() => {
  upload.mockReset();
  upload.mockResolvedValue({ data: { path: "x" }, error: null });
});

describe("the queued damage photo", () => {
  it("puts the bytes at exactly the path the issue already points at", async () => {
    await send({ bucket: "issue-photos", path: "job-1/pkg-1-1000.jpg", contentType: "image/jpeg" });
    expect(upload).toHaveBeenCalledWith(
      "issue-photos",
      "job-1/pkg-1-1000.jpg",
      BLOB,
      { contentType: "image/jpeg", upsert: true },
    );
  });

  it("writes nothing else — the issue row already carries the path", async () => {
    // Regression guard: reusing the generic upload handler here would also
    // try to write an `attachments` row and fail attachments_target, since a
    // damaged package has neither a window_id nor an install_event_id.
    await send({ bucket: "issue-photos", path: "job-1/pkg-1-1000.jpg", contentType: "image/jpeg" });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("refuses an entry with no path", async () => {
    await expect(
      send({ bucket: "issue-photos", contentType: "image/jpeg" }),
    ).rejects.toThrow("missing where it goes");
    expect(upload).not.toHaveBeenCalled();
  });

  it("refuses an entry with no blob rather than uploading nothing", async () => {
    await expect(
      send(
        { bucket: "issue-photos", path: "job-1/pkg-1-1000.jpg", contentType: "image/jpeg" },
        null,
      ),
    ).rejects.toThrow("missing its file");
    expect(upload).not.toHaveBeenCalled();
  });

  it("passes a storage rejection straight through", async () => {
    upload.mockResolvedValue({ data: null, error: new Error("storage is unhappy") });
    await expect(
      send({ bucket: "issue-photos", path: "job-1/pkg-1-1000.jpg", contentType: "image/jpeg" }),
    ).rejects.toThrow("storage is unhappy");
  });
});

// enqueueIssuePhoto (outbox.ts) builds the payload; this handler reads it
// back. This repo has already lost writes twice to a field renamed on one
// side and not the other, so the seam gets a real round trip, not a promise.
describe("the path survives being queued", () => {
  it("reaches storage with the same bucket, path and blob it was queued with", async () => {
    const { enqueueIssuePhoto } = await import("./outbox");
    const blob = new Blob(["photo bytes"], { type: "image/jpeg" });

    await enqueueIssuePhoto({
      bucket: "issue-photos",
      path: "job-1/pkg-1-1000.jpg",
      contentType: "image/jpeg",
      blob,
    });

    await vi.waitFor(() => expect(upload).toHaveBeenCalled());
    expect(upload).toHaveBeenCalledWith(
      "issue-photos",
      "job-1/pkg-1-1000.jpg",
      blob,
      { contentType: "image/jpeg", upsert: true },
    );
  });
});
