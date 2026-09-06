// A receipt that arrived as a PDF: page one becomes the receipt's picture, the
// page count becomes its note, and a file that will not open files nothing.
//
// These drive the REAL pdf.js parse against real PDF bytes — a one-page file, a
// three-page file, and a handful of things that are not PDFs at all — because
// the interesting failures (an encrypted file, a truncated download, a file
// that is a PDF in name only) are all decided inside the parse. Only the pixel
// step is stubbed: `getContext("2d")` answers null under happy-dom, so a real
// canvas render cannot happen here at all, and the seam that lets it be stubbed
// is exactly the one the module documents (PdfRenderDeps).
//
// pdf.js's worker URL has to be pointed at the package for the same reason:
// production resolves it through Vite's `?worker&url`, which in a test run
// names a path only the browser build would have.

import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  isPdfPick,
  PdfUnreadableError,
  receiptPdfNote,
  renderReceiptPdfPage1,
  type PdfRenderDeps,
} from "./receiptPdf";

/**
 * The smallest thing that is genuinely a PDF: a catalog, a page tree, and N
 * pages of a fixed size, written out with a real (if minimal) xref. Built
 * rather than committed as a binary so the page count is a knob a test can
 * turn, and so it stays readable — every byte here is why pdf.js accepts it.
 */
function tinyPdf(pageCount: number, width = 200, height = 100): string {
  const kids = Array.from({ length: pageCount }, (_, i) => `${3 + i} 0 R`).join(" ");
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    `<</Type/Pages/Kids[${kids}]/Count ${pageCount}>>`,
    ...Array.from(
      { length: pageCount },
      () => `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${width} ${height}]>>`,
    ),
  ];

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;

  // Returned as TEXT, not bytes: every byte of a PDF this small is ASCII, a
  // string is a BlobPart the DOM lib accepts without an ArrayBuffer cast, and
  // slicing it is how the truncated-download case below is built.
  return body;
}

/** The bytes as the phone would hand them over. */
function pdfBlob(text: string): Blob {
  return new Blob([text], { type: "application/pdf" });
}

const JPEG = new Blob(["not-really-a-jpeg"], { type: "image/jpeg" });

/** Real parse, stubbed pixels — see this file's header. */
async function deps(
  pageToJpeg: PdfRenderDeps["pageToJpeg"] = async () => JPEG,
): Promise<PdfRenderDeps> {
  const { loadPdf } = await import("../install/pdf");
  return { loadPdf, pageToJpeg };
}

beforeAll(async () => {
  // Order matters: lib/install/pdf.ts points `workerSrc` at Vite's
  // `?worker&url` build the moment it is imported, so the override has to come
  // after it or the module's own assignment lands last and wins.
  await import("../install/pdf");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
    import.meta.url,
  ).href;
});

describe("isPdfPick", () => {
  it("recognises the type the phone reports", () => {
    expect(isPdfPick({ type: "application/pdf", name: "receipt" })).toBe(true);
  });

  it("falls back to the name, because Drive and mail apps hand over typeless files", () => {
    expect(isPdfPick({ type: "", name: "shell-invoice.PDF" })).toBe(true);
    expect(isPdfPick({ name: "shell-invoice.pdf" })).toBe(true);
  });

  it("is false for a photo, whichever way it is asked", () => {
    expect(isPdfPick({ type: "image/jpeg", name: "IMG_0421.jpg" })).toBe(false);
    expect(isPdfPick({})).toBe(false);
  });
});

describe("receiptPdfNote", () => {
  it("says how many pages the original had, because the picture is only page one", () => {
    expect(receiptPdfNote(null, 3)).toBe("PDF, 3 pages");
  });

  it("counts one page in the singular", () => {
    expect(receiptPdfNote(null, 1)).toBe("PDF, 1 page");
  });

  it("never overwrites what the person typed", () => {
    expect(receiptPdfNote("Home Depot — shims", 4)).toBe("Home Depot — shims");
  });

  it("treats a note of only spaces as nothing typed", () => {
    expect(receiptPdfNote("   ", 2)).toBe("PDF, 2 pages");
  });

  it("leaves the note empty rather than write a page count it does not have", () => {
    expect(receiptPdfNote(null, 0)).toBeNull();
    expect(receiptPdfNote(null, Number.NaN)).toBeNull();
  });
});

describe("renderReceiptPdfPage1", () => {
  it("renders page one and reports how many pages there were", async () => {
    const seen: number[] = [];
    const page = await renderReceiptPdfPage1(
      pdfBlob(tinyPdf(3)),
      await deps(async (_doc, pageNumber) => {
        seen.push(pageNumber);
        return JPEG;
      }),
    );
    expect(page.pageCount).toBe(3);
    expect(page.blob).toBe(JPEG);
    // Page ONE is the automatic read — never page two, never all of them.
    expect(seen).toEqual([1]);
  });

  it("scales the LONG edge to 1280 on a landscape page", async () => {
    let width = 0;
    await renderReceiptPdfPage1(
      pdfBlob(tinyPdf(1, 400, 200)),
      await deps(async (_doc, _page, targetWidth) => {
        width = targetWidth;
        return JPEG;
      }),
    );
    expect(width).toBe(1280);
  });

  it("scales the long edge on a till-roll page too, so the width comes out narrower", async () => {
    let width = 0;
    await renderReceiptPdfPage1(
      pdfBlob(tinyPdf(1, 200, 400)),
      await deps(async (_doc, _page, targetWidth) => {
        width = targetWidth;
        return JPEG;
      }),
    );
    // 1280 tall, so half as wide — a tall receipt stays legible instead of
    // being blown up to 1280 across and losing its height to the ceiling.
    expect(width).toBe(640);
  });

  it("refuses a file that is not a PDF at all, in one sentence", async () => {
    const err = await renderReceiptPdfPage1(
      new Blob(["this is a text file"], { type: "application/pdf" }),
      await deps(),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PdfUnreadableError);
    expect((err as Error).message).toBe(
      "That PDF couldn't be opened — it may be password-protected or damaged. " +
        "Try saving it again, or take a photo of the receipt.",
    );
  });

  it("refuses a truncated download the same way", async () => {
    const full = tinyPdf(2);
    const half = full.slice(0, Math.floor(full.length / 2));
    await expect(
      renderReceiptPdfPage1(pdfBlob(half), await deps()),
    ).rejects.toBeInstanceOf(PdfUnreadableError);
  });

  it("refuses when the render comes back with nothing, rather than file an empty picture", async () => {
    await expect(
      renderReceiptPdfPage1(
        pdfBlob(tinyPdf(1)),
        await deps(async () => null),
      ),
    ).rejects.toBeInstanceOf(PdfUnreadableError);
  });

  it("turns a render that throws into the same one sentence", async () => {
    await expect(
      renderReceiptPdfPage1(
        pdfBlob(tinyPdf(1)),
        await deps(async () => {
          throw new Error("CanvasRenderingContext2D is not a thing here");
        }),
      ),
    ).rejects.toBeInstanceOf(PdfUnreadableError);
  });

  it("refuses a document with no pages", async () => {
    // pdf.js will not produce one of these from real bytes, so the guard is
    // proven against a stubbed loader — it exists because `numPages` is a
    // number off a file we did not write.
    const emptyDoc = { numPages: 0 } as unknown as Awaited<
      ReturnType<PdfRenderDeps["loadPdf"]>
    >;
    await expect(
      renderReceiptPdfPage1(pdfBlob(tinyPdf(1)), {
        loadPdf: async () => emptyDoc,
        pageToJpeg: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(PdfUnreadableError);
  });
});
