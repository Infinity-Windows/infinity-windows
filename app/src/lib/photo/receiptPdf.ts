// A receipt that arrived as a PDF — the emailed fuel invoice, the supply-house
// statement, the Home Depot receipt that came as an attachment rather than a
// slip of paper. The receipt picker accepts one now; this is what turns it into
// something the rest of the app already knows how to handle.
//
// THE WHOLE IDEA: render PAGE ONE on the phone and file THAT as the receipt's
// photo (receipts/<id>.jpg). extract-receipt reads it, the feed shows it as a
// thumbnail, the office table shows it in the row — none of them learn a new
// shape. The original PDF rides along beside it (receipts/<id>.pdf) so the
// document a bookkeeper actually needs is never lost; see receiptDocumentPath.
//
// pdf.js is reached through lib/install/pdf.ts — the ONE place the worker is
// wired up (and the polyfills WebKit needs installed before it). There must
// never be a second worker: two copies of pdf.js on one page means two workers,
// two megabytes, and two chances for the iPhone flate bug to come back. It is
// imported dynamically for the same reason every planset screen does it: this
// module is reachable from the capture sheet, which is in the main bundle, and
// pdf.js is not something an installer should download to take a photo.

import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";

/**
 * Longest edge of the rendered page, and its JPEG quality — the same numbers a
 * snapped receipt is compressed to (see JobPhotoCapture). A receipt only has to
 * be legible to Claude vision and to a human zooming in on a line item.
 */
export const RECEIPT_PDF_LONG_EDGE = 1280;
export const RECEIPT_PDF_QUALITY = 0.82;

/**
 * A PDF that will not open: encrypted, damaged, or carrying no pages at all.
 *
 * Nothing is filed when this is thrown — a receipt row pointing at a picture
 * that was never made is worse than no row, because the office would see a
 * broken thumbnail and have no idea what was supposed to be there.
 *
 * The message here is the English half of `photo.pdfUnreadable`; the capture
 * sheet shows the catalog's copy so a Spanish-reading installer gets Spanish.
 * It is spelled out here too so a stray `formatApiError` on this error still
 * says something a person can act on.
 */
export class PdfUnreadableError extends Error {
  constructor() {
    super(
      "That PDF couldn't be opened — it may be password-protected or damaged. " +
        "Try saving it again, or take a photo of the receipt.",
    );
    this.name = "PdfUnreadableError";
  }
}

/** Is this pick a PDF? Trusts the type the phone reports, then the name — a
 * file handed over by Drive or a mail app sometimes arrives typeless. */
export function isPdfPick(file: { type?: string; name?: string }): boolean {
  const type = (file.type ?? "").toLowerCase();
  if (type === "application/pdf" || type === "application/x-pdf") return true;
  return (file.name ?? "").toLowerCase().endsWith(".pdf");
}

/**
 * What the receipt's note should say.
 *
 * A typed note always wins — the person told us what this was, and overwriting
 * that with a fact they can see for themselves would be rude. With nothing
 * typed, the note carries the one thing the rendered image cannot: how many
 * pages the original had. Page one is what the machine read; "PDF, 3 pages"
 * is how the office finds out there are two more in the original.
 */
export function receiptPdfNote(typed: string | null, pageCount: number): string | null {
  const trimmed = typed?.trim();
  if (trimmed) return trimmed;
  if (!Number.isFinite(pageCount) || pageCount < 1) return null;
  return pageCount === 1 ? "PDF, 1 page" : `PDF, ${pageCount} pages`;
}

export interface ReceiptPdfPage {
  /** Page one as a JPEG — this becomes the receipt's photo_path. */
  blob: Blob;
  /** How many pages the original had. Goes in the note; see receiptPdfNote. */
  pageCount: number;
}

/**
 * The two steps that touch pdf.js, behind a seam.
 *
 * `pageToJpeg` is separate because it is the half that needs a real canvas: in
 * jsdom `getContext("2d")` answers null, so a test can drive the REAL parse
 * (page counts, a damaged file, an empty one) against a real PDF and stub only
 * the pixels — the same split stampPhoto's own tests rely on.
 */
export interface PdfRenderDeps {
  loadPdf(data: ArrayBuffer): Promise<PDFDocumentProxy>;
  pageToJpeg(
    doc: PDFDocumentProxy,
    pageNumber: number,
    targetWidth: number,
    quality: number,
  ): Promise<Blob | null>;
}

async function defaultDeps(): Promise<PdfRenderDeps> {
  const pdf = await import("../install/pdf");
  return {
    loadPdf: pdf.loadPdf,
    async pageToJpeg(doc, pageNumber, targetWidth, quality) {
      const canvas = await pdf.renderPageCanvas(doc, pageNumber, targetWidth);
      return new Promise<Blob | null>((resolve) => {
        canvas.toBlob((b) => resolve(b), "image/jpeg", quality);
      });
    },
  };
}

/**
 * Render page one of a PDF receipt to a JPEG, and say how many pages it had.
 *
 * Every failure lands as PdfUnreadableError — a password prompt pdf.js cannot
 * answer, a truncated download, a file that is a PDF in name only. The caller
 * files nothing and says one sentence.
 */
export async function renderReceiptPdfPage1(
  file: Blob,
  deps?: PdfRenderDeps,
): Promise<ReceiptPdfPage> {
  const d = deps ?? (await defaultDeps());
  let doc: PDFDocumentProxy;
  try {
    // A fresh copy of the bytes: pdf.js transfers the buffer it is handed to
    // its worker, which detaches it — and the SAME File is uploaded again a
    // moment later as the original document.
    doc = await d.loadPdf(await file.arrayBuffer());
  } catch {
    throw new PdfUnreadableError();
  }

  try {
    const pageCount = doc.numPages;
    if (!pageCount || pageCount < 1) throw new PdfUnreadableError();

    // Scale to the LONG edge, whichever way the page is turned: a receipt
    // printed on a wide invoice sheet and one printed on a till roll should
    // both come out legible, and renderPageCanvas only speaks in widths.
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const targetWidth =
      base.width >= base.height
        ? RECEIPT_PDF_LONG_EDGE
        : Math.max(1, Math.round((RECEIPT_PDF_LONG_EDGE * base.width) / base.height));

    const blob = await d.pageToJpeg(doc, 1, targetWidth, RECEIPT_PDF_QUALITY);
    if (!blob || blob.size === 0) throw new PdfUnreadableError();
    return { blob, pageCount };
  } catch (e) {
    if (e instanceof PdfUnreadableError) throw e;
    throw new PdfUnreadableError();
  }
}
