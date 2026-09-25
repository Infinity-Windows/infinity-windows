// Signing today's toolbox talk (offline toolbox signing, 2026-09-25): ONE
// path, through the phone's outbox, whether or not there is signal. The PDF is
// built right here, at the moment of signing, so the record is exactly what
// was signed; the outbox sends it when it can. What this pins:
//   * the signature, the typed name, the talk as it was, the signing time and
//     the PDF all ride in one queued entry, keyed by a fresh client id, with
//     files at paths made from that id;
//   * nothing here touches the network — no upload, no insert;
//   * a talk whose PDF the phone cannot build still signs: the signature is
//     never lost to the PDF.

import { beforeEach, describe, expect, it, vi } from "vitest";
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
// mark in the words themselves. The PDF's standard fonts cannot draw every
// character a talk can hold, and a signature must not depend on that.
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
    const head = new TextDecoder().decode(new Uint8Array(await pdf!.arrayBuffer()).slice(0, 5));
    expect(head).toBe("%PDF-");
    // What the gates read back right away: signed, waiting to send.
    expect(view).toMatchObject({ id: `pending:${input.clientId}`, signed_at: now.toISOString(), pending: true, sendFailed: false });
  });

  it("gives every signature its own client id", async () => {
    await signToolboxTalk({ talk: plainTalk, profileId: ME, typedName: "Dana", signatureDataUrl: SIGNATURE });
    await signToolboxTalk({ talk: plainTalk, profileId: ME, typedName: "Dana", signatureDataUrl: SIGNATURE });
    expect(enqueued[0].input.clientId).not.toBe(enqueued[1].input.clientId);
  });

  it("signs a talk with Do/Don't lists and a check mark in it, keeping the talk exactly as it was", async () => {
    await signToolboxTalk({ talk: doDontTalk, profileId: ME, typedName: "Dana Reyes", signatureDataUrl: SIGNATURE });
    expect(enqueued).toHaveLength(1);
    const { input, pdf } = enqueued[0];
    const snap = JSON.parse(input.talkSnapshot) as { title: string; sections: { dos: string[]; donts: string[] } };
    expect(snap.title).toBe("Glass handling ✓");
    expect(snap.sections.dos).toContain("Wear cut sleeves ✓");
    expect(snap.sections.donts).toContain("Don't carry it flat ✗");
    expect(input.signatureDataUrl).toBe(SIGNATURE);
    // The PDF and its path travel together: both, or — when the phone could
    // not build one — neither, and the row files without a PDF.
    expect(input.pdfPath === null).toBe(pdf === null);
  });

  it("still signs when the PDF cannot be built at all", async () => {
    const broken: SafetyTalk = {
      ...plainTalk,
      // A visual aid that claims to be a PNG and is not one is skipped by the
      // builder; a signature image that is not one is the builder's own
      // fallback. What must never happen is the throw reaching the person.
      visual_aids_json: [{ prompt: "diagram", url: "data:image/png;base64,bm90IGEgcG5n" }],
    };
    await signToolboxTalk({ talk: broken, profileId: ME, typedName: "Dana", signatureDataUrl: "data:image/png;base64," });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].input.typedName).toBe("Dana");
  });
});
