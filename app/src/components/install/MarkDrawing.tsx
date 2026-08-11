// The FULL specs-planset page a mark's spec was read from, re-colored to
// white line-work on black.
//
// This used to crop one mark's drawing out of the sheet. Owner call
// (2026-08-10): show the whole page instead and let the installer navigate —
// the neighboring marks on the sheet are exactly what a crew member uses to
// confirm they're holding the right window, and a crop can only ever show a
// guessed rectangle. `lib/install/drawingCrops` renders and caches the page —
// in memory and in IndexedDB, so a reload doesn't re-download a 2MB planset.
//
// Two guardrails carry over from the crop era:
//   • nothing starts until the card is actually scrolled into view;
//   • a page number measured against a DIFFERENT specs planset is not
//     rendered at all. A missing picture is harmless; a confident picture of
//     the wrong sheet is not.
// Every failure path renders nothing — a missing drawing must never take a
// spec card down with it, and the spec TEXT always survives.

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { findSpecsPlanset, listPlansets } from "../../lib/install/api";
import { specsPageDataUrl } from "../../lib/install/drawingCrops";
import { SheetZoomViewer } from "./SheetZoomViewer";
import type { MarkSpec } from "../../lib/install/specs";
import { isDrawingStale } from "../../lib/install/markDrawing";

interface MarkDrawingProps {
  spec: Pick<MarkSpec, "mark_code" | "image_page" | "image_bbox" | "planset_id">;
  /** Project whose specs planset the page is rendered from. */
  projectId: string | null | undefined;
  /** Small thumbnail for dense lists (My Work rows). */
  compact?: boolean;
}

export function MarkDrawing({ spec, projectId, compact = false }: MarkDrawingProps) {
  const page = spec.image_page;
  const locatable = Boolean(projectId) && page != null;

  const [visible, setVisible] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);
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

  // The page number was measured against one specific file. If the project's
  // specs planset has since been replaced, the same page of the new file may
  // be a different sheet entirely, so we show nothing.
  const stale = planset ? isDrawingStale(spec, planset.id) : false;

  useEffect(() => {
    if (!visible || !planset || page == null || stale) return;
    let cancelled = false;
    setFailed(false);
    void (async () => {
      try {
        const url = await specsPageDataUrl({ planset, pageNumber: page });
        if (cancelled) return;
        setSrc(url);
      } catch {
        // A page that won't render, a planset we can't download offline, a
        // browser that won't give us pixels — show text only.
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, planset, page, stale, spec.mark_code]);

  if (!locatable || stale) return null;
  // No specs planset on this project (or the lookup failed) — nothing to show.
  if (failed || (plansets.isFetched && !planset) || plansets.isError) return null;

  const height = compact ? 54 : 230;
  const label = `Spec sheet page ${page} for mark #${spec.mark_code}`;

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
            onClick={() => setZoomed(true)}
            aria-label={`${label} — tap to open the full sheet`}
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
            <SheetZoomViewer src={src} alt={label} />
            <div className="photo-viewer-info">
              <p className="photo-viewer-caption">
                Spec sheet · page {page} — find mark #{spec.mark_code}
              </p>
              <p className="muted">
                Pinch or scroll to zoom · drag to move · double-tap a detail
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
