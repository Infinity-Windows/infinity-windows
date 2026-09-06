// The enqueue half of the PDF receipt's second write: what actually goes into
// the queue, and what is refused before it gets there.
//
// The store is stubbed rather than real: `enqueue` writes to IndexedDB and then
// fires a drain, and neither is what these tests are about. What is: the entry
// carries `dependsOn` its capture entry (so set_receipt_document can never name
// a receipt that has not been filed) and a file too big to keep is refused in
// its OWN words, because the generic one says "try a smaller photo" to somebody
// holding a scanned invoice.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OutboxEntry } from "./outbox-core";

const put = vi.fn<(entry: OutboxEntry, blob?: Blob | null) => Promise<void>>();

vi.mock("./outboxStore", () => ({
  createDefaultStore: () => ({
    getAll: async () => [],
    put,
    getBlob: async () => null,
    delete: async () => {},
    count: async () => 0,
  }),
}));

// The handlers reach Supabase on the drain `enqueue` kicks off; nothing here
// asserts on them, and a real client would try to talk to the network.
vi.mock("./outboxHandlers", () => ({
  createShiftResolver: () => ({ record: () => {}, resolve: () => null }),
  createSupabaseHandlers: () => ({}),
  pendingShiftRef: (id: string) => `pending:${id}`,
}));

const { enqueueReceiptDocument, MAX_BLOB_BYTES, ReceiptDocumentTooLargeError } =
  await import("./outbox");

beforeEach(() => {
  put.mockReset();
  put.mockResolvedValue(undefined);
});

const smallPdf = () => new Blob(["%PDF-1.4 tiny"], { type: "application/pdf" });

describe("enqueueReceiptDocument", () => {
  it("waits for the receipt it belongs to — dependsOn the capture entry", async () => {
    await enqueueReceiptDocument({
      id: "receipt-1",
      dependsOn: "capture-entry-1",
      path: "receipts/receipt-1.pdf",
      contentType: "application/pdf",
      blob: smallPdf(),
    });

    const [entry, blob] = put.mock.calls[0];
    expect(entry.op).toBe("receipt_document_upload");
    expect(entry.dependsOn).toBe("capture-entry-1");
    expect(entry.hasBlob).toBe(true);
    expect(entry.payload).toMatchObject({
      id: "receipt-1",
      bucket: "install-media",
      path: "receipts/receipt-1.pdf",
      contentType: "application/pdf",
    });
    expect(blob).toBeInstanceOf(Blob);
  });

  it("refuses a file too big to keep, in words about a PDF and not about a photo", async () => {
    const huge = { size: MAX_BLOB_BYTES + 1, type: "application/pdf" } as Blob;
    const err = await enqueueReceiptDocument({
      id: "receipt-1",
      dependsOn: "capture-entry-1",
      path: "receipts/receipt-1.pdf",
      contentType: "application/pdf",
      blob: huge,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ReceiptDocumentTooLargeError);
    // The second sentence is the one that matters: the receipt itself was
    // already queued by the time this is called, and nobody should redo the
    // work thinking the whole thing failed.
    expect((err as Error).message).toMatch(/The receipt was still saved/);
    expect(put).not.toHaveBeenCalled();
  });
});
