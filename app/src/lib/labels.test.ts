// Printed labels still carry their QR codes now that the QR library is
// loaded the first time a label is printed, instead of riding in the chunk
// every phone downloads before its first screen (2026-09-25, see labels.ts).

import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { containerPostersPdf, locationLabelsPdf, packageLabelsPdf } from "./labels";

/** How many images each page of the PDF draws — the QR code is the only one. */
async function imagesPerPage(bytes: Uint8Array): Promise<number[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => {
    const images = page.node.Resources()?.lookupMaybe(PDFName.of("XObject"), PDFDict);
    return images ? images.keys().length : 0;
  });
}

describe("printed labels", () => {
  it("every package sticker and location label has its QR code", async () => {
    const stickers = await packageLabelsPdf([
      { serial: "PKG-000001", short_code: "7K2" },
      { serial: "PKG-000002", bindLine: "BLACK22 · Window 16 · 2 of 4" },
    ]);
    expect(await imagesPerPage(stickers)).toEqual([1, 1]);

    const locations = await locationLabelsPdf([
      { address: "A-01", zoneName: "Conex A", serial: "LOC-0001" },
    ]);
    expect(await imagesPerPage(locations)).toEqual([1]);
  });

  it("a conex poster has its QR code", async () => {
    const posters = await containerPostersPdf([{ serial: "CNX-0001", name: "Conex 1", address: "Tech Ridge" }]);
    expect(await imagesPerPage(posters)).toEqual([1]);
  });
});
