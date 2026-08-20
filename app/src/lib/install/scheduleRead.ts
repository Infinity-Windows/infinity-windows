import type { PDFDocumentProxy } from "pdfjs-dist";
import { aiExtractSchedule } from "./api";
import { renderSpecPageImages } from "./renderSpecImages";
import { extractScheduleRows, type ScheduleRow } from "./extract";

export interface ScheduleReadResult {
  rows: ScheduleRow[];
  source: "vision" | "deterministic" | "ai" | "details" | "merged" | "none";
  /** Pages the vision read could not read even after a retry — say so, never
   *  silently under-count. */
  unreadPages: number[];
}

const mapAiRows = (
  aiRows: Awaited<ReturnType<typeof aiExtractSchedule>>["rows"],
): ScheduleRow[] =>
  aiRows.map((r) => ({
    openingCode: r.openingCode,
    typeText: r.typeText,
    qty: r.qty,
    label: r.label,
    pageNumber: r.pageNumber,
    widthIn: r.widthIn ?? null,
    heightIn: r.heightIn ?? null,
    color: r.color ?? null,
    kind: r.kind === "door" ? "door" : "window",
  }));

/**
 * VISION FIRST (the RAC-OAK-5 lesson, 2026-08-20). The old order —
 * deterministic text parse, AI-on-text only when the parse found nothing —
 * read a cut-sheet planset's elevation labels as quantities: mark 9 appeared
 * nine times across four elevations and became nine openings, while every
 * mark whose pictured cell didn't survive PDF text extraction vanished
 * (4-8, 10-12, 16, 17, 19 — including the job's biggest, #12 x8). On these
 * sheets the truth is VISUAL: one bordered cell per mark with a drawing and
 * a QTY field, and only such cells count. So the vision read goes first and
 * its rows win; the text paths remain the fallback for text-native schedule
 * tables and for docs where page rendering fails.
 *
 * Every schedule read in the app goes through here — upload, re-read, and
 * the map's Load marks — so the rule can't drift between paths.
 */
export async function readScheduleFromDoc(
  doc: PDFDocumentProxy,
  pages: { pageNumber: number; text: string }[],
  catalog: { type_code: string; name: string }[],
  onNote?: (note: string) => void,
): Promise<ScheduleReadResult> {
  let rows: ScheduleRow[] = [];
  let unreadPages: number[] = [];
  try {
    const pageImages = await renderSpecPageImages(doc, { maxPages: 24 });
    if (pageImages.length > 0) {
      const vision = await aiExtractSchedule(pages, catalog, pageImages);
      rows = mapAiRows(vision.rows);
      unreadPages = vision.failedPages;
    }
  } catch {
    // Rendering or the vision call failing must never cost the read —
    // the text paths below pull what they can.
  }
  if (rows.length > 0) return { rows, source: "vision", unreadPages };

  const textRead = await extractScheduleRows(pages, async (pgs) => {
    try {
      onNote?.("No schedule table found — checking PDF details…");
      return mapAiRows((await aiExtractSchedule(pgs, catalog)).rows);
    } catch {
      // A manufacturer detail PDF can be useful without containing a
      // schedule table. Keep it available in the 2D source viewer.
      return [];
    }
  });
  return { rows: textRead.rows, source: textRead.source, unreadPages };
}
