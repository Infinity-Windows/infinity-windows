// Model Studio (SPIKE, 2026-08-13): the approved blueprint3d-modern
// foundation embedded with real project data — traced walls seeded from the
// same fit-view job the 3D map renders, plus the first few pinned openings
// as draggable in-wall window items. Desktop-only by design (industry
// pattern: edit the 2D plan, the 3D builds itself); phones keep the viewer.
//
// Spike boundaries, on purpose: ground story only, N≤8 seeded windows, save
// round-trips into project_plan_outlines.features.modelstudio without
// touching the fitview model. Multi-story, opening-binding UX and HD
// materials are Phase 1 work once this foundation is judged on BLACK22.

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BackChip } from "../../components/BackChip";
import { pushToast } from "../../lib/toast";
import {
  listMarkSpecs,
  listOpenings,
  listPlanOutlines,
  savePlanOutline,
} from "../../lib/install/api";
import {
  buildAuthoredJob,
  buildFitViewJob,
  fitviewCalibration,
  fitviewModel,
  preferModelOutline,
} from "../../lib/fitview/adapter";
import { buildStudioSeed } from "../../lib/modelstudio/fromProject";
import {
  Blueprint3d,
  floorplannerModes,
} from "../../lib/modelstudio/core";

const WINDOW_MODEL = "/modelstudio/models/window.json";

/**
 * Fit the 2D plan to the building. The vendor's own resetOrigin centers on
 * detected ROOMS, which never form on a complex traced multi-mass outline —
 * and its scale is a fixed 15px/ft, which put a 158-ft building 8× wider
 * than the pane (owner report). Fit = bbox of the raw corners at a scale
 * that spans ~85% of the canvas.
 */
function fitPlan(bp: Blueprint3d) {
  const fp = bp.floorplanner;
  const canvas = document.getElementById("studio-floorplan");
  if (!fp || !canvas) return;
  const cs = bp.model.floorplan.getCorners();
  if (cs.length === 0) return;
  const xs = cs.map((c) => c.x);
  const ys = cs.map((c) => c.y);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  const px = Math.min(
    (canvas.clientWidth * 0.85) / Math.max(spanX, 1),
    (canvas.clientHeight * 0.85) / Math.max(spanY, 1),
  );
  // A zero-width canvas mid-layout would compute scale 0 and brick the pane.
  if (!Number.isFinite(px) || px <= 0) return;
  applyPlanScale(bp, px);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  fp.originX = cx * px - canvas.clientWidth / 2;
  fp.originY = cy * px - canvas.clientHeight / 2;
  fp.resizeView();
}

function applyPlanScale(bp: Blueprint3d, pxPerCm: number) {
  const fp = bp.floorplanner;
  if (!fp) return;
  fp.pixelsPerCm = pxPerCm;
  fp.cmPerPixel = 1 / pxPerCm;
  fp.wallWidth = 10 * pxPerCm;
}

/** Zoom the plan about its canvas centre. */
function zoomPlan(bp: Blueprint3d, factor: number) {
  const fp = bp.floorplanner;
  const canvas = document.getElementById("studio-floorplan");
  if (!fp || !canvas) return;
  const cx = (fp.originX + canvas.clientWidth / 2) * fp.cmPerPixel;
  const cy = (fp.originY + canvas.clientHeight / 2) * fp.cmPerPixel;
  const px = Math.min(2, Math.max(0.01, fp.pixelsPerCm * factor));
  applyPlanScale(bp, px);
  fp.originX = cx * px - canvas.clientWidth / 2;
  fp.originY = cy * px - canvas.clientHeight / 2;
  fp.resizeView();
}

export function ModelStudio({ projectId: propId }: { projectId?: string } = {}) {
  const { id: routeId = "" } = useParams();
  const projectId = propId ?? routeId;
  const embedded = Boolean(propId);
  const hostReady = useRef(false);
  const bpRef = useRef<Blueprint3d | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const [mode, setModeState] = useState<number>(0);
  /** Full-screen one pane at a time — editing needs the whole laptop screen. */
  const [fs, setFs] = useState<"none" | "plan" | "model">("none");
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const outlines = useQuery({
    queryKey: ["planOutlines", projectId],
    queryFn: () => listPlanOutlines(projectId),
    enabled: Boolean(projectId),
  });
  const openings = useQuery({
    queryKey: ["openings", projectId],
    queryFn: () => listOpenings(projectId),
    enabled: Boolean(projectId),
  });
  const specs = useQuery({
    queryKey: ["markSpecs", projectId],
    queryFn: () => listMarkSpecs(projectId),
    enabled: Boolean(projectId),
  });

  const outline = useMemo(
    () => preferModelOutline(outlines.data ?? []),
    [outlines.data],
  );

  // The same job the 3D map renders — one source of truth for geometry.
  const job = useMemo(() => {
    if (!outline || !openings.data) return null;
    const meta = { projectId, projectName: "Model Studio", projectAddress: null };
    const authored = fitviewModel(outline.features);
    if (authored) return buildAuthoredJob(authored, meta, openings.data);
    return buildFitViewJob({
      ...meta,
      outline: {
        points: outline.points,
        pageAspect: outline.page_aspect,
        pageNumber: outline.page_number,
      },
      openings: openings.data,
      specs: specs.data ?? [],
      ...fitviewCalibration(outline.features),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outline, openings.data, specs.data, projectId]);

  const seed = useMemo(
    () => (job ? buildStudioSeed(job as never) : null),
    [job],
  );

  // Mount once when the seed and both host elements exist. The vendor core
  // owns everything inside its two containers from here.
  useEffect(() => {
    if (!seed || hostReady.current) return;
    const floorplanEl = document.getElementById("studio-floorplan");
    const threeEl = document.getElementById("studio-three");
    if (!floorplanEl || !threeEl) return;
    hostReady.current = true;

    const bp = new Blueprint3d({
      floorplannerElement: "studio-floorplan",
      threeElement: "#studio-three",
      textureDir: "/modelstudio/",
      enableWheelZoom: true,
      alwaysSpin: false,
    });
    bpRef.current = bp;
    // Debug handle for the dev pane; harmless in prod.
    (window as { __studio?: unknown }).__studio = bp;

    // Saved Studio model wins; otherwise seed from the traced building.
    const saved = (outline?.features as { modelstudio?: { serialized?: string } } | null)
      ?.modelstudio?.serialized;
    bp.model.loadSerialized(saved ?? seed.serialized);

    if (!saved) {
      for (const w of seed.windows) {
        bp.model.scene.addItem(
          3,
          WINDOW_MODEL,
          { itemName: w.id, itemType: 3, modelUrl: WINDOW_MODEL },
          { x: w.x, y: w.elevation, z: w.y },
          w.rotation,
          undefined,
          false,
        );
      }
    }
    // Fit AFTER layout settles: reset() centers the plan on the building,
    // but only once the canvas has its real size — running it in the same
    // tick as mount left the plan half off-screen (owner report).
    requestAnimationFrame(() => {
      bp.floorplanner?.resizeView();
      fitPlan(bp);
      bp.three.updateWindowSize();
      bp.three.centerCamera();
    });
    // Layout can settle after the raf (lazy chunk, tab transition, pane
    // resize). Re-fit whenever the canvas gets a real size — the guard in
    // fitPlan makes duplicate calls harmless.
    const canvasEl = document.getElementById("studio-floorplan");
    if (canvasEl && "ResizeObserver" in window) {
      const ro = new ResizeObserver(() => {
        bp.floorplanner?.resizeView();
        fitPlan(bp);
      });
      ro.observe(canvasEl);
      roRef.current = ro;
    }
    setStatus(
      saved
        ? "Loaded your saved Studio model."
        : `Seeded from the traced building — ${seed.windows.length} opening${seed.windows.length === 1 ? "" : "s"} placed.`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  // Re-fit both views whenever a pane enters/leaves full screen.
  useEffect(() => {
    requestAnimationFrame(() => {
      const bp = bpRef.current;
      if (!bp) return;
      bp.floorplanner?.resizeView();
      fitPlan(bp);
      window.dispatchEvent(new Event("resize"));
      bp.three.centerCamera();
    });
  }, [fs]);

  useEffect(
    () => () => {
      roRef.current?.disconnect();
      roRef.current = null;
    },
    [],
  );

  const setMode = (m: number) => {
    bpRef.current?.floorplanner?.setMode(m);
    setModeState(m);
  };

  const save = async () => {
    const bp = bpRef.current;
    if (!bp || !outline) return;
    setSaving(true);
    try {
      const serialized = bp.model.exportSerialized();
      const prev = (outline.features ?? {}) as Record<string, unknown>;
      await savePlanOutline({
        outlineId: outline.id,
        projectId,
        plansetId: outline.planset_id,
        pageNumber: outline.page_number,
        points: outline.points,
        pageAspect: outline.page_aspect,
        // Merge: the fitview model and 2D features must survive untouched.
        features: { ...prev, modelstudio: { serialized, savedAt: new Date().toISOString() } },
      });
      pushToast("Studio model saved.");
    } catch (e) {
      pushToast(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const narrow = typeof window !== "undefined" && window.innerWidth < 900;

  return (
    <div className={embedded ? "studio-page" : "page studio-page"}>
      {!embedded && (
        <header className="page-header">
          <div>
            <h1>Model Studio</h1>
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              Spike — edit the plan on the left, the 3D builds itself on the right.
            </p>
          </div>
          <BackChip fallback={`/projects/${projectId}?tab=maps-interactive`} label="Back" />
        </header>
      )}

      {narrow && (
        <p className="warn-text" style={{ fontSize: 12.5 }}>
          The Studio is built for a laptop screen — editing tools need the room.
        </p>
      )}

      <div className="row-gap" style={{ flexWrap: "wrap", marginBottom: 8 }}>
        <div className="seg" role="group" aria-label="Plan tool">
          <button
            className={mode === floorplannerModes.MOVE ? "button-like active-pill" : "button-like"}
            onClick={() => setMode(floorplannerModes.MOVE)}
          >
            Move
          </button>
          <button
            className={mode === floorplannerModes.DRAW ? "button-like active-pill" : "button-like"}
            onClick={() => setMode(floorplannerModes.DRAW)}
          >
            Draw walls
          </button>
          <button
            className={mode === floorplannerModes.DELETE ? "button-like active-pill" : "button-like"}
            onClick={() => setMode(floorplannerModes.DELETE)}
          >
            Delete
          </button>
        </div>
        <button
          className="button-like"
          onClick={() => {
            bpRef.current?.model.scene.addItem(
              3,
              WINDOW_MODEL,
              { itemName: "New window", itemType: 3, modelUrl: WINDOW_MODEL },
              undefined,
              undefined,
              undefined,
              false,
            );
            pushToast("Window added — drag it onto a wall in the 3D view.");
          }}
        >
          + Add window
        </button>
        <button
          className="button-like active-pill"
          style={{ marginLeft: "auto" }}
          disabled={saving || !outline}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save model"}
        </button>
      </div>
      {status && (
        <p className="muted" style={{ margin: "0 0 8px", fontSize: 11.5 }}>{status}</p>
      )}

      {!outline && !outlines.isLoading && (
        <p className="muted">
          No traced building yet — trace one on the job's Maps Interactive tab
          (Sheets view) first, then come back.
        </p>
      )}

      <div className="studio-split">
        <div className={fs === "plan" ? "studio-pane fs" : fs === "model" ? "studio-pane hidden-pane" : "studio-pane"}>
          <div className="row-gap" style={{ alignItems: "baseline" }}>
            <p className="tcx-label" style={{ margin: "0 0 4px" }}>Plan (2D)</p>
            <span className="muted" style={{ fontSize: 11 }}>
              drag walls & corners · drag empty space to pan
            </span>
            <span className="row-gap" style={{ marginLeft: "auto" }}>
              <button className="button-like studio-mini" aria-label="Zoom in"
                onClick={() => bpRef.current && zoomPlan(bpRef.current, 1.35)}>+</button>
              <button className="button-like studio-mini" aria-label="Zoom out"
                onClick={() => bpRef.current && zoomPlan(bpRef.current, 1 / 1.35)}>−</button>
              <button className="button-like studio-mini"
                onClick={() => bpRef.current && fitPlan(bpRef.current)}>Fit</button>
              <button
                className="button-like studio-mini"
                onClick={() => setFs(fs === "plan" ? "none" : "plan")}
              >
                {fs === "plan" ? "Exit" : "Full screen"}
              </button>
            </span>
          </div>
          <canvas id="studio-floorplan" className="studio-canvas" />
        </div>
        <div className={fs === "model" ? "studio-pane fs" : fs === "plan" ? "studio-pane hidden-pane" : "studio-pane"}>
          <div className="row-gap" style={{ alignItems: "baseline" }}>
            <p className="tcx-label" style={{ margin: "0 0 4px" }}>Model (3D)</p>
            <span className="muted" style={{ fontSize: 11 }}>
              drag to orbit · scroll to zoom · drag windows to move them
            </span>
            <button
              className="button-like"
              style={{ marginLeft: "auto", fontSize: 11.5, padding: "2px 8px" }}
              onClick={() => setFs(fs === "model" ? "none" : "model")}
            >
              {fs === "model" ? "Exit full screen" : "Full screen"}
            </button>
          </div>
          <div id="studio-three" className="studio-three" />
        </div>
      </div>
    </div>
  );
}
