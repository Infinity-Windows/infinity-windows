// The one place a receipt's ORIGINAL file becomes a URL a browser will open —
// and the reason it does not trust the row it was handed.
//
// `document_path` is written by a phone. ANY signed-in crew member may file a
// receipt, so any of them is the uploader of a row they may then write that
// column on. The first cut of this function split the stored string on its
// first "/" and signed against whatever came out, which made the row's own
// contents the chooser of the BUCKET: a value of "credential-docs/…" would
// have handed the person who tapped a link to somebody's ID document, and the
// month-end zip export would have filed it next to a Shell invoice under the
// receipt's name.
//
// The database now refuses to store anything but install-media/receipts/<id>.pdf
// (20260990000000_pdf_receipts.sql). This is the other end of that same rule,
// and these tests are what keep the two agreeing.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, createSignedUrl } = vi.hoisted(() => {
  const createSignedUrl = vi.fn(async () => ({
    data: { signedUrl: "https://example.test/signed" },
    error: null,
  }));
  const from = vi.fn(() => ({ createSignedUrl }));
  return { from, createSignedUrl };
});

vi.mock("./supabase", () => ({
  supabase: { storage: { from } },
  supabaseConfigured: true,
}));
// A signed thumbnail URL is not this file's business.
vi.mock("./photos", () => ({ signedMedia: async () => null }));

import { receiptDocumentSignedUrl } from "./receipts";

const ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const REF = `install-media/receipts/${ID}.pdf`;

beforeEach(() => {
  from.mockClear();
  createSignedUrl.mockClear();
});

describe("receiptDocumentSignedUrl", () => {
  it("signs this receipt's own original, in the receipts bucket, for ten minutes", async () => {
    await expect(receiptDocumentSignedUrl(ID, REF)).resolves.toBe(
      "https://example.test/signed",
    );
    expect(from).toHaveBeenCalledWith("install-media");
    // Ten minutes, not the hour a thumbnail gets: a thumbnail has to survive a
    // page sitting open, a download does not.
    expect(createSignedUrl).toHaveBeenCalledWith(`receipts/${ID}.pdf`, 600);
  });

  it("refuses a row naming a DIFFERENT bucket, and asks storage for nothing", async () => {
    await expect(
      receiptDocumentSignedUrl(ID, `credential-docs/u9/${ID}.pdf`),
    ).rejects.toThrow(/not where receipts keep theirs/);
    expect(from).not.toHaveBeenCalled();
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it("refuses a row naming another object in the SAME bucket", async () => {
    await expect(
      receiptDocumentSignedUrl(ID, "install-media/plansets/BLACK22/sheet-a1.pdf"),
    ).rejects.toThrow(/not where receipts keep theirs/);
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it("refuses another receipt's original, which is the row it could most easily be", async () => {
    await expect(
      receiptDocumentSignedUrl(ID, "install-media/receipts/bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb.pdf"),
    ).rejects.toThrow(/not where receipts keep theirs/);
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it("refuses a bare path with no bucket on it — the old fallback, now a refusal", async () => {
    await expect(receiptDocumentSignedUrl(ID, `receipts/${ID}.pdf`)).rejects.toThrow(
      /not where receipts keep theirs/,
    );
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it("hands a storage failure through, so the tap can say 'check your signal'", async () => {
    createSignedUrl.mockResolvedValueOnce({
      data: null,
      error: { message: "network" },
    } as unknown as Awaited<ReturnType<typeof createSignedUrl>>);
    await expect(receiptDocumentSignedUrl(ID, REF)).rejects.toMatchObject({
      message: "network",
    });
  });
});
