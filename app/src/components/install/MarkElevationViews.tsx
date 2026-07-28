// "Where does this one go?" — the mark ringed on the exterior elevation.
//
// A floor plan tells a crew member which room a window is in. It cannot tell him
// which of the four holes in that wall he is holding, and that is the question
// that gets asked on site. The elevation sheets answer it: they draw the wall as
// you see it standing outside, with the draughtsman's number on every opening.
//
// The rows behind this are a REFERENCE and nothing else (see
// lib/install/elevationViews and the migration) — they are never openings and
// nothing counts them. Everything here degrades to rendering nothing:
//   • no reference rows for the mark (or the table isn't migrated) → nothing;
//   • rows measured against a building planset the job no longer has → nothing,
//     because cropping one file's box out of another shows a confident picture
//     of the wrong wall;
//   • a caption the sheet never wrote → nothing, rather than "page 3".
// Smith Residence, whose plans have no readable text at all, therefore shows
// nothing here and never a broken-looking empty card.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { findBuildingPlanset, listElevationViews, listPlansets } from "../../lib/install/api";
import { elevationCropDataUrl } from "../../lib/install/drawingCrops";
import { pickElevationViews, viewLabel } from "../../lib/install/elevationViews";
import { markBase } from "../../lib/install/extract";
import { validateBbox } from "../../lib/install/markDrawing";
import type { MarkElevationView, Planset } from "../../lib/install/types";

/**
 * Most walls to show for one mark. A window on a corner is genuinely drawn on
 * two elevations and both are worth seeing; past three we are just spending a
 * phone's data on the same house from every angle.
 */
const MAX_VIEWS = 3;

/**
 * How much of the reference to show:
 *   card  — its own card, the walls this mark is drawn on, captioned. Install
 *           sheet, unit detail, foreman's spec review.
 *   bare  — the best wall only, no card chrome, for a panel that is already a
 *           card (the map's pin details).
 *   thumb — one small picture, no caption, no full-screen view, for a dense list
 *           whose rows are themselves buttons (My Work).
 */
export type ElevationViewVariant = "card" | "bare" | "thumb";

interface MarkElevationViewsProps {
  projectId: string | null | undefined;
  /** Opening code or mark — "9-2" and "9" both resolve to mark #9. */
  markCode: string | null | undefined;
  variant?: ElevationViewVariant;
}

/** One elevation drawing, cropped and ringed, loaded when it scrolls into view. */
function ElevationCrop({
  view,
  planset,
  mark,
  label,
  compact,
}: {
  view: MarkElevationView;
  planset: Planset;
  mark: string;
  label: string;
  compact: boolean;
}) {
  const bbox = useMemo(() => validateBbox(view.crop_bbox), [view.crop_bbox]);
  const [visible, setVisible] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [magnified, setMagnified] = useState(false);
  const holderRef = useRef<HTMLDivElement | null>(null);

  // Don't download a multi-megabyte planset until the card is actually on screen.
  useEffect(() => {
    if (visible || !bbox) return;
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
  }, [visible, bbox]);

  useEffect(() => {
    if (!visible || !bbox) return;
    let cancelled = false;
    setFailed(false);
    void (async () => {
      try {
        const url = await elevationCropDataUrl({
          planset,
          pageNumber: view.page_number,
          bbox,
          markCode: mark,
          pin: { x: view.pin_x, y: view.pin_y },
          label: { w: view.label_w, h: view.label_h },
        });
        if (!cancelled) setSrc(url);
      } catch {
        // Offline with no cached crop, an unrenderable page, no canvas — the
        // rest of the sheet carries on without a picture.
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, bbox, planset.id, view.page_number, view.pin_x, view.pin_y, mark]);

  if (!bbox || failed) return null;

  const height = compact ? 60 : 150;
  const alt = `${label} — mark #${mark} circled on the elevation drawing`;

  return (
    <>
      <div ref={holderRef} className="elev-view">
        {!src ? (
          <div
            className="elev-view-skeleton"
            style={{ height }}
            aria-label={`${alt} — loading`}
          />
        ) : compact ? (
          <div className="elev-view-thumb" style={{ height, cursor: "inherit" }}>
            <img src={src} alt={alt} />
          </div>
        ) : (
          <button
            type="button"
            className="elev-view-thumb"
            style={{ height }}
            onClick={() => {
              setMagnified(false);
              setZoomed(true);
            }}
            aria-label={`${alt} — tap to enlarge`}
          >
            <img src={src} alt={alt} />
          </button>
        )}
        {!compact && <p className="elev-view-caption muted">{label}</p>}
      </div>

      {zoomed && src && (
        <div
          className="photo-viewer-backdrop overlay-enter"
          role="dialog"
          aria-modal="true"
          onClick={() => setZoomed(false)}
        >
          <div className="photo-viewer" onClick={(e) => e.stopPropagation()}>
            <div className={`elev-view-full${magnified ? " magnified" : ""}`}>
              <img src={src} alt={alt} onClick={() => setMagnified((m) => !m)} />
            </div>
            <div className="photo-viewer-info">
              <p className="photo-viewer-caption">
                {label} — mark #{mark} circled
              </p>
              <p className="muted">
                The circle is the number written on the plans, not the window
                outline. Tap the drawing to {magnified ? "zoom out" : "zoom in"}.
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

/**
 * The elevation reference for one mark: up to {@link MAX_VIEWS} walls, best
 * first, each captioned in plain English. Renders nothing when there is nothing
 * honest to show.
 */
export function MarkElevationViews({
  projectId,
  markCode,
  variant = "card",
}: MarkElevationViewsProps) {
  const mark = markCode ? markBase(markCode) : "";

  const views = useQuery({
    queryKey: ["elevationViews", projectId],
    queryFn: () => listElevationViews(projectId!),
    enabled: Boolean(projectId) && Boolean(mark),
  });
  const plansets = useQuery({
    queryKey: ["plansets", projectId],
    queryFn: () => listPlansets(projectId!),
    enabled: Boolean(projectId) && Boolean(mark),
  });
  const planset = plansets.data ? findBuildingPlanset(plansets.data) : null;

  const chosen = useMemo(() => {
    if (!planset || !mark) return [];
    const mine = (views.data ?? []).filter(
      (row) =>
        row.mark_code.toUpperCase() === mark.toUpperCase() &&
        row.planset_id === planset.id,
    );
    return pickElevationViews(mine)
      .map((row) => ({ row, label: viewLabel(row.view_name) }))
      .filter(
        (entry): entry is { row: MarkElevationView; label: string } =>
          entry.label !== null,
      )
      .slice(0, MAX_VIEWS);
  }, [views.data, planset, mark]);

  if (!planset || chosen.length === 0) return null;

  if (variant === "thumb") {
    return (
      <div className="elev-view-list compact">
        <ElevationCrop
          view={chosen[0].row}
          planset={planset}
          mark={mark}
          label={chosen[0].label}
          compact
        />
      </div>
    );
  }

  const shown = variant === "bare" ? chosen.slice(0, 1) : chosen;
  const crops = (
    <div className="elev-view-list">
      {shown.map((entry) => (
        <ElevationCrop
          key={`${entry.row.page_number}:${entry.row.region_index}`}
          view={entry.row}
          planset={planset}
          mark={mark}
          label={entry.label}
          compact={false}
        />
      ))}
    </div>
  );

  if (variant === "bare") return crops;

  return (
    <div className="detail-card elev-card">
      <span className="field-label" style={{ margin: 0 }}>
        Where it sits on the building
      </span>
      <p className="muted elev-card-note">
        From the elevation drawings — the circle is the #{mark} written on the
        plans.
      </p>
      {crops}
    </div>
  );
}
