// Client-side PDF rendering and text extraction with pdf.js.
// Pages render to data-URL images for the project map background; text is
// reconstructed into lines (grouped by y position) for the schedule parser.
//
// Use the *legacy* build + worker so older Safari/Chrome (missing
// Map.prototype.getOrInsertComputed) can still open plansets.

import "../mapPolyfill";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type {
  PDFDocumentProxy,
  TextItem,
} from "pdfjs-dist/types/src/display/api";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import {
  parsePlanMarkAnnotation,
  markCentersAlongAnnotation,
  type PlanMarkCallout,
} from "./planMarks";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Map a PDF-user-space rect into normalized top-left page coordinates. */
function pdfRectToNormalized(
  rect: [number, number, number, number],
  viewport: { width: number; height: number; transform: number[] },
): { x1: number; y1: number; x2: number; y2: number } {
  const [a, b, c, d, e, f] = viewport.transform;
  const corners = [
    [rect[0], rect[1]],
    [rect[2], rect[1]],
    [rect[0], rect[3]],
    [rect[2], rect[3]],
  ].map(([x, y]) => [a * x + c * y + e, b * x + d * y + f] as const);
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  return {
    x1: left / viewport.width,
    y1: top / viewport.height,
    x2: right / viewport.width,
    y2: bottom / viewport.height,
  };
}

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

/**
 * Read numbered window/door marks from FreeText annotations on a marked
 * building plan. These callouts are often drawn as annotations (not page
 * text), which is why #6 ×12 shows on the sheet but not in getTextContent.
 * Coordinates are normalized 0–1 in the same top-left space as rendered page
 * images, so dots can sit exactly on the plan numbers while zooming.
 */
export async function extractPlanMarkCallouts(
  doc: PDFDocumentProxy,
): Promise<PlanMarkCallout[]> {
  const callouts: PlanMarkCallout[] = [];

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    let annotations: Awaited<ReturnType<typeof page.getAnnotations>>;
    try {
      annotations = await page.getAnnotations({ intent: "display" });
    } catch {
      continue;
    }

    for (const annotation of annotations) {
      if (annotation.subtype !== "FreeText") continue;
      const raw =
        (annotation as { contentsObj?: { str?: string }; contents?: string })
          .contentsObj?.str ??
        (annotation as { contents?: string }).contents ??
        "";
      const marks = parsePlanMarkAnnotation(raw);
      if (!marks?.length) continue;

      const rect = annotation.rect as [number, number, number, number];
      const box = pdfRectToNormalized(rect, viewport);
      const centers = markCentersAlongAnnotation(raw);
      marks.forEach((mark, index) => {
        const t =
          centers[index] ??
          (marks.length === 1 ? 0.5 : (index + 0.5) / marks.length);
        const x = Math.min(1, Math.max(0, box.x1 + (box.x2 - box.x1) * t));
        const y = Math.min(1, Math.max(0, (box.y1 + box.y2) / 2));
        callouts.push({ mark, pageNumber, x, y });
      });
    }
  }

  return callouts;
}
