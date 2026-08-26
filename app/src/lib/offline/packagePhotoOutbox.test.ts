// The queued half of a package's photo (pick 28).
//
// Unlike the ticket-11 damage photo (issuePhotoOutbox.test.ts), "Add a photo"
// on PackageSheet has no already-happening online call to ride along with —
// there is no arrive_packages-style RPC already writing a row this photo can
// point at. So this reuses the GENERIC photo_upload op/handler job photos use
// (lib/offline/outboxHandlers.ts's `upload`), just with package_id carried
// alongside project_id/lat/lng — both the attachments row and the bytes
// queue and drain together.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OutboxEntry } from "./outbox-core";

const storageUpload = vi.fn();
const attachmentsUpsert = vi.fn();
const attachmentsInsert = vi.fn();

vi.mock("../supabase", () => ({
  supabase: {
    storage: {
      from: (bucket: string) => ({
        upload: (path: string, blob: Blob, opts: Record<string, unknown>) =>
          storageUpload(bucket, path, blob, opts),
      }),
    },
    from: (table: string) => ({
      upsert: (row: Record<string, unknown>, opts: Record<string, unknown>) =>
        attachmentsUpsert(table, row, opts),
      insert: (row: Record<string, unknown>) => attachmentsInsert(table, row),
    }),
  },
  supabaseConfigured: true,
}));

const { createShiftResolver, createSupabaseHandlers } = await import("./outboxHandlers");
const handlers = createSupabaseHandlers(createShiftResolver());

function entryFor(payload: Record<string, unknown>): OutboxEntry {
  return {
    id: "outbox-entry-1",
    op: "photo_upload",
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

async function send(payload: Record<string, unknown>): Promise<void> {
  const handler = handlers.photo_upload;
  if (!handler) throw new Error("no photo_upload handler is registered");
  await handler(entryFor(payload), { getBlob: async () => BLOB });
}

beforeEach(() => {
  storageUpload.mockReset();
  attachmentsUpsert.mockReset();
  attachmentsInsert.mockReset();
  storageUpload.mockResolvedValue({ data: { path: "x" }, error: null });
  attachmentsUpsert.mockResolvedValue({ data: null, error: null });
  attachmentsInsert.mockResolvedValue({ data: null, error: null });
});

describe("a package photo queued through photo_upload", () => {
  it("uploads the bytes to install-media at the minted path", async () => {
    await send({
      bucket: "install-media",
      path: "packages/pkg-1/1000-ab12cd.jpg",
      contentType: "image/jpeg",
      kind: "photo",
      packageId: "pkg-1",
    });
    expect(storageUpload).toHaveBeenCalledWith(
      "install-media",
      "packages/pkg-1/1000-ab12cd.jpg",
      BLOB,
      { contentType: "image/jpeg", upsert: true },
    );
  });

  it("writes package_id onto the attachments row", async () => {
    await send({
      bucket: "install-media",
      path: "packages/pkg-1/1000-ab12cd.jpg",
      contentType: "image/jpeg",
      kind: "photo",
      packageId: "pkg-1",
      createdBy: "crew@example.com",
    });
    expect(attachmentsUpsert).toHaveBeenCalledWith(
      "attachments",
      expect.objectContaining({ package_id: "pkg-1", kind: "photo", created_by: "crew@example.com" }),
      { onConflict: "client_id" },
    );
  });

  // Regression guard: a plain job/receipt photo_upload entry (PhotoFeed, no
  // package) must keep writing a row — package_id being unconditionally
  // present in the payload (outbox.ts defaults it to null) must not turn
  // into a required field anywhere in this handler.
  it("writes package_id: null for an ordinary job photo", async () => {
    await send({
      bucket: "install-media",
      path: "unassigned/feed/1000-ab12cd.jpg",
      contentType: "image/jpeg",
      kind: "photo",
      projectId: "job-1",
      packageId: null,
    });
    expect(attachmentsUpsert).toHaveBeenCalledWith(
      "attachments",
      expect.objectContaining({ project_id: "job-1", package_id: null }),
      { onConflict: "client_id" },
    );
  });

  it("degrades to a database that predates package_id without throwing", async () => {
    // Tier 1 (upsert w/ client_id) and tier 2 (insert w/ geo, no client_id)
    // both carry package_id, so both fail identically on a database that
    // hasn't run 20260936000000 yet; tier 3 (base row) has never carried
    // package_id and is where a pre-migration database actually lands.
    const missingColumn = { code: "42703", message: "column package_id does not exist" };
    attachmentsUpsert.mockResolvedValue({ data: null, error: missingColumn });
    attachmentsInsert.mockImplementation((_table: string, row: Record<string, unknown>) =>
      "package_id" in row
        ? { data: null, error: missingColumn }
        : { data: null, error: null },
    );

    await send({
      bucket: "install-media",
      path: "packages/pkg-1/1000-ab12cd.jpg",
      contentType: "image/jpeg",
      kind: "photo",
      packageId: "pkg-1",
    });

    expect(attachmentsInsert).toHaveBeenCalledTimes(2);
    const [, baseRow] = attachmentsInsert.mock.calls[1] as [string, Record<string, unknown>];
    expect(baseRow).not.toHaveProperty("package_id");
  });

  it("passes a storage rejection straight through", async () => {
    storageUpload.mockResolvedValue({ data: null, error: new Error("storage is unhappy") });
    await expect(
      send({
        bucket: "install-media",
        path: "packages/pkg-1/1000-ab12cd.jpg",
        contentType: "image/jpeg",
        kind: "photo",
        packageId: "pkg-1",
      }),
    ).rejects.toThrow("storage is unhappy");
  });
});

// enqueueUpload (outbox.ts) builds the payload; this handler reads it back.
describe("the package link survives being queued", () => {
  it("reaches the handler with the same packageId it was queued with", async () => {
    const { enqueueUpload } = await import("./outbox");
    const blob = new Blob(["photo bytes"], { type: "image/jpeg" });

    await enqueueUpload({
      kind: "photo",
      bucket: "install-media",
      path: "packages/pkg-1/1000-ab12cd.jpg",
      contentType: "image/jpeg",
      packageId: "pkg-1",
      blob,
    });

    await vi.waitFor(() => expect(attachmentsUpsert).toHaveBeenCalled());
    expect(attachmentsUpsert).toHaveBeenCalledWith(
      "attachments",
      expect.objectContaining({ package_id: "pkg-1" }),
      { onConflict: "client_id" },
    );
  });
});
