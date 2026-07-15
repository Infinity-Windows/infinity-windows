// Client-side PDF rendering and text extraction with pdf.js.
// Pages render to data-URL images for the project map background; text is
// reconstructed into lines (grouped by y position) for the schedule parser.

import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, TextItem } from "pdfjs-dist/types/src/display/api";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export async function loadPdf(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  return pdfjs.getDocument({ data }).promise;
}

/** Render one page (1-based) to a PNG data URL sized for phone screens. */
export async function renderPageImage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  targetWidth = 1600,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = targetWidth / base.width;
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d")!;
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;

  return {
    dataUrl: canvas.toDataURL("image/png"),
    width: canvas.width,
    height: canvas.height,
  };
}

/**
 * Extract text as lines. pdf.js returns positioned fragments; we group them
 * into rows by y coordinate and order by x, separating far-apart fragments
 * with double spaces so the schedule parser can split columns.
 */
export async function extractPageText(
  doc: PDFDocumentProxy,
  pageNumber: number,
): Promise<string> {
  const page = await doc.getPage(pageNumber);
  const content = await page.getTextContent();

  const frags: { x: number; y: number; text: string; width: number }[] = [];
  for (const item of content.items) {
    const t = item as TextItem;
    if (!t.str || !t.str.trim()) continue;
    frags.push({
      x: t.transform[4],
      y: t.transform[5],
      text: t.str,
      width: t.width,
    });
  }

  // Group into lines: same row when y is within 3 units.
  const lines: { y: number; frags: typeof frags }[] = [];
  for (const f of frags.sort((a, b) => b.y - a.y || a.x - b.x)) {
    const line = lines.find((l) => Math.abs(l.y - f.y) < 3);
    if (line) line.frags.push(f);
    else lines.push({ y: f.y, frags: [f] });
  }

  return lines
    .map((line) => {
      const sorted = line.frags.sort((a, b) => a.x - b.x);
      let out = "";
      let prevEnd = 0;
      for (const f of sorted) {
        if (out) out += f.x - prevEnd > 8 ? "  " : " ";
        out += f.text;
        prevEnd = f.x + f.width;
      }
      return out;
    })
    .join("\n");
}

export async function extractAllText(
  doc: PDFDocumentProxy,
): Promise<{ pageNumber: number; text: string }[]> {
  const pages: { pageNumber: number; text: string }[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    pages.push({ pageNumber: p, text: await extractPageText(doc, p) });
  }
  return pages;
}
