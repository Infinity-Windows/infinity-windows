// The elevation drawing ("Outside View") for one mark, cropped live out of the
// project's specs planset and re-colored to white line-work on black.
//
// Nothing is stored as an image: the spec row only remembers WHICH page of the
// specs planset the drawing is on and WHERE on that page it sits (a normalized
// box from the same Claude VISION pass that read the spec table). This
// component renders that page with the app's existing pdf.js helper, crops the
// padded box, and runs the pixel transform in `lib/install/markDrawing`.
//
// Three things keep it cheap on a phone in the field:
//   • the PDF and each rendered page are cached at module scope, so a sheet
//     with a dozen marks renders the page ONCE and every card slices it;
//   • finished crops are cached too, so revisiting an opening is instant;
//   • nothing starts until the card is actually scrolled into view.
// Every failure path renders nothing — a missing drawing must never take a spec
// card down with it.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import { downloadPlanset, findSpecsPlanset, listPlansets } from "../../lib/install/api";
import type { Planset } from "../../lib/install/types";
import type { MarkSpec } from "../../lib/install/specs";
import {
  bboxToPixelRect,
  invertLineArt,
  padBbox,
  validateBbox,
  type Bbox,
} from "../../lib/install/markDrawing";

/**
 * Width the specs page is rasterized to. Big enough that one mark's slice
 * (roughly a tenth of the sheet) still reads when a crew member zooms it
 * full-screen, small enough that a single cached page canvas stays sane.
 */
const PAGE_RENDER_WIDTH = 2600;

/** Only ever hold a couple of pages/documents — these canvases are megabytes. */
const MAX_CACHED_DOCS = 2;
const MAX_CACHED_PAGES = 2;
/** Crops are small PNG data URLs; keep plenty so scrolling back is free. */
const MAX_CACHED_CROPS = 150;

const docCache = new Map<string, Promise<PDFDocumentProxy>>();
const pageCache = new Map<string, Promise<HTMLCanvasElement>>();
const cropCache = new Map<string, string>();

/** Drop oldest-inserted entries until the cache is back under `max`. */
function evict(cache: Map<string, unknown>, max: number): void {
  while (cache.size > max) {
    const oldest = cache.keys().next();
    if (oldest.done) return;
    cache.delete(oldest.value);
  }
}

async function getDoc(planset: Planset): Promise<PDFDocumentProxy> {
  const cached = docCache.get(planset.id);
  if (cached) return cached;

  const pending = (async () => {
    // Dynamic, like the planset viewer: pdf.js is a large dependency and must
    // stay out of the app shell.
    const { loadPdf } = await import("../../lib/install/pdf");
    return loadPdf(await downloadPlanset(planset));
  })();
  docCache.set(planset.id, pending);
  pending.catch(() => docCache.delete(planset.id));
  evict(docCache, MAX_CACHED_DOCS);
  return pending;
}

/** Render (once) the specs page every mark on that page will be sliced from. */
async function getPageCanvas(
  planset: Planset,
  pageNumber: number,
): Promise<HTMLCanvasElement> {
  const key = `${planset.id}:${pageNumber}:${PAGE_RENDER_WIDTH}`;
  const cached = pageCache.get(key);
  if (cached) return cached;

  const pending = (async () => {
    const { renderPageCanvas } = await import("../../lib/install/pdf");
    return renderPageCanvas(await getDoc(planset), pageNumber, PAGE_RENDER_WIDTH);
  })();
  pageCache.set(key, pending);
  pending.catch(() => pageCache.delete(key));
  evict(pageCache, MAX_CACHED_PAGES);
  return pending;
}

/** Slice the padded box out of the page and flip it to white-on-black. */
function cropDrawing(page: HTMLCanvasElement, bbox: Bbox): string {
  const rect = bboxToPixelRect(padBbox(bbox), page.width, page.height);
  const out = document.createElement("canvas");
  out.width = rect.width;
  out.height = rect.height;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("2d canvas unavailable");

  ctx.drawImage(
    page,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    0,
    0,
    rect.width,
    rect.height,
  );
  const pixels = ctx.getImageData(0, 0, rect.width, rect.height);
  invertLineArt(pixels.data);
  ctx.putImageData(pixels, 0, 0);
  return out.toDataURL("image/png");
}

async function markDrawingDataUrl(
  planset: Planset,
  pageNumber: number,
  bbox: Bbox,
): Promise<string> {
  const key = `${planset.id}:${pageNumber}:${bbox.join(",")}`;
  const cached = cropCache.get(key);
  if (cached) return cached;

  const url = cropDrawing(await getPageCanvas(planset, pageNumber), bbox);
  cropCache.set(key, url);
  evict(cropCache, MAX_CACHED_CROPS);
  return url;
}

interface MarkDrawingProps {
  spec: Pick<MarkSpec, "mark_code" | "image_page" | "image_bbox">;
  /** Project whose specs planset the drawing is cropped from. */
  projectId: string | null | undefined;
  /** Small thumbnail for dense lists (My Work rows). */
  compact?: boolean;
}

export function MarkDrawing({ spec, projectId, compact = false }: MarkDrawingProps) {
  const bboxKey = Array.isArray(spec.image_bbox) ? spec.image_bbox.join(",") : "";
  const bbox = useMemo(
    () => validateBbox(spec.image_bbox),
    // The array identity changes on every render; its contents don't.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bboxKey],
  );
  const page = spec.image_page;
  const locatable = Boolean(projectId) && bbox != null && page != null;

  const [visible, setVisible] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [magnified, setMagnified] = useState(false);
  const holderRef = useRef<HTMLDivElement | null>(null);

  // Don't touch the planset (a multi-megabyte download + render) until the card
  // is on screen. `rootMargin` starts it just before the crew scrolls to it.
  useEffect(() => {
    if (visible || !locatable) return;
    const el = holderRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible, locatable]);

  const plansets = useQuery({
    queryKey: ["plansets", projectId],
    queryFn: () => listPlansets(projectId!),
    enabled: Boolean(projectId) && visible && locatable,
  });
  const planset = plansets.data ? findSpecsPlanset(plansets.data) : null;

  useEffect(() => {
    if (!visible || !planset || !bbox || page == null) return;
    let cancelled = false;
    setFailed(false);
    void (async () => {
      try {
        const url = await markDrawingDataUrl(planset, page, bbox);
        if (!cancelled) setSrc(url);
      } catch {
        // A page that won't render, a planset we can't download offline, a
        // browser that won't give us pixels — show text only.
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, planset, page, bbox]);

  if (!locatable) return null;
  // No specs planset on this project (or the lookup failed) — nothing to crop.
  if (failed || (plansets.isFetched && !planset) || plansets.isError) return null;

  const height = compact ? 54 : 190;
  const label = `Elevation drawing for mark #${spec.mark_code}`;

  return (
    <>
      <div ref={holderRef} className="mark-drawing" style={{ marginTop: compact ? 4 : 8 }}>
        {!src ? (
          <div
            className="mark-drawing-skeleton"
            style={{ height }}
            aria-label={`${label} — loading`}
          />
        ) : compact ? (
          // My Work rows are themselves buttons/links, so the compact thumbnail
          // stays a plain image — no nested control, no full-screen view.
          <div className="mark-drawing-thumb" style={{ height, cursor: "inherit" }}>
            <img src={src} alt={label} />
          </div>
        ) : (
          <button
            type="button"
            className="mark-drawing-thumb"
            style={{ height }}
            onClick={() => {
              setMagnified(false);
              setZoomed(true);
            }}
            aria-label={`${label} — tap to enlarge`}
          >
            <img src={src} alt={label} />
          </button>
        )}
      </div>

      {zoomed && src && (
        <div
          className="photo-viewer-backdrop overlay-enter"
          role="dialog"
          aria-modal="true"
          onClick={() => setZoomed(false)}
        >
          <div className="photo-viewer" onClick={(e) => e.stopPropagation()}>
            <div className={`mark-drawing-full${magnified ? " magnified" : ""}`}>
              <img
                src={src}
                alt={label}
                onClick={() => setMagnified((m) => !m)}
              />
            </div>
            <div className="photo-viewer-info">
              <p className="photo-viewer-caption">Mark #{spec.mark_code} — outside view</p>
              <p className="muted">
                Tap the drawing to {magnified ? "zoom out" : "zoom in"}.
              </p>
            </div>
            <button
              type="button"
              className="action-btn photo-viewer-close"
              onClick={() => setZoomed(false)}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </>
  );
}
