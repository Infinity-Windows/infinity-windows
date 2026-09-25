// Label and poster words the built-in font cannot draw.
//
// Container names, rack addresses and display names are typed by people, and
// pdf-lib's built-in Helvetica only has the WinAnsi characters. An emoji or an
// arrow in any of them failed the whole print with "WinAnsi cannot encode", the
// same bug that stopped toolbox talks being signed (lib/pdfText.ts). These
// build the real PDFs with real pdf-lib and the real QR library.
//
// The words are made drawable; the QR code is not touched. A scan looks up
// exactly what the QR carries, so it must stay the value as typed.

import { afterEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, PDFPage, StandardFonts } from "pdf-lib";
import { encodeContainerSerialQr, encodeLocationQr } from "./qr";

/** Every payload handed to the QR library, with the real library still drawing it. */
const qr = vi.hoisted(() => ({ payloads: [] as string[] }));
vi.mock("qrcode", async (importOriginal) => {
  const mod = (await importOriginal()) as { default?: unknown };
  const real = (mod.default ?? mod) as {
    toDataURL: (payload: string, opts: unknown) => Promise<string>;
  };
  return {
    default: {
      ...real,
      toDataURL: (payload: string, opts: unknown) => {
        qr.payloads.push(payload);
        return real.toDataURL(payload, opts);
      },
    },
  };
});

import { containerPostersPdf, locationLabelsPdf, packageLabelsPdf } from "./labels";

/** Every string handed to page.drawText while `build` ran, whitespace runs folded. */
async function drawnWhile(build: () => Promise<Uint8Array>) {
  const spy = vi.spyOn(PDFPage.prototype, "drawText");
  const bytes = await build();
  const raw = spy.mock.calls.map((c) => String(c[0]));
  return { bytes, raw, drawn: raw.map((s) => s.replace(/\s+/g, " ").trim()) };
}

async function drawableByHelvetica(strings: string[]): Promise<string[]> {
  const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
  const charset = new Set(font.getCharacterSet());
  return [...strings.join("")].filter((ch) => !charset.has(ch.codePointAt(0)!));
}

afterEach(() => {
  qr.payloads = [];
  vi.restoreAllMocks();
});

describe("label text the built-in font cannot draw", () => {
  it("a conex poster prints a name and an address with an emoji and an arrow", async () => {
    const { bytes, raw, drawn } = await drawnWhile(() =>
      containerPostersPdf([
        {
          serial: "CNX-0007",
          name: "Conex 7 🚚 → Yard B",
          address: "Tech Ridge Lot 1.2 → north gate 👷‍♀️",
        },
      ]),
    );

    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    expect(drawn).toContain("Conex 7 -> Yard B");
    expect(drawn).toContain("Tech Ridge Lot 1.2 -> north gate");
    expect(drawn).toContain("CNX-0007");
    expect(await drawableByHelvetica(raw)).toEqual([]);
    // The QR still opens the container it always did.
    expect(qr.payloads).toEqual([encodeContainerSerialQr("CNX-0007")]);
  });

  it("a location label prints an address and a display name the same way", async () => {
    const address = "Rack A → shelf 2 📦";
    const { raw, drawn } = await drawnWhile(() =>
      locationLabelsPdf([
        { address, zoneName: "Stock ≥ 40 tubes", display_name: "Caulk 🧴 bins → north wall" },
      ]),
    );

    expect(drawn).toContain("Rack A -> shelf 2");
    expect(drawn).toContain("Caulk bins -> north wall");
    expect(drawn).toContain("Stock >= 40 tubes");
    expect(await drawableByHelvetica(raw)).toEqual([]);
    // A label with no serial yet carries the address in its QR: as typed, arrow
    // and emoji included, so a scan still finds the rack it was printed for.
    expect(qr.payloads).toEqual([encodeLocationQr(address)]);
  });

  it("a package sticker prints its job line the same way, and keeps Spanish", async () => {
    const { raw, drawn } = await drawnWhile(() =>
      packageLabelsPdf([{ serial: "PKG-000031", bindLine: "Peñasco → Ventana 16 · 2 of 4 ✅" }]),
    );

    expect(drawn).toContain("PKG-000031");
    expect(drawn).toContain("Peñasco -> Ventana 16 · 2 of 4");
    expect(await drawableByHelvetica(raw)).toEqual([]);
  });
});
