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
  /**
   * Only render these 1-based pages. Used when retrying the pages whose vision
   * call failed — re-rendering a 6-page sheet to re-read one of them is wasted
   * time and memory on a phone.
   */
  pages?: number[];
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
 * Render up to `maxPages` pages to JPEG data URLs for the vision extractor, or
 * just the pages named in `opts.pages`. Sequential (canvas memory) and
 * best-effort: a page that fails to render is skipped (the deterministic text
 * path still covers it).
 */
export async function renderSpecPageImages(
  doc: PDFDocumentProxy,
  opts: RenderOptions = {},
): Promise<SpecPageImage[]> {
  const { maxPages = 12, pages, ...pageOpts } = opts;
  const out: SpecPageImage[] = [];
  const wanted = selectedPages(doc.numPages, maxPages, pages);
  for (const p of wanted) {
    try {
      out.push({ pageNumber: p, dataUrl: await renderPageJpeg(doc, p, pageOpts) });
    } catch {
      // Skip an unrenderable page; the text extractor still covers it.
    }
  }
  return out;
}

/**
 * Which 1-based pages to render: the explicit list (deduped, in order, and
 * clamped to pages the document actually has) or the first `maxPages`. PURE.
 */
export function selectedPages(
  numPages: number,
  maxPages: number,
  pages?: number[],
): number[] {
  if (pages && pages.length > 0) {
    const seen = new Set<number>();
    for (const p of pages) {
      if (Number.isInteger(p) && p >= 1 && p <= numPages) seen.add(p);
    }
    return [...seen].sort((a, b) => a - b).slice(0, maxPages);
  }
  const count = Math.min(numPages, maxPages);
  return Array.from({ length: Math.max(0, count) }, (_, i) => i + 1);
}
