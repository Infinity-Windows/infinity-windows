// A photo taken for a JOB and nothing else — the shape the global Capture
// button produces, and the shape that has been quietly failing.
//
// `attachments_target` did not admit a project-only row (window / install
// event / package / opening, never the job). A job-feed photo sets project_id
// and none of those, so the insert came back 23514. The upload handler peeled
// back only on missing COLUMNS, so a check violation was treated as a normal
// retryable failure: eight attempts, then a dead letter carrying raw PostgREST
// text, on a screen an installer had no menu row for.
//
// 20260989000000 widens the constraint. These tests pin the client half — the
// row that goes out, and what happens when a phone reaches a database that has
// not applied that migration yet.

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

const BLOB = new Blob(["x"], { type: "image/jpeg" });
const PROJECT = "11111111-1111-4111-8111-111111111111";

function entry(): OutboxEntry {
  return {
    id: "outbox-entry-1",
    op: "photo_upload",
    payload: {
      bucket: "install-media",
      path: `${PROJECT}/feed/1000-ab12cd.jpg`,
      contentType: "image/jpeg",
      kind: "photo",
      projectId: PROJECT,
      createdBy: "installer@example.com",
      caption: "South elevation",
    },
    createdAt: 0,
    attemptCount: 0,
    lastError: null,
    status: "queued",
    nextAttemptAt: 0,
    hasBlob: true,
  };
}

async function send(): Promise<void> {
  const handler = handlers.photo_upload;
  if (!handler) throw new Error("no photo_upload handler is registered");
  await handler(entry(), { getBlob: async () => BLOB });
}

/** What PostgREST answers when a CHECK constraint refuses the row. */
const CHECK_VIOLATION = {
  code: "23514",
  message: 'new row for relation "attachments" violates check constraint "attachments_target"',
};

beforeEach(() => {
  storageUpload.mockReset();
  attachmentsUpsert.mockReset();
  attachmentsInsert.mockReset();
  storageUpload.mockResolvedValue({ data: { path: "x" }, error: null });
  attachmentsUpsert.mockResolvedValue({ data: null, error: null });
  attachmentsInsert.mockResolvedValue({ data: null, error: null });
});

describe("a photo attached to a job and nothing else", () => {
  it("writes project_id with every other target left null — that IS the row", async () => {
    await send();
    const [table, row] = attachmentsUpsert.mock.calls[0];
    expect(table).toBe("attachments");
    expect(row).toMatchObject({ project_id: PROJECT, kind: "photo" });
    expect(row.window_id).toBeNull();
    expect(row.install_event_id).toBeNull();
    expect(row.package_id).toBeNull();
  });
});

describe("a photo with no job at all", () => {
  it("is refused at the queue instead of queued to fail forever", async () => {
    // The row this would build has every target column null, which no widening
    // of attachments_target admits — so it can only be queued, retried and
    // dead-lettered, hours after the person was told the photo saved. The
    // Capture sheet asks for the job before opening the camera; this is the
    // backstop for any caller that forgets.
    const { enqueueUpload } = await import("./outbox");
    await expect(
      enqueueUpload({
        kind: "photo",
        path: "unassigned/feed/1000-ab12cd.jpg",
        contentType: "image/jpeg",
        blob: BLOB,
      }),
    ).rejects.toThrow(/needs a job/i);
  });

  it("still takes a photo hung off a package rather than a job", async () => {
    // The guard is "hangs off SOMETHING", not "has a project" — package photos
    // (PackageSheet) set package_id and no project and are perfectly valid.
    const { enqueueUpload } = await import("./outbox");
    await expect(
      enqueueUpload({
        kind: "photo",
        path: "packages/p1/1000-ab12cd.jpg",
        contentType: "image/jpeg",
        packageId: "22222222-2222-4222-8222-222222222222",
        blob: BLOB,
      }),
    ).resolves.toEqual(expect.any(String));
  });
});

describe("reaching a database that has not applied 20260989000000", () => {
  it("fails permanently instead of burning eight retries", async () => {
    attachmentsUpsert.mockResolvedValue({ data: null, error: CHECK_VIOLATION });
    attachmentsInsert.mockResolvedValue({ data: null, error: CHECK_VIOLATION });

    await expect(send()).rejects.toMatchObject({ permanent: true });
  });

  it("says what happened in words an installer can act on", async () => {
    attachmentsUpsert.mockResolvedValue({ data: null, error: CHECK_VIOLATION });
    attachmentsInsert.mockResolvedValue({ data: null, error: CHECK_VIOLATION });

    // Never the raw Postgres text: "violates check constraint
    // attachments_target" tells the person holding the phone nothing, and
    // leaks an internal constraint name into the field. Asserted by reading
    // the message, not with a negated matcher that can pass by not running.
    const message = await send().then(
      () => "it resolved, which is the bug",
      (e: unknown) => String((e as Error).message),
    );
    expect(message).toMatch(/still safe on this phone/i);
    expect(message).not.toContain("attachments_target");
    expect(message).not.toContain("check constraint");
  });

  it("does not keep peeling columns off — an emptier row fits the check less", async () => {
    attachmentsUpsert.mockResolvedValue({ data: null, error: CHECK_VIOLATION });
    attachmentsInsert.mockResolvedValue({ data: null, error: CHECK_VIOLATION });

    await expect(send()).rejects.toThrow();
    // Tier 1 (upsert) once; no tier-2/tier-3 inserts, which only strip columns
    // that were never the problem.
    expect(attachmentsUpsert).toHaveBeenCalledTimes(1);
    expect(attachmentsInsert).not.toHaveBeenCalled();
  });

  it("still peels back for a genuinely missing column", async () => {
    // The pre-existing behaviour, unchanged: an older database missing
    // client_id/geo columns degrades through the tiers rather than failing.
    attachmentsUpsert.mockResolvedValue({
      data: null,
      error: { code: "PGRST204", message: "Could not find the 'client_id' column" },
    });
    attachmentsInsert.mockResolvedValue({ data: null, error: null });

    await expect(send()).resolves.toBeUndefined();
    expect(attachmentsInsert).toHaveBeenCalledTimes(1);
  });
});
