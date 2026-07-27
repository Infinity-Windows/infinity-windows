// Render specs-planset pages to downscaled JPEG data URLs for Claude VISION.
//
// Manufacturer shop drawings (STRATA-style) draw the per-mark spec table into
// the PDF as an image, so the selectable text layer can't recover
// style/glass/color — but Claude reads the rendered page perfectly. We render
// each page at ~`dpi` (text must stay legible to transcribe) but clamp the
// longest edge to `maxEdge` so a big D-size sheet can't blow up the canvas or
// the request payload (Anthropic downscales past ~1568px anyway). JPEG at
// ~`quality` keeps the base64 body small. Kept in its own module (not pdf.ts)
// so the vision feature owns its rendering surface end-to-end.

import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";

export interface SpecPageImage {
  pageNumber: number;
  /** `data:image/jpeg;base64,…` render of the page. */
  dataUrl: string;
}

interface RenderOptions {
  dpi?: number;
  quality?: number;
  maxEdge?: number;
  maxPages?: number;
}

/** Render one page (1-based) to a downscaled JPEG data URL. */
export async function renderPageJpeg(
  doc: PDFDocumentProxy,
  pageNumber: number,
  { dpi = 180, quality = 0.7, maxEdge = 2200 }: RenderOptions = {},
): Promise<string> {
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  let scale = dpi / 72;
  const longest = Math.max(base.width, base.height) * scale;
  if (longest > maxEdge) scale *= maxEdge / longest;
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d")!;
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;

  return canvas.toDataURL("image/jpeg", quality);
}

/**
 * Render up to `maxPages` pages to JPEG data URLs for the vision extractor.
 * Sequential (canvas memory) and best-effort: a page that fails to render is
 * skipped (the deterministic text path still covers it).
 */
export async function renderSpecPageImages(
  doc: PDFDocumentProxy,
  opts: RenderOptions = {},
): Promise<SpecPageImage[]> {
  const { maxPages = 12, ...pageOpts } = opts;
  const out: SpecPageImage[] = [];
  const count = Math.min(doc.numPages, maxPages);
  for (let p = 1; p <= count; p++) {
    try {
      out.push({ pageNumber: p, dataUrl: await renderPageJpeg(doc, p, pageOpts) });
    } catch {
      // Skip an unrenderable page; the text extractor still covers it.
    }
  }
  return out;
}
