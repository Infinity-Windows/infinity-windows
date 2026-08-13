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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BackChip } from "../../components/BackChip";
import { pushToast } from "../../lib/toast";
import { formatApiError } from "../../lib/errors";
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
import { UnitBuilder } from "../../components/studio/UnitBuilder";
import { buildFitviewModelFromStudio, type PublishStats } from "../../lib/modelstudio/toFitview";
import { buildUnitGeometry, UNIT_GEOMETRY_DEFAULTS } from "../../lib/modelstudio/unitGeometry";
import type { StudioItem } from "../../lib/modelstudio/core";
import {
  listStudioUnits,
  saveStudioUnit,
  specImportName,
  specToUnitConfig,
  unitSvg,
  type StudioUnit,
  type UnitConfig,
} from "../../lib/modelstudio/units";
import { supabase } from "../../lib/supabase";
import {
  Blueprint3d,
  Configuration,
  configWallHeight,
  floorplannerModes,
  type StudioWall,
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

/** Parse crew-style lengths: 28'6", 28' 6, 28.5', 342" or plain feet. → cm */
// Dimension grammar lives in lib/modelstudio/dims (pure, unit-tested);
// re-exported here so existing imports keep working.
import { fmtFtIn, parseFtIn } from "../../lib/modelstudio/dims";
export { fmtFtIn, parseFtIn };

function wallLengthCm(w: StudioWall): number {
  const dx = w.getEndX() - w.getStartX();
  const dy = w.getEndY() - w.getStartY();
  return Math.sqrt(dx * dx + dy * dy);
}

/** Nearest wall to a plan point (cm): clamped point on it + its angle. */
function nearestWallPlacement(bp: Blueprint3d, xCm: number, yCm: number) {
  let best: { x: number; z: number; rotation: number; d: number } | null = null;
  for (const w of bp.model.floorplan.walls) {
    const ax = w.getStartX(), ay = w.getStartY();
    const bx = w.getEndX(), by = w.getEndY();
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy || 1e-9;
    let t = ((xCm - ax) * dx + (yCm - ay) * dy) / l2;
    t = Math.max(0.05, Math.min(0.95, t));
    const px = ax + t * dx, py = ay + t * dy;
    const d = Math.hypot(xCm - px, yCm - py);
    if (!best || d < best.d) {
      best = { x: px, z: py, rotation: -Math.atan2(dy, dx), d };
    }
  }
  return best;
}

/** Midpoint of the longest wall — the visible default landing spot. */
function longestWallPlacement(bp: Blueprint3d) {
  let best: { x: number; z: number; rotation: number; len: number } | null = null;
  for (const w of bp.model.floorplan.walls) {
    const ax = w.getStartX(), ay = w.getStartY();
    const bx = w.getEndX(), by = w.getEndY();
    const len = Math.hypot(bx - ax, by - ay);
    if (!best || len > best.len) {
      best = { x: (ax + bx) / 2, z: (ay + by) / 2, rotation: -Math.atan2(by - ay, bx - ax), len };
    }
  }
  return best;
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
  const qc = useQueryClient();
  const { id: routeId = "" } = useParams();
  const projectId = propId ?? routeId;
  const embedded = Boolean(propId);
  const hostReady = useRef(false);
  const bpRef = useRef<Blueprint3d | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const [mode, setModeState] = useState<number>(0);
  /** Full-screen one pane at a time — editing needs the whole laptop screen. */
  const [fs, setFs] = useState<"none" | "plan" | "model">("none");
  /** The wall the user clicked (persists past hover) + a version tick so
   * React re-reads its mutable vendor fields after edits. */
  const [selWall, setSelWall] = useState<StudioWall | null>(null);
  const [, setSelTick] = useState(0);
  const [lenInput, setLenInput] = useState("");
  const [heightInput, setHeightInput] = useState("");
  const [buildingHeight, setBuildingHeight] = useState("");
  /** The whole palette hides behind one drop bar (owner ask). */
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false);
  /** Catalog unit being refined in the builder (spec imports arrive as one
   * fixed panel — the drawing's real panels get typed in here). */
  const [editUnit, setEditUnit] = useState<StudioUnit | null>(null);
  /** The 3D-tapped unit — Home-Design-3D-style numeric editing. */
  const [selUnit, setSelUnit] = useState<StudioItem | null>(null);
  const [unitW, setUnitW] = useState("");
  const [unitH, setUnitH] = useState("");
  const [unitSill, setUnitSill] = useState("");
  const [unitGap, setUnitGap] = useState("");
  const [publishPreview, setPublishPreview] = useState<
    { model: Record<string, unknown>; stats: PublishStats } | null
  >(null);
  const units = useQuery({ queryKey: ["studioUnits"], queryFn: listStudioUnits });
  /** Undo: serialized snapshots pushed BEFORE each mutating gesture. */
  const undoStack = useRef<string[]>([]);
  const [undoDepth, setUndoDepth] = useState(0);
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
    // Every wall item that finishes loading attaches to its wall — the
    // attachment cuts the opening. Covers seeded marks and saved models,
    // not just fresh inserts.
    bp.model.scene.itemLoadedCallbacks.add((it) => {
      try {
        const cfg = it?.metadata?.unitConfig as UnitConfig | undefined;
        if (cfg?.panels?.length) applyUnitGeometry(it, cfg);
        it.placeInRoom();
      } catch {
        /* not a wall item */
      }
    });
    // 3D tap-select (owner call: edit from inside the 3D view). Items and
    // walls both land in the SAME palette panels the 2D uses.
    bp.three.itemSelectedCallbacks.add((it) => {
      setSelUnit(it);
      const cfg = it?.metadata?.unitConfig as UnitConfig | undefined;
      const h = cfg ? cfg.heightMm / 10 : it.getHeight();
      const w = cfg
        ? cfg.panels.reduce((t, pp) => t + pp.widthMm, 0) / 10
        : it.getWidth();
      setUnitW(fmtFtIn(w));
      setUnitH(fmtFtIn(h));
      setUnitSill(fmtFtIn(Math.max(0, it.position.y - h / 2)));
      setUnitGap(String(it.metadata?.frameGapMm ?? UNIT_GEOMETRY_DEFAULTS.mullionMm));
      setPaletteOpen(true);
    });
    bp.three.itemUnselectedCallbacks.add(() => setSelUnit(null));
    bp.three.wallClicked.add((edge) => {
      const w = edge?.wall;
      if (!w) return;
      setSelWall(w as never);
      setLenInput(fmtFtIn(wallLengthCm(w as never)));
      setHeightInput(fmtFtIn((w as { height: number }).height));
      setPaletteOpen(true);
    });

    // Click-to-select: the vendor tracks hover targets every mousemove;
    // reading them at mousedown gives a persistent selection for the panel.
    // The SAME mousedown snapshots the model for undo — every drag, draw or
    // delete gesture starts here, so one hook covers them all (owner report:
    // an accidental 200-ft wall needed reverting).
    canvasEl?.addEventListener("mousedown", () => {
      pushUndo();
      const fp2 = bp.floorplanner;
      const w = fp2?.activeWall ?? null;
      setSelWall(w);
      if (w) {
        setLenInput(fmtFtIn(wallLengthCm(w)));
        setHeightInput(fmtFtIn(w.height));
      }
    });
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

  const pushUndo = () => {
    const bp = bpRef.current;
    if (!bp) return;
    const snap = bp.model.exportSerialized();
    const stack = undoStack.current;
    if (stack[stack.length - 1] === snap) return; // nothing changed since
    stack.push(snap);
    if (stack.length > 30) stack.shift();
    setUndoDepth(stack.length);
  };

  const undo = () => {
    const bp = bpRef.current;
    const snap = undoStack.current.pop();
    if (!bp || !snap) return;
    setUndoDepth(undoStack.current.length);
    bp.model.loadSerialized(snap);
    setSelWall(null);
    requestAnimationFrame(() => {
      bp.floorplanner?.resizeView();
      fitPlan(bp);
    });
  };

  const reseed = () => {
    const bp = bpRef.current;
    if (!bp || !seed) return;
    if (!window.confirm(
      "Throw away the Studio model and rebuild it from the traced building? " +
      "(Nothing is saved until you tap Save model.)",
    )) return;
    pushUndo();
    bp.model.loadSerialized(seed.serialized);
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
    setSelWall(null);
    requestAnimationFrame(() => {
      bp.floorplanner?.resizeView();
      fitPlan(bp);
    });
    pushToast("Rebuilt from the traced building.");
  };

  /** Swap an item's mesh for the parametric build of its config, at true
   * scale, and re-cut its wall hole. halfSize is refreshed from the new
   * geometry so the vendor's drag/bounds math stays honest. */
  const applyUnitGeometry = (item: StudioItem, config: UnitConfig, frameGapMm?: number) => {
    const built = buildUnitGeometry(config, {
      mullionMm: frameGapMm ?? item.metadata?.frameGapMm ?? UNIT_GEOMETRY_DEFAULTS.mullionMm,
    });
    item.geometry.dispose();
    (item as { geometry: unknown }).geometry = built.geometry;
    (item as { material: unknown }).material = built.materials;
    item.scale.set(1, 1, 1);
    built.geometry.computeBoundingBox?.();
    const bb = (built.geometry as { boundingBox: { max: { x: number; y: number; z: number }; min: { x: number; y: number; z: number } } | null }).boundingBox;
    if (bb) {
      item.halfSize.set(
        (bb.max.x - bb.min.x) / 2,
        (bb.max.y - bb.min.y) / 2,
        (bb.max.z - bb.min.z) / 2,
      );
    }
    if (item.metadata) {
      item.metadata.unitConfig = config;
      if (frameGapMm != null) item.metadata.frameGapMm = frameGapMm;
    }
    item.redrawWall?.();
  };

  /** Sizes for seeded mark items come from the job's specs. */
  const sizeByName = useMemo(() => {
    const m = new Map<string, { wMm: number; hMm: number; type?: string }>();
    for (const sp of specs.data ?? []) {
      if (sp.width_in == null || sp.height_in == null) continue;
      const entry = {
        wMm: sp.width_in * 25.4,
        hMm: sp.height_in * 25.4,
        type: sp.style ?? undefined,
      };
      // Seeded items are named by opening code ("13-1"); specs key by base
      // mark ("13") — register both spellings.
      m.set(sp.mark_code, entry);
      m.set(`${sp.mark_code}-1`, entry);
      m.set(`${sp.mark_code}-2`, entry);
    }
    return m;
  }, [specs.data]);

  const preparePublish = () => {
    const bp = bpRef.current;
    if (!bp) return;
    const converted = buildFitviewModelFromStudio(
      bp.model.floorplan.walls as never,
      bp.model.scene.getItems() as never,
      sizeByName,
    );
    if (!converted) {
      pushToast("Nothing to publish — the model has no closed walls yet.");
      return;
    }
    setPublishPreview(converted);
  };

  const publish = useMutation({
    mutationFn: async () => {
      const bp = bpRef.current;
      if (!bp || !outline || !publishPreview) throw new Error("Nothing to publish");
      const prev = (outline.features ?? {}) as Record<string, unknown>;
      const prevFitview = (prev.fitview ?? {}) as Record<string, unknown>;
      await savePlanOutline({
        outlineId: outline.id,
        projectId,
        plansetId: outline.planset_id,
        pageNumber: outline.page_number,
        points: outline.points,
        pageAspect: outline.page_aspect,
        features: {
          ...prev,
          // The Studio model rides along so re-editing resumes from here.
          modelstudio: {
            serialized: bp.model.exportSerialized(),
            savedAt: new Date().toISOString(),
          },
          // Previous map model kept for one-tap revert (owner decision).
          ...(prevFitview.model
            ? { fitview_backup: { model: prevFitview.model, at: new Date().toISOString() } }
            : {}),
          fitview: { ...prevFitview, model: publishPreview.model },
        },
      });
    },
    onSuccess: () => {
      setPublishPreview(null);
      pushToast("Published — the interactive map now renders this model.");
      void qc.invalidateQueries({ queryKey: ["planOutlines", projectId] });
    },
  });

  const revert = useMutation({
    mutationFn: async () => {
      if (!outline) throw new Error("No model");
      const prev = (outline.features ?? {}) as Record<string, unknown>;
      const backup = (prev.fitview_backup ?? {}) as Record<string, unknown>;
      if (!backup.model) throw new Error("No backup to revert to");
      const prevFitview = (prev.fitview ?? {}) as Record<string, unknown>;
      await savePlanOutline({
        outlineId: outline.id,
        projectId,
        plansetId: outline.planset_id,
        pageNumber: outline.page_number,
        points: outline.points,
        pageAspect: outline.page_aspect,
        features: {
          ...prev,
          fitview_backup: { model: prevFitview.model, at: new Date().toISOString() },
          fitview: { ...prevFitview, model: backup.model },
        },
      });
    },
    onSuccess: () => {
      pushToast("Reverted — the map uses the previous model again.");
      void qc.invalidateQueries({ queryKey: ["planOutlines", projectId] });
    },
  });

  const hasBackup = Boolean(
    ((outline?.features ?? {}) as { fitview_backup?: { model?: unknown } })
      .fitview_backup?.model,
  );

  const insertUnit = (
    config: UnitConfig,
    name: string,
    atCm?: { x: number; y: number },
  ) => {
    const bp = bpRef.current;
    if (!bp) return;
    pushUndo();
    // Land ON a wall, never at the origin — dropped point's nearest wall, or
    // the longest wall's midpoint from the Insert button (owner report: the
    // unit spawned invisible and unassignable).
    const spot = atCm
      ? nearestWallPlacement(bp, atCm.x, atCm.y)
      : longestWallPlacement(bp);
    const wCm = (config.panels.reduce((t, p) => t + p.widthMm, 0) / 1000) * 100;
    const hCm = (config.heightMm / 1000) * 100;
    const sillCm = config.kind === "door" ? 0 : 91; // 3ft window sill default
    const before = bp.model.scene.getItems().length;
    bp.model.scene.addItem(
      3,
      WINDOW_MODEL,
      // The full panel config rides in metadata — the parametric per-panel
      // 3D geometry and the publish-to-map pipeline read it from here.
      { itemName: name, itemType: 3, modelUrl: WINDOW_MODEL, unitConfig: config },
      spot ? { x: spot.x, y: sillCm + hCm / 2, z: spot.z } : undefined,
      spot?.rotation,
      undefined,
      false,
    );
    // The mesh loads async; once it lands, size it to the CONFIG's real
    // dimensions so a 16ft slider reads as 16ft against the building.
    const t0 = Date.now();
    const sizeIt = () => {
      const items = bp.model.scene.getItems();
      const it = items.length > before
        ? items[items.length - 1]
        : null;
      if (it && it.metadata?.itemName === name) {
        try {
          // Real panels + mullions at true scale, then attach to the wall —
          // attachment is what cuts the opening (wall above and beside stays).
          applyUnitGeometry(it, config);
          it.placeInRoom();
        } catch {
          /* geometry not ready — next tick */
        }
        pushToast(`${name} placed — tap it in 3D to edit, drag to move.`);
        return;
      }
      if (Date.now() - t0 < 8000) setTimeout(sizeIt, 250);
    };
    setTimeout(sizeIt, 250);
    void wCm; void hCm;
  };

  /** Drop target: catalog row dragged onto the 2D plan. */
  const onPlanDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const bp = bpRef.current;
    const fp = bp?.floorplanner;
    const raw = e.dataTransfer.getData("application/x-studio-unit");
    if (!bp || !fp || !raw) return;
    try {
      const { config, name } = JSON.parse(raw) as { config: UnitConfig; name: string };
      const canvas = document.getElementById("studio-floorplan");
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const xCm = (e.clientX - rect.left) * fp.cmPerPixel + fp.originX * fp.cmPerPixel;
      const yCm = (e.clientY - rect.top) * fp.cmPerPixel + fp.originY * fp.cmPerPixel;
      insertUnit(config, name, { x: xCm, y: yCm });
    } catch {
      /* not our drag */
    }
  };

  const importSpecs = useMutation({
    mutationFn: async () => {
      // Marks are per-job but the catalog is company-wide: the job code in
      // the name keeps two jobs' "Window 16" apart.
      const { data: proj } = await supabase
        .from("projects")
        .select("job_code")
        .eq("id", projectId)
        .single();
      const jobCode = (proj as { job_code?: string } | null)?.job_code ?? null;
      const have = new Set((units.data ?? []).map((u) => u.name));
      let added = 0;
      for (const spec of specs.data ?? []) {
        const cfg = specToUnitConfig(spec);
        if (!cfg) continue;
        const name = specImportName(spec, jobCode);
        if (have.has(name)) continue;
        have.add(name);
        await saveStudioUnit(name, cfg, "spec-import");
        added += 1;
      }
      return added;
    },
    onSuccess: (n) => {
      pushToast(n > 0 ? `Imported ${n} unit${n === 1 ? "" : "s"} from this job's specs.` : "Nothing new to import.");
      void qc.invalidateQueries({ queryKey: ["studioUnits"] });
    },
  });

  const refreshModel = () => {
    const bp = bpRef.current;
    if (!bp) return;
    bp.model.floorplan.update();
    setSelTick((n) => n + 1);
  };

  const applyWallLength = () => {
    const bp = bpRef.current;
    const cm = lenInput ? parseFtIn(lenInput) : null;
    if (!bp || !selWall || cm == null || cm < 30) return;
    pushUndo();
    // Keep the start corner planted; slide the end corner along the wall's
    // own direction — the numeric edit the office asked for.
    const sx = selWall.getStartX(), sy = selWall.getStartY();
    const dx = selWall.getEndX() - sx, dy = selWall.getEndY() - sy;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    selWall.getEnd().move(sx + (dx / len) * cm, sy + (dy / len) * cm);
    refreshModel();
    setLenInput(fmtFtIn(wallLengthCm(selWall)));
  };

  const applyWallHeight = () => {
    const cm = heightInput ? parseFtIn(heightInput) : null;
    if (!selWall || cm == null || cm < 60) return;
    pushUndo();
    selWall.height = cm;
    refreshModel();
  };

  const applyBuildingHeight = () => {
    const bp = bpRef.current;
    const cm = buildingHeight ? parseFtIn(buildingHeight) : null;
    if (!bp || cm == null || cm < 60) return;
    pushUndo();
    Configuration.setValue(configWallHeight, cm);
    // Existing walls captured the old default at construction — apply to all.
    for (const w of bp.model.floorplan.walls) w.height = cm;
    refreshModel();
  };

  const narrow = typeof window !== "undefined" && window.innerWidth < 900;

  const applyUnitEdits = () => {
    const item = selUnit;
    if (!item) return;
    const cfg = (item.metadata?.unitConfig ?? null) as UnitConfig | null;
    if (!cfg) {
      pushToast("This window came from the old seed — re-insert it from the catalog to edit panels.");
      return;
    }
    pushUndo();
    const wCm = unitW ? parseFtIn(unitW) : null;
    const hCm = unitH ? parseFtIn(unitH) : null;
    const sillCm = unitSill ? parseFtIn(unitSill) : null;
    const gapMm = unitGap ? Number(unitGap) : null;
    const next: UnitConfig = {
      ...cfg,
      heightMm: hCm != null ? hCm * 10 : cfg.heightMm,
      panels: cfg.panels.map((pp) => ({ ...pp })),
    };
    if (wCm != null) {
      const cur = next.panels.reduce((t, pp) => t + pp.widthMm, 0) || 1;
      next.panels = next.panels.map((pp) => ({
        ...pp,
        widthMm: (pp.widthMm / cur) * wCm * 10,
      }));
    }
    applyUnitGeometry(item, next, gapMm != null && Number.isFinite(gapMm) ? gapMm : undefined);
    if (sillCm != null) {
      item.position.set(item.position.x, sillCm + next.heightMm / 20, item.position.z);
    }
    item.placeInRoom();
    pushToast("Unit updated.");
  };

  const setPanelCountOnUnit = (n: number) => {
    const item = selUnit;
    const cfg = (item?.metadata?.unitConfig ?? null) as UnitConfig | null;
    if (!item || !cfg) return;
    pushUndo();
    const total = cfg.panels.reduce((t, pp) => t + pp.widthMm, 0);
    const next: UnitConfig = {
      ...cfg,
      panels: Array.from({ length: n }, (_, i) => ({
        widthMm: total / n,
        mechanism: cfg.panels[Math.min(i, cfg.panels.length - 1)].mechanism,
        direction: cfg.panels[Math.min(i, cfg.panels.length - 1)].direction,
      })),
    };
    applyUnitGeometry(item, next);
    item.placeInRoom();
  };

  const saveUnitAsCatalog = useMutation({
    mutationFn: () => {
      const cfg = selUnit?.metadata?.unitConfig as UnitConfig;
      return saveStudioUnit(`${selUnit?.metadata?.itemName ?? "Unit"} (edited)`, cfg);
    },
    onSuccess: () => {
      pushToast("Saved to the catalog.");
      void qc.invalidateQueries({ queryKey: ["studioUnits"] });
    },
  });

  const deleteUnit = () => {
    if (!selUnit) return;
    pushUndo();
    bpRef.current?.model.scene.removeItem(selUnit);
    setSelUnit(null);
    pushToast("Unit removed.");
  };

  const palette = (
    <div className={paletteOpen ? "studio-palette" : "studio-palette collapsed"}>
      <button
        type="button"
        className="button-like studio-palette-toggle"
        aria-expanded={paletteOpen}
        onClick={() => setPaletteOpen((v) => !v)}
      >
        🛠 Tools {paletteOpen ? "▴" : "▾"}
      </button>
      {paletteOpen && (
      <>
      <div className="row-gap" style={{ flexWrap: "wrap" }}>
        <button className="button-like studio-mini" disabled={undoDepth === 0} onClick={undo}>
          ↩ Undo{undoDepth > 0 ? ` (${undoDepth})` : ""}
        </button>
        <button className="button-like studio-mini" onClick={reseed}>Re-seed</button>
        <button className="button-like studio-mini active-pill" onClick={preparePublish}>
          Publish to map
        </button>
        {hasBackup && (
          <button
            className="button-like studio-mini"
            disabled={revert.isPending}
            onClick={() => revert.mutate()}
          >
            Revert map
          </button>
        )}
      </div>
      <details open>
        <summary className="tcx-label">Tools</summary>
        <div className="studio-palette-body">
          <button
            className={mode === floorplannerModes.MOVE ? "button-like active-pill" : "button-like"}
            onClick={() => setMode(floorplannerModes.MOVE)}
          >
            Select / Move
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
        </div>
      </details>
      <details>
        <summary className="tcx-label">Building</summary>
        <div className="studio-palette-body">
          <label className="field-label">Wall height (all walls)</label>
          <div className="row-gap">
            <input
              style={{ flex: 1, minWidth: 0 }}
              placeholder={fmtFtIn(Configuration.getNumericValue(configWallHeight))}
              value={buildingHeight}
              onChange={(e) => setBuildingHeight(e.target.value)}
            />
            <button className="button-like" onClick={applyBuildingHeight}>Apply</button>
          </div>
        </div>
      </details>
      {selWall ? (
        <details open>
          <summary className="tcx-label">Selected wall</summary>
          <div className="studio-palette-body">
            <label className="field-label">Length</label>
            <div className="row-gap">
              <input
                style={{ flex: 1, minWidth: 0 }}
                value={lenInput}
                onChange={(e) => setLenInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && applyWallLength()}
              />
              <button className="button-like" onClick={applyWallLength}>Set</button>
            </div>
            <label className="field-label">Height (this wall)</label>
            <div className="row-gap">
              <input
                style={{ flex: 1, minWidth: 0 }}
                value={heightInput}
                onChange={(e) => setHeightInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && applyWallHeight()}
              />
              <button className="button-like" onClick={applyWallHeight}>Set</button>
            </div>
            <div className="row-gap" style={{ marginTop: 4 }}>
              <button
                className="button-like"
                style={{ fontSize: 11.5, color: "var(--danger, #f87171)" }}
                onClick={() => {
                  pushUndo();
                  selWall.remove();
                  setSelWall(null);
                  refreshModel();
                }}
              >
                Delete wall
              </button>
              <button
                className="button-like"
                style={{ fontSize: 11.5 }}
                onClick={() => setSelWall(null)}
              >
                Deselect
              </button>
            </div>
          </div>
        </details>
      ) : (
        <p className="muted" style={{ fontSize: 11, margin: "4px 0 0" }}>
          Click a wall to edit its length or height.
        </p>
      )}
      {selUnit && (
        <details open>
          <summary className="tcx-label">Selected unit</summary>
          <div className="studio-palette-body">
            <p className="muted" style={{ margin: 0, fontSize: 11.5 }}>
              {selUnit.metadata?.itemName ?? "Unit"}
            </p>
            <label className="field-label">Width</label>
            <input value={unitW} onChange={(e) => setUnitW(e.target.value)} />
            <label className="field-label">Height</label>
            <input value={unitH} onChange={(e) => setUnitH(e.target.value)} />
            <label className="field-label">Sill height (from floor)</label>
            <input value={unitSill} onChange={(e) => setUnitSill(e.target.value)} />
            <label className="field-label">Frame gap between panes (mm)</label>
            <input value={unitGap} onChange={(e) => setUnitGap(e.target.value)} />
            <label className="field-label">Panels</label>
            <div className="row-gap" style={{ flexWrap: "wrap" }}>
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <button
                  key={n}
                  className={
                    ((selUnit.metadata?.unitConfig as UnitConfig | undefined)?.panels.length ?? 0) === n
                      ? "button-like active-pill studio-mini"
                      : "button-like studio-mini"
                  }
                  onClick={() => setPanelCountOnUnit(n)}
                >
                  {n}
                </button>
              ))}
            </div>
            <div className="row-gap" style={{ flexWrap: "wrap", marginTop: 4 }}>
              <button className="button-like active-pill" onClick={applyUnitEdits}>
                Apply
              </button>
              <button
                className="button-like studio-mini"
                disabled={saveUnitAsCatalog.isPending || !selUnit.metadata?.unitConfig}
                onClick={() => saveUnitAsCatalog.mutate()}
              >
                Save as catalog unit
              </button>
              <button
                className="button-like studio-mini"
                style={{ color: "var(--danger, #f87171)" }}
                onClick={deleteUnit}
              >
                Delete
              </button>
            </div>
          </div>
        </details>
      )}
      <details>
        <summary className="tcx-label">Catalog</summary>
        <div className="studio-palette-body">
          <button className="button-like active-pill" onClick={() => setBuilderOpen(true)}>
            Build a unit…
          </button>
          <button
            className="button-like"
            disabled={importSpecs.isPending || (specs.data ?? []).length === 0}
            onClick={() => importSpecs.mutate()}
          >
            {importSpecs.isPending ? "Importing…" : "Import from job specs"}
          </button>
          {(units.data ?? []).map((u) => (
            <div
              key={u.id}
              className="studio-unit-row"
              draggable
              title="Drag onto the plan to place it on a wall"
              onDragStart={(e) => {
                e.dataTransfer.setData(
                  "application/x-studio-unit",
                  JSON.stringify({ config: u.config, name: u.name }),
                );
                e.dataTransfer.effectAllowed = "copy";
              }}
            >
              <span
                className="studio-unit-thumb"
                dangerouslySetInnerHTML={{ __html: unitSvg(u.config, 64, 40) }}
              />
              <span
                className="studio-unit-name"
                title={`${u.name} — ${fmtFtIn(
                  (u.config.panels.reduce((t, p) => t + p.widthMm, 0) / 10),
                )} × ${fmtFtIn(u.config.heightMm / 10)} · ${u.config.panels.length} panel${
                  u.config.panels.length === 1 ? "" : "s"
                }`}
              >
                {u.name}
              </span>
              <button
                className="button-like studio-mini"
                title="Edit panels & dimensions"
                onClick={() => setEditUnit(u)}
              >
                ✎
              </button>
              <button
                className="button-like studio-mini"
                onClick={() => insertUnit(u.config, u.name)}
              >
                Insert
              </button>
            </div>
          ))}
          {(units.data ?? []).length === 0 && (
            <p className="muted" style={{ fontSize: 11, margin: 0 }}>
              No saved units yet — build one or import from specs.
            </p>
          )}
        </div>
      </details>
      </>
      )}
    </div>
  );

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

      {publishPreview && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setPublishPreview(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <p style={{ margin: 0, fontWeight: 700 }}>Publish to the interactive map?</p>
            <p className="muted" style={{ margin: "6px 0 0", fontSize: 12.5 }}>
              {publishPreview.stats.masses} building mass
              {publishPreview.stats.masses === 1 ? "" : "es"} ·{" "}
              {publishPreview.stats.stories} stor
              {publishPreview.stats.stories === 1 ? "y" : "ies"} ·{" "}
              {publishPreview.stats.windows} window
              {publishPreview.stats.windows === 1 ? "" : "s"}
              {publishPreview.stats.skippedWindows > 0 &&
                ` (${publishPreview.stats.skippedWindows} skipped — not on a wall)`}
            </p>
            <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>
              The crew's Maps Interactive tab renders this immediately — glows,
              specs and window taps included. The current map model is kept for
              one-tap revert.
            </p>
            {publish.isError && <p className="error">{formatApiError(publish.error)}</p>}
            <div className="row-gap" style={{ marginTop: 10 }}>
              <button
                className="button-like active-pill"
                disabled={publish.isPending}
                onClick={() => publish.mutate()}
              >
                {publish.isPending ? "Publishing…" : "Publish"}
              </button>
              <button className="button-like" onClick={() => setPublishPreview(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {(builderOpen || editUnit) && (
        <UnitBuilder
          initial={editUnit}
          onInsert={(cfg, name) => insertUnit(cfg, name)}
          onClose={() => {
            setBuilderOpen(false);
            setEditUnit(null);
          }}
        />
      )}

      <div className="studio-split">
        <div className={fs === "plan" ? "studio-pane fs studio-fs-plan" : fs === "model" ? "studio-pane hidden-pane" : "studio-pane"}>
          <div className="studio-main">
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
          <div
            className="studio-stage"
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes("application/x-studio-unit")) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
              }
            }}
            onDrop={onPlanDrop}
          >
            {palette}
            <canvas id="studio-floorplan" className="studio-canvas" />
          </div>
          </div>
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
