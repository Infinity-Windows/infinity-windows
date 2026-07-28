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

/**
 * Render one page (1-based) onto a canvas scaled to `targetWidth`. Callers that
 * want to read pixels back (the mark-drawing crop) need the canvas itself, not
 * a data URL, so this is the primitive and `renderPageImage` wraps it.
 */
export async function renderPageCanvas(
  doc: PDFDocumentProxy,
  pageNumber: number,
  targetWidth = 1600,
): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = targetWidth / base.width;
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d")!;
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;

  return canvas;
}

/** Render one page (1-based) to a PNG data URL sized for phone screens. */
export async function renderPageImage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  targetWidth = 1600,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const canvas = await renderPageCanvas(doc, pageNumber, targetWidth);
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

/** Same row when two fragments sit this close vertically (fraction of page). */
const LINE_TOLERANCE = 0.004;
/** A gap this wide (fraction of page) ends a run of text. */
const SEGMENT_GAP = 0.02;

/**
 * Page text as positioned RUNS, in the same normalized top-left space as the
 * rendered page image and the mark callouts.
 *
 * `extractPageText` deliberately groups fragments by their raw PDF y, which is
 * all the schedule parser needs — but on a rotated sheet (Black Desert's plans
 * are all /Rotate 270) raw y runs across the screen, so those "lines" are
 * columns and carry no usable position. The elevation reference needs to know
 * WHERE a drawing's caption sits to work out which drawing a callout belongs to,
 * so this walks the viewport-transformed coordinates instead.
 *
 * Fragments are joined only while they stay adjacent: a caption is a contiguous
 * run ("FRONT" + "RIGHT COURTYARD ELEVETAION" is one caption drawn in two
 * pieces), whereas text far away on the same row is a different thing entirely
 * and joining them would produce a line that reads like neither.
 */
export async function extractSheetTextLines(
  doc: PDFDocumentProxy,
): Promise<{ pageNumber: number; text: string; x: number; y: number }[]> {
  const out: { pageNumber: number; text: string; x: number; y: number }[] = [];

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const [a, b, c, d, e, f] = viewport.transform;
    let content: Awaited<ReturnType<typeof page.getTextContent>>;
    try {
      content = await page.getTextContent();
    } catch {
      continue;
    }

    const frags: { x: number; y: number; w: number; text: string }[] = [];
    for (const item of content.items) {
      const t = item as TextItem;
      if (!t.str || !t.str.trim()) continue;
      const px = a * t.transform[4] + c * t.transform[5] + e;
      const py = b * t.transform[4] + d * t.transform[5] + f;
      frags.push({
        x: px / viewport.width,
        y: py / viewport.height,
        w: Math.abs(t.width) / viewport.width,
        text: t.str.trim(),
      });
    }

    const rows: { y: number; frags: typeof frags }[] = [];
    for (const frag of frags.sort((p, q) => p.y - q.y || p.x - q.x)) {
      const row = rows.find((r) => Math.abs(r.y - frag.y) < LINE_TOLERANCE);
      if (row) row.frags.push(frag);
      else rows.push({ y: frag.y, frags: [frag] });
    }

    for (const row of rows) {
      const sorted = row.frags.sort((p, q) => p.x - q.x);
      let run: typeof frags = [];
      const flush = () => {
        if (run.length === 0) return;
        out.push({
          pageNumber,
          text: run.map((r) => r.text).join(" "),
          x: run[0].x,
          y: row.y,
        });
        run = [];
      };
      for (const frag of sorted) {
        const prev = run[run.length - 1];
        if (prev && frag.x - (prev.x + prev.w) > SEGMENT_GAP) flush();
        run.push(frag);
      }
      flush();
    }
  }

  return out;
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
      // How big the drawn number itself is: one annotation can hold several
      // ("2  2" over a pair of identical windows), so its width is shared out.
      // The elevation reference rings the number with this, rather than guessing
      // a radius that would sometimes swallow the window next door.
      const labelW = (box.x2 - box.x1) / marks.length;
      const labelH = box.y2 - box.y1;
      marks.forEach((mark, index) => {
        const t =
          centers[index] ??
          (marks.length === 1 ? 0.5 : (index + 0.5) / marks.length);
        const x = Math.min(1, Math.max(0, box.x1 + (box.x2 - box.x1) * t));
        const y = Math.min(1, Math.max(0, (box.y1 + box.y2) / 2));
        callouts.push({ mark, pageNumber, x, y, labelW, labelH });
      });
    }
  }

  return callouts;
}
