// The elevation drawing ("Outside View") for one mark, cropped live out of the
// project's specs planset and re-colored to white line-work on black.
//
// Nothing is stored as an image: the spec row only remembers WHICH specs planset
// the drawing came from, which page it's on, and where on that page it sits (a
// normalized box from the same Claude VISION pass that read the spec table).
// `lib/install/drawingCrops` turns that into a picture and caches it — in memory
// and in IndexedDB, so a reload doesn't re-download a 2MB planset to redraw one
// small drawing.
//
// Two guardrails matter here:
//   • nothing starts until the card is actually scrolled into view;
//   • a drawing whose coordinates were measured against a DIFFERENT specs
//     planset is not rendered at all. A missing picture is harmless; a
//     confident picture of the wrong window is not.
// Every failure path renders nothing — a missing drawing must never take a spec
// card down with it, and the spec TEXT always survives.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { findSpecsPlanset, listPlansets } from "../../lib/install/api";
import { markDrawingDataUrl } from "../../lib/install/drawingCrops";
import type { MarkSpec } from "../../lib/install/specs";
import { isDrawingStale, validateBbox } from "../../lib/install/markDrawing";

interface MarkDrawingProps {
  spec: Pick<MarkSpec, "mark_code" | "image_page" | "image_bbox" | "planset_id">;
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

  // The box was measured against one specific file. If the project's specs
  // planset has since been replaced, cropping the same box out of the new one
  // yields a real-looking drawing of the wrong unit, so we show nothing.
  const stale = planset ? isDrawingStale(spec, planset.id) : false;

  useEffect(() => {
    if (!visible || !planset || !bbox || page == null || stale) return;
    let cancelled = false;
    setFailed(false);
    void (async () => {
      try {
        const url = await markDrawingDataUrl({
          planset,
          pageNumber: page,
          bbox,
          markCode: spec.mark_code,
        });
        if (cancelled) return;
        // Null means the sheet has no drawing to show for this mark — a blank
        // panel, or a box we couldn't rescue. Same outcome as a failure: the
        // spec text stands on its own rather than carrying a black rectangle.
        if (url) setSrc(url);
        else setFailed(true);
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
  }, [visible, planset, page, bbox, stale, spec.mark_code]);

  if (!locatable || stale) return null;
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
