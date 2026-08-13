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
import {
  listStudioUnits,
  saveStudioUnit,
  specImportName,
  specToUnitConfig,
  unitSvg,
  type UnitConfig,
} from "../../lib/modelstudio/units";
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
export function parseFtIn(raw: string): number | null {
  const t = raw.trim().replace(/[""]/g, '"').replace(/['']/g, "'");
  if (!t) return null;
  let m = t.match(/^(\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*"?)?$/);
  if (m) return (parseFloat(m[1]) * 12 + (m[2] ? parseFloat(m[2]) : 0)) * 2.54;
  m = t.match(/^(\d+(?:\.\d+)?)\s*"$/);
  if (m) return parseFloat(m[1]) * 2.54;
  m = t.match(/^(\d+(?:\.\d+)?)$/);
  if (m) return parseFloat(m[1]) * 12 * 2.54; // bare number = feet
  return null;
}

export function fmtFtIn(cm: number): string {
  const totalIn = cm / 2.54;
  const ft = Math.floor(totalIn / 12);
  const inch = Math.round(totalIn - ft * 12);
  if (inch === 12) return `${ft + 1}'0"`;
  return `${ft}'${inch}"`;
}

function wallLengthCm(w: StudioWall): number {
  const dx = w.getEndX() - w.getStartX();
  const dy = w.getEndY() - w.getStartY();
  return Math.sqrt(dx * dx + dy * dy);
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

  const insertUnit = (config: UnitConfig, name: string) => {
    const bp = bpRef.current;
    if (!bp) return;
    pushUndo();
    bp.model.scene.addItem(
      3,
      WINDOW_MODEL,
      // The full panel config rides in metadata — the parametric per-panel
      // 3D geometry and the publish-to-map pipeline read it from here.
      { itemName: name, itemType: 3, modelUrl: WINDOW_MODEL, unitConfig: config },
      undefined,
      undefined,
      undefined,
      false,
    );
    pushToast(`${name} added — drag it onto a wall in the 3D view.`);
  };

  const importSpecs = useMutation({
    mutationFn: async () => {
      const have = new Set((units.data ?? []).map((u) => u.name));
      let added = 0;
      for (const spec of specs.data ?? []) {
        const cfg = specToUnitConfig(spec);
        if (!cfg) continue;
        const name = specImportName(spec);
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
            <button
              className="button-like"
              style={{ marginTop: 4, fontSize: 11.5 }}
              onClick={() => setSelWall(null)}
            >
              Deselect
            </button>
          </div>
        </details>
      ) : (
        <p className="muted" style={{ fontSize: 11, margin: "4px 0 0" }}>
          Click a wall to edit its length or height.
        </p>
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
            <div key={u.id} className="studio-unit-row">
              <span
                className="studio-unit-thumb"
                dangerouslySetInnerHTML={{ __html: unitSvg(u.config, 64, 40) }}
              />
              <span className="studio-unit-name" title={u.name}>{u.name}</span>
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

      {builderOpen && (
        <UnitBuilder
          onInsert={(cfg, name) => insertUnit(cfg, name)}
          onClose={() => setBuilderOpen(false)}
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
          <div className="studio-stage">
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
