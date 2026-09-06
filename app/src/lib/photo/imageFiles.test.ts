// The file types a phone's library door will really hand back.
//
// The case that matters is the PDF: a packing slip or a spec sheet, sitting in
// the Files app next to the photos, one tap away from the same picker. Before
// the library door existed this could not happen — `capture="environment"`
// meant a camera and nothing else — so the check is new work, not a formality.

import { describe, expect, it } from "vitest";
import { imageFilesOnly } from "./imageFiles";

function file(name: string, type: string): File {
  return new File(["x"], name, { type });
}

describe("imageFilesOnly", () => {
  it("keeps the photos a camera or a library hands back", () => {
    const files = [file("a.jpg", "image/jpeg"), file("b.png", "image/png")];
    expect(imageFilesOnly(files)).toEqual(files);
  });

  it("drops the packing-slip PDF the Files app offers beside them", () => {
    const pdf = file("packing-slip.pdf", "application/pdf");
    expect(imageFilesOnly([pdf])).toEqual([]);
  });

  it("keeps the photos and drops the rest out of a mixed pick", () => {
    const photo = file("wall.jpg", "image/jpeg");
    const kept = imageFilesOnly([
      file("spec.pdf", "application/pdf"),
      photo,
      file("notes.txt", "text/plain"),
    ]);
    expect(kept).toEqual([photo]);
  });

  it("drops a file the phone could not identify at all", () => {
    // An empty `type` is what a half-synced iCloud placeholder or an unknown
    // extension arrives as. It will not render as a photo either.
    expect(imageFilesOnly([file("IMG_0421", "")])).toEqual([]);
  });

  it("keeps a HEIC, which is a picture even where it cannot be shown", () => {
    // Whether THIS browser can decode it is the capture sheet's question, and
    // it asks it separately. Here it is a picture and stays one.
    const heic = file("IMG_0422.HEIC", "image/heic");
    expect(imageFilesOnly([heic])).toEqual([heic]);
  });

  it("has nothing to say about an empty pick", () => {
    expect(imageFilesOnly([])).toEqual([]);
  });
});
