// Signing today's toolbox talk (offline toolbox signing, 2026-09-25): ONE
// path, through the phone's outbox, whether or not there is signal. The PDF is
// built right here, at the moment of signing, so the record is exactly what
// was signed; the outbox sends it when it can. What this pins:
//   * the signature, the typed name, the talk as it was, the signing time and
//     the PDF all ride in one queued entry, keyed by a fresh client id, with
//     files at paths made from that id;
//   * nothing here touches the network — no upload, no insert;
//   * a talk with Do/Don't lists and check marks makes its PDF like any other
//     talk (lib/pdfText.ts), and so does a bad picture or a blank signature
//     image (the builder's own fallbacks);
//   * only a genuine failure to build the PDF signs without one — and then
//     the signature is never lost to the PDF.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, PDFPage } from "pdf-lib";
import type { SafetyTalk } from "./ops";
import type { ToolboxSignPayload } from "./toolboxSign";

const enqueued: Array<{ input: ToolboxSignPayload; pdf: Blob | null }> = [];
vi.mock("./offline/outbox", () => ({
  MAX_BLOB_BYTES: 25 * 1024 * 1024,
  enqueueToolboxSign: vi.fn(async (input: ToolboxSignPayload, pdf: Blob | null) => {
    enqueued.push({ input, pdf });
    return input.clientId;
  }),
}));
// The sign path must never reach for the server itself.
const network = vi.fn(() => {
  throw new Error("signing reached for the network");
});
vi.mock("./supabase", () => ({
  supabase: { from: network, rpc: network, storage: { from: network } },
  supabaseConfigured: true,
}));

const { signToolboxTalk, talkSnapshot } = await import("./toolbox");

// A 1x1 transparent PNG, as the signature pad would hand one over.
const SIGNATURE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const ME = "2b1c9f0e-1111-4a2b-8c3d-000000000001";

const plainTalk: SafetyTalk = {
  id: "7d0f3a2e-2222-4b3c-9d4e-000000000002",
  title: "Ladders",
  body: "Three points of contact, every time.",
  talk_date: "2026-09-25",
  sections_json: { intro: "Face the ladder.", key_hazards: ["Overreaching"], steps: ["Set the feet"] },
};

// The talk the coordinator flagged (2026-09-25): Do/Don't lists, and a check
// mark in the words themselves. The PDF's standard font has no check mark,
// and until lib/pdfText.ts (#665) a talk like this could not become a PDF at
// all. Now its PDF draws ✓ as + and ✗ as x, while the snapshot keeps every
// character exactly as signed.
const doDontTalk: SafetyTalk = {
  ...plainTalk,
  id: "7d0f3a2e-2222-4b3c-9d4e-000000000003",
  title: "Glass handling ✓",
  sections_json: {
    intro: "Carry glass on edge ✓ never flat.",
    dos: ["Wear cut sleeves ✓", "Two people over 4 ft"],
    donts: ["Don't carry it flat ✗", "Don't lift with wet gloves"],
  },
};

beforeEach(() => {
  enqueued.length = 0;
  network.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The first bytes of the queued PDF: "%PDF-" for a real one. */
async function pdfHead(pdf: Blob | null): Promise<string> {
  return new TextDecoder().decode(new Uint8Array(await pdf!.arrayBuffer()).slice(0, 5));
}

/** Every string drawn onto the PDF's pages while `run` ran, in order. */
async function drawnWhile(run: () => Promise<unknown>): Promise<string[]> {
  const drawText = vi.spyOn(PDFPage.prototype, "drawText");
  await run();
  return drawText.mock.calls.map((c) => String(c[0]));
}

describe("signing today's talk", () => {
  it("queues one entry with everything the record needs, keyed by a fresh client id — and sends nothing itself", async () => {
    const now = new Date(2026, 8, 25, 6, 55, 12);
    const view = await signToolboxTalk({
      talk: plainTalk,
      profileId: ME,
      typedName: "  Dana Reyes ",
      signatureDataUrl: SIGNATURE,
      now,
    });
    expect(network).not.toHaveBeenCalled();
    expect(enqueued).toHaveLength(1);
    const { input, pdf } = enqueued[0];
    expect(input.clientId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(input).toMatchObject({
      profileId: ME,
      talkId: plainTalk.id,
      talkDate: "2026-09-25",
      typedName: "Dana Reyes",
      signedAt: now.toISOString(),
      talkSnapshot: talkSnapshot(plainTalk),
      signatureDataUrl: SIGNATURE,
      signaturePath: `${ME}/${plainTalk.id}/2026-09-25-${input.clientId}-signature.png`,
      pdfPath: `${ME}/${plainTalk.id}/2026-09-25-${input.clientId}.pdf`,
    });
    // The PDF was built here, at the moment of signing.
    expect(pdf?.type).toBe("application/pdf");
    expect(await pdfHead(pdf)).toBe("%PDF-");
    // What the gates read back right away: signed, waiting to send.
    expect(view).toMatchObject({ id: `pending:${input.clientId}`, signed_at: now.toISOString(), pending: true, sendFailed: false });
  });

  it("gives every signature its own client id", async () => {
    await signToolboxTalk({ talk: plainTalk, profileId: ME, typedName: "Dana", signatureDataUrl: SIGNATURE });
    await signToolboxTalk({ talk: plainTalk, profileId: ME, typedName: "Dana", signatureDataUrl: SIGNATURE });
    expect(enqueued[0].input.clientId).not.toBe(enqueued[1].input.clientId);
  });

  it("builds the PDF for a talk with Do/Don't lists and a check mark in it, keeping the talk exactly as it was", async () => {
    const now = new Date(2026, 8, 25, 6, 55, 12);
    const drawn = await drawnWhile(() =>
      signToolboxTalk({ talk: doDontTalk, profileId: ME, typedName: "Dana Reyes", signatureDataUrl: SIGNATURE, now }),
    );
    expect(enqueued).toHaveLength(1);
    const { input, pdf } = enqueued[0];
    // The record keeps the talk exactly as it read: check marks and all.
    const snap = JSON.parse(input.talkSnapshot) as { title: string; sections: { dos: string[]; donts: string[] } };
    expect(snap.title).toBe("Glass handling ✓");
    expect(snap.sections.dos).toContain("Wear cut sleeves ✓");
    expect(snap.sections.donts).toContain("Don't carry it flat ✗");
    expect(input.signatureDataUrl).toBe(SIGNATURE);
    // And the PDF was built — this talk no longer falls back to signing
    // without one. The PDF and its path travel together.
    expect(pdf?.type).toBe("application/pdf");
    expect(await pdfHead(pdf)).toBe("%PDF-");
    expect(input.pdfPath).toBe(`${ME}/${doDontTalk.id}/2026-09-25-${input.clientId}.pdf`);
    // Drawn in characters the font has: + marks each Do, x each Don't, and
    // the check marks in the words read as + and x.
    expect(drawn.filter((s) => s === "+")).toHaveLength(2);
    expect(drawn.filter((s) => s === "x")).toHaveLength(2);
    expect(drawn).toContain("Glass handling +");
    expect(drawn).toContain("Carry glass on edge + never flat.");
    expect(drawn).toContain("Wear cut sleeves +");
    expect(drawn).toContain("Don't carry it flat x");
    expect(drawn).toContain("Signed by: Dana Reyes");
    expect(drawn.join(" ")).not.toMatch(/[✓✗]/);
  });

  it("builds the PDF even with a picture that is not one and a blank signature image", async () => {
    const badPicture: SafetyTalk = {
      ...plainTalk,
      // A visual aid that claims to be a PNG and is not one is drawn as its
      // prompt; a signature image that is not one prints a note in its place.
      // Both are the builder's own fallbacks — neither costs the PDF.
      visual_aids_json: [{ prompt: "diagram", url: "data:image/png;base64,bm90IGEgcG5n" }],
    };
    const now = new Date(2026, 8, 25, 6, 55, 12);
    const drawn = await drawnWhile(() =>
      signToolboxTalk({ talk: badPicture, profileId: ME, typedName: "Dana", signatureDataUrl: "data:image/png;base64,", now }),
    );
    expect(enqueued).toHaveLength(1);
    const { input, pdf } = enqueued[0];
    expect(input.typedName).toBe("Dana");
    expect(await pdfHead(pdf)).toBe("%PDF-");
    expect(input.pdfPath).toBe(`${ME}/${plainTalk.id}/2026-09-25-${input.clientId}.pdf`);
    expect(drawn).toContain("Diagram: diagram");
    expect(drawn).toContain("(signature image unavailable)");
  });

  it("signs without a PDF only when building one genuinely fails — the signature is never lost to it", async () => {
    vi.spyOn(PDFDocument, "create").mockRejectedValueOnce(new Error("Out of memory"));
    const now = new Date(2026, 8, 25, 6, 55, 12);
    const view = await signToolboxTalk({ talk: plainTalk, profileId: ME, typedName: "Dana Reyes", signatureDataUrl: SIGNATURE, now });
    expect(network).not.toHaveBeenCalled();
    expect(enqueued).toHaveLength(1);
    const { input, pdf } = enqueued[0];
    // No PDF, and no path naming a file that is not there: the row files
    // without one.
    expect(pdf).toBeNull();
    expect(input.pdfPath).toBeNull();
    // Everything else the record needs is still here.
    expect(input).toMatchObject({
      profileId: ME,
      talkId: plainTalk.id,
      typedName: "Dana Reyes",
      signedAt: now.toISOString(),
      talkSnapshot: talkSnapshot(plainTalk),
      signatureDataUrl: SIGNATURE,
      signaturePath: `${ME}/${plainTalk.id}/2026-09-25-${input.clientId}-signature.png`,
    });
    // Signed, waiting to send — the gates open just as they do with a PDF.
    expect(view).toMatchObject({ id: `pending:${input.clientId}`, pending: true, sendFailed: false });
  });
});
