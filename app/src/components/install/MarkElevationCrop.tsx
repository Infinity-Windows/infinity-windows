// Where a mark sits on the OUTSIDE of the building — Studio 100x #36.
//
// Naming trap, so it gets a comment: this is a DIFFERENT "elevation" from
// the one MarkDrawing/SpecCard already mean by it. Their "elevation
// drawing" is the window's own front-view schedule picture, cropped from
// the SPECS planset. This one is the building's exterior wall — a picture
// of where the opening sits from outside, so a crew member standing there
// can confirm they're holding the right window. Both names are correct
// trade usage; they just aren't the same picture.
//
// Two independent sources, synthetic preferred:
//   • SYNTHETIC — when the job has a Studio 3D model and the mark is
//     actually built into it (lib/modelstudio/elevationRender.ts), a
//     camera pointed at the real wall. Always in sync with the current
//     model; a re-save just changes the cache key
//     (lib/install/syntheticCropCache.ts) rather than needing an explicit
//     invalidation.
//   • OCR — lib/install/elevationViews.ts's read of the scanned exterior
//     elevation sheets, when the supplier's plans actually drew them. This
//     is what every job had before Studio existed, so it stays the
//     fallback for a job with no model yet (or a mark the model doesn't
//     have — an addendum window, say).
// Neither source existing is a normal, common case (most jobs have neither
// today) — this renders nothing then, exactly the code path a mark with no
// elevation reference already takes.

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  findBuildingPlanset,
  listElevationViews,
  listPlanOutlines,
  listPlansets,
} from "../../lib/install/api";
import { elevationReferenceDataUrl } from "../../lib/install/drawingCrops";
import { pickElevationViews, viewLabel } from "../../lib/install/elevationViews";
import { validateBbox } from "../../lib/install/markDrawing";
import {
  readSyntheticCrop,
  syntheticCropKey,
  writeSyntheticCrop,
} from "../../lib/install/syntheticCropCache";
import { preferModelOutline } from "../../lib/fitview/adapter";
import { findMarkWall, renderWallElevation } from "../../lib/modelstudio/elevationRender";
import { jobModelFromFeatures } from "../../lib/modelstudio/projects";

interface MarkElevationCropProps {
  markCode: string;
  /** Project the mark belongs to. No project, no lookup — same contract as
   * MarkDrawing's projectId. */
  projectId: string | null | undefined;
}

interface Shown {
  src: string;
  caption: string | null;
  /** Object URLs (synthetic renders) need revoking on the way out; data
   * URLs (OCR crops) don't. */
  revoke: boolean;
}

export function MarkElevationCrop({ markCode, projectId }: MarkElevationCropProps) {
  const [shown, setShown] = useState<Shown | null>(null);

  const outlines = useQuery({
    // Same query key ModelStudio/MapsInteractive/JobModelViewer use for
    // this job — reuses their already-warm cache instead of re-fetching.
    queryKey: ["planOutlines", projectId],
    queryFn: () => listPlanOutlines(projectId!),
    enabled: Boolean(projectId),
  });
  const elevationViews = useQuery({
    queryKey: ["elevationViews", projectId],
    queryFn: () => listElevationViews(projectId!),
    enabled: Boolean(projectId),
  });
  const plansets = useQuery({
    queryKey: ["plansets", projectId],
    queryFn: () => listPlansets(projectId!),
    enabled: Boolean(projectId),
  });

  useEffect(() => {
    if (!projectId || !markCode || !outlines.isFetched) return;
    let cancelled = false;

    void (async () => {
      const outline = preferModelOutline(outlines.data ?? []);
      const model = jobModelFromFeatures(outline?.features);

      // ---- synthetic: preferred whenever the model actually has this mark
      if (model) {
        const location = findMarkWall(model, markCode);
        if (location) {
          const key = syntheticCropKey(projectId, markCode, model.savedAt);
          try {
            const cached = await readSyntheticCrop(key);
            const blob = cached ?? (await renderWallElevation(model, markCode));
            if (cancelled) return;
            if (blob) {
              if (!cached) void writeSyntheticCrop(key, blob, projectId);
              setShown({
                src: URL.createObjectURL(blob),
                caption: "from the 3D model",
                revoke: true,
              });
              return;
            }
          } catch {
            // Falls through to the OCR crop below.
          }
        }
      }

      // ---- OCR fallback: exactly today's crop, unchanged for a job with
      // no model (or a mark the model doesn't have built yet).
      if (!elevationViews.isFetched || !plansets.isFetched) return;
      const wanted = markCode.trim().toUpperCase();
      const mine = (elevationViews.data ?? []).filter(
        (row) => row.mark_code.trim().toUpperCase() === wanted,
      );
      const best = pickElevationViews(mine)[0];
      if (!best) return;
      const bbox = validateBbox(best.crop_bbox);
      const planset =
        (plansets.data ?? []).find((p) => p.id === best.planset_id) ??
        findBuildingPlanset(plansets.data ?? []);
      if (!bbox || !planset) return;

      try {
        const url = await elevationReferenceDataUrl({
          planset,
          pageNumber: best.page_number,
          cropBbox: bbox,
          pin: { x: best.pin_x, y: best.pin_y },
          label: { w: best.label_w, h: best.label_h },
          markCode,
        });
        if (cancelled || !url) return;
        setShown({ src: url, caption: viewLabel(best.view_name), revoke: false });
      } catch {
        // Offline, an unrenderable page, no canvas — show nothing, same as
        // MarkDrawing's own failure path.
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    projectId,
    markCode,
    outlines.data,
    outlines.isFetched,
    elevationViews.data,
    elevationViews.isFetched,
    plansets.data,
    plansets.isFetched,
  ]);

  // Object URLs are a browser-memory handle, not a picture — free it
  // whenever we move off it (a different render replaces `shown`, or the
  // card unmounts).
  useEffect(() => {
    if (!shown?.revoke) return;
    const url = shown.src;
    return () => URL.revokeObjectURL(url);
  }, [shown]);

  if (!shown) return null;

  return (
    <div className="mark-drawing" style={{ marginTop: 8 }}>
      <div className="mark-drawing-thumb" style={{ height: 230, cursor: "inherit" }}>
        <img src={shown.src} alt={`Where mark #${markCode} sits on the building`} />
      </div>
      {shown.caption && (
        <p className="muted" style={{ margin: "4px 0 0", fontSize: 11 }}>
          {shown.caption}
        </p>
      )}
    </div>
  );
}
