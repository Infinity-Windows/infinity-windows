// Wave P: the receipt outbox ops — receipt_capture (upload + file_receipt,
// mirroring photo_upload's shape), receipt_answer (the upload flow's one
// question, resent through update_receipt's full-record contract) and, since
// 2026-09-05, receipt_document_upload (the original file a PDF receipt came
// from). Same mocking idiom as packagePhotoOutbox.test.ts /
// issuePhotoOutbox.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_OPS, type OutboxEntry, type OutboxOp } from "./outbox-core";

const storageUpload = vi.fn();
const rpc = vi.fn();
const receiptSelectMaybeSingle = vi.fn();

vi.mock("../supabase", () => ({
  supabase: {
    storage: {
      from: (bucket: string) => ({
        upload: (path: string, blob: Blob, opts: Record<string, unknown>) =>
          storageUpload(bucket, path, blob, opts),
      }),
    },
    from: (table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: () => receiptSelectMaybeSingle(table),
        }),
      }),
    }),
    rpc: (fn: string, args: Record<string, unknown>) => rpc(fn, args),
  },
  supabaseConfigured: true,
}));

const { createShiftResolver, createSupabaseHandlers } = await import("./outboxHandlers");
const handlers = createSupabaseHandlers(createShiftResolver());

function entryFor(op: OutboxOp, payload: Record<string, unknown>): OutboxEntry {
  return {
    id: "outbox-entry-1",
    op,
    payload,
    createdAt: 0,
    attemptCount: 0,
    lastError: null,
    status: "queued",
    nextAttemptAt: 0,
    hasBlob: op !== "receipt_answer",
  };
}

const BLOB = new Blob(["x"], { type: "image/jpeg" });
const PDF = new Blob(["%PDF-1.4"], { type: "application/pdf" });

async function sendCapture(payload: Record<string, unknown>): Promise<void> {
  const handler = handlers.receipt_capture;
  if (!handler) throw new Error("no receipt_capture handler is registered");
  await handler(entryFor("receipt_capture", payload), { getBlob: async () => BLOB });
}

async function sendAnswer(payload: Record<string, unknown>): Promise<void> {
  const handler = handlers.receipt_answer;
  if (!handler) throw new Error("no receipt_answer handler is registered");
  await handler(entryFor("receipt_answer", payload), { getBlob: async () => null });
}

async function sendDocument(payload: Record<string, unknown>): Promise<void> {
  const handler = handlers.receipt_document_upload;
  if (!handler) throw new Error("no receipt_document_upload handler is registered");
  await handler(entryFor("receipt_document_upload", payload), { getBlob: async () => PDF });
}

beforeEach(() => {
  storageUpload.mockReset();
  rpc.mockReset();
  receiptSelectMaybeSingle.mockReset();
  storageUpload.mockResolvedValue({ data: { path: "x" }, error: null });
  rpc.mockResolvedValue({ data: null, error: null });
});

describe("receipt_capture", () => {
  it("uploads the photo to install-media at the minted path", async () => {
    await sendCapture({
      id: "receipt-1",
      bucket: "install-media",
      path: "receipts/receipt-1.jpg",
      contentType: "image/jpeg",
    });
    expect(storageUpload).toHaveBeenCalledWith(
      "install-media",
      "receipts/receipt-1.jpg",
      BLOB,
      { contentType: "image/jpeg", upsert: true },
    );
  });

  it("files the row with the bucket-qualified photo path", async () => {
    await sendCapture({
      id: "receipt-1",
      bucket: "install-media",
      path: "receipts/receipt-1.jpg",
      contentType: "image/jpeg",
      projectId: "job-1",
      note: "shims",
    });
    expect(rpc).toHaveBeenCalledWith("file_receipt", {
      p_id: "receipt-1",
      p_photo_path: "install-media/receipts/receipt-1.jpg",
      p_project_id: "job-1",
      p_pending_job_name: null,
      p_note: "shims",
    });
  });

  it("files a jobless receipt (gas, e.g.) with both job fields null", async () => {
    await sendCapture({
      id: "receipt-1",
      bucket: "install-media",
      path: "receipts/receipt-1.jpg",
      contentType: "image/jpeg",
      projectId: null,
      pendingJobName: null,
    });
    expect(rpc).toHaveBeenCalledWith(
      "file_receipt",
      expect.objectContaining({ p_project_id: null, p_pending_job_name: null }),
    );
  });

  it("refuses (permanently, no id) rather than upload a receipt nobody can address", async () => {
    await expect(
      sendCapture({ bucket: "install-media", path: "receipts/x.jpg", contentType: "image/jpeg" }),
    ).rejects.toThrow(/missing its id/);
    expect(storageUpload).not.toHaveBeenCalled();
  });

  it("passes a storage rejection straight through", async () => {
    storageUpload.mockResolvedValue({ data: null, error: new Error("storage is unhappy") });
    await expect(
      sendCapture({ id: "receipt-1", bucket: "install-media", path: "receipts/receipt-1.jpg", contentType: "image/jpeg" }),
    ).rejects.toThrow("storage is unhappy");
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("receipt_answer", () => {
  it("reads the row's untouched fields and resends them unchanged, alongside the new answer", async () => {
    receiptSelectMaybeSingle.mockResolvedValue({
      data: {
        amount_cents: 1250,
        vendor: "Home Depot",
        purchased_on: "2026-08-20",
        category: "other",
        note: "shims",
      },
      error: null,
    });

    await sendAnswer({
      receiptId: "receipt-1",
      projectId: "job-1",
      pendingJobName: null,
      isPassthrough: true,
    });

    expect(rpc).toHaveBeenCalledWith("update_receipt", {
      p_id: "receipt-1",
      p_project_id: "job-1",
      p_pending_job_name: null,
      p_amount_cents: 1250,
      p_vendor: "Home Depot",
      p_purchased_on: "2026-08-20",
      p_category: "other",
      p_is_passthrough: true,
      p_note: "shims",
    });
  });

  it("never invents amount/vendor/date/category/note — only the payload's own three fields come from the queued answer", async () => {
    receiptSelectMaybeSingle.mockResolvedValue({
      data: {
        amount_cents: null,
        vendor: null,
        purchased_on: null,
        category: null,
        note: null,
      },
      error: null,
    });

    await sendAnswer({ receiptId: "receipt-1", projectId: null, pendingJobName: "New build on 5th", isPassthrough: null });

    const [, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(args.p_amount_cents).toBeNull();
    expect(args.p_vendor).toBeNull();
    expect(args.p_purchased_on).toBeNull();
    expect(args.p_category).toBeNull();
    expect(args.p_note).toBeNull();
    expect(args.p_pending_job_name).toBe("New build on 5th");
  });

  it("retries (not permanently) when the capture this depends on has not landed yet from this device's point of view", async () => {
    receiptSelectMaybeSingle.mockResolvedValue({ data: null, error: null });
    const err = await sendAnswer({ receiptId: "receipt-1", projectId: "job-1" }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/waiting for the receipt/i);
    expect((err as { permanent?: boolean }).permanent).not.toBe(true);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses (permanently) an answer with no receipt id", async () => {
    await expect(sendAnswer({ projectId: "job-1" })).rejects.toThrow(/missing which receipt/);
    expect(receiptSelectMaybeSingle).not.toHaveBeenCalled();
  });
});

describe("receipt_document_upload — the original a PDF receipt came from", () => {
  it("is a real op the queue can carry, not a name that deserializes to null", () => {
    // The four edits an op needs (union, OP_REGISTRY, handler map, OP_LABELS)
    // are compile-enforced; this is the runtime half of the same promise — an
    // op missing from the registry reads back off disk as null and its write is
    // lost with no error anywhere.
    expect(ALL_OPS).toContain("receipt_document_upload");
    expect(handlers.receipt_document_upload).toBeTypeOf("function");
  });

  it("puts the PDF in the bucket beside the picture, then records it on the row", async () => {
    await sendDocument({
      id: "receipt-1",
      bucket: "install-media",
      path: "receipts/receipt-1.pdf",
      contentType: "application/pdf",
    });
    expect(storageUpload).toHaveBeenCalledWith(
      "install-media",
      "receipts/receipt-1.pdf",
      PDF,
      { contentType: "application/pdf", upsert: true },
    );
    expect(rpc).toHaveBeenCalledWith("set_receipt_document", {
      p_id: "receipt-1",
      p_document_path: "install-media/receipts/receipt-1.pdf",
    });
  });

  it("never records a path whose bytes did not land", async () => {
    storageUpload.mockResolvedValue({ data: null, error: new Error("storage is unhappy") });
    await expect(
      sendDocument({ id: "receipt-1", path: "receipts/receipt-1.pdf", contentType: "application/pdf" }),
    ).rejects.toThrow("storage is unhappy");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses (permanently) a file with no receipt to belong to", async () => {
    await expect(
      sendDocument({ path: "receipts/x.pdf", contentType: "application/pdf" }),
    ).rejects.toThrow(/missing its receipt/);
    expect(storageUpload).not.toHaveBeenCalled();
  });

  it("fails on the FIRST try with words when the database has not got the function yet", async () => {
    // Deploying the backend has silently failed on this project before. Eight
    // retries of PostgREST's own sentence, then a dead letter, tells nobody
    // anything; missingGuard says what happened and what to do about it.
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    const err = await sendDocument({
      id: "receipt-1",
      path: "receipts/receipt-1.pdf",
      contentType: "application/pdf",
    }).catch((e) => e);
    expect((err as Error).message).toMatch(/needs an app update/);
    expect((err as { permanent?: boolean }).permanent).toBe(true);
  });
});
