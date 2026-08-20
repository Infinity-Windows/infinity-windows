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
import { Link } from "react-router-dom";
import * as THREE from "three";
import {
  buildShelfGeometry,
  normalizeShelfConfig,
  SHELF_DEFAULT,
  type ShelfConfig,
} from "../../lib/modelstudio/shelfGeometry";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BackChip } from "../../components/BackChip";
import { pushToast } from "../../lib/toast";
import { formatApiError } from "../../lib/errors";
import { listProjects } from "../../lib/api";
import {
  getMyProfile,
  listMarkSpecs,
  listOpenings,
  listPlanOutlines,
  savePlanOutline,
} from "../../lib/install/api";
import { isForemanPlus } from "../../lib/install/types";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { listOpeningPhases } from "../../lib/install/phases";
import { listProjectSessions } from "../../lib/install/sessions";
import { listQcPassedOpeningIds } from "../../lib/ops";
import { listActivePackages } from "../../lib/storage";
import { listScheduledMarks } from "../../lib/warehouse/warehouseCards";
import { buildLiveOverlay, type OverlayState } from "../../lib/modelstudio/liveOverlay";
import {
  getStudioProject,
  saveStudioProject,
} from "../../lib/modelstudio/projects";
import {
  duplicateFloorSerialized,
  floorElevationsCm,
  MAX_FLOORS,
  parseFloorLite,
  parseFloors,
} from "../../lib/modelstudio/floors";
import { buildFloorShell } from "../../lib/modelstudio/floorShell";
import {
  buildAuthoredJob,
  buildFitViewJob,
  fitviewCalibration,
  fitviewModel,
  humanTraceModel,
  preferModelOutline,
} from "../../lib/fitview/adapter";
import {
  buildStudioFloorsSeed,
  buildStudioPull,
  buildStudioSeed,
  markKeyOf,
} from "../../lib/modelstudio/fromProject";
import { UnitBuilder } from "../../components/studio/UnitBuilder";
import { buildFitviewModelFromStudio, type PublishStats } from "../../lib/modelstudio/toFitview";
import {
  buildUnitGeometry,
  cornerGeometryInfo,
  UNIT_GEOMETRY_DEFAULTS,
} from "../../lib/modelstudio/unitGeometry";
import {
  StudioHandles3d,
  type UnitHandleKind,
  type WallHandleKind,
} from "../../lib/modelstudio/handles3d";
import { buildUnitAnnotations } from "../../lib/modelstudio/unitAnnotations";
import { toggleUnitOpening } from "../../lib/modelstudio/openingAnimation";
import type { StudioItem } from "../../lib/modelstudio/core";
import {
  applyPanePreset,
  listStudioUnits,
  saveStudioUnit,
  setColumnWidthMm,
  setRowHeightMm,
  slideCountOf,
  specImportName,
  specToUnitConfig,
  splitColumn,
  splitRow,
  unitSvg,
  type StudioUnit,
  type UnitConfig,
  type UnitPanel,
} from "../../lib/modelstudio/units";
import { fmtInchesFromMm } from "../../lib/modelstudio/dims";
import { syncProjectSignatures } from "../../lib/estimate/signatureSync";
import { estimateForUnitConfig, useCohortEvidence } from "../../lib/estimate/liveEstimate";
import type { CohortEstimate } from "../../lib/estimate/cohorts";
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

/** Where a Studio session loads from and saves to (owner pick 2026-08-13:
 * "linked but independent"). Job sources keep living on the job's outline
 * (Publish/Revert untouched); standalone rows live in studio_projects and
 * may link a job later. */
export type StudioSource =
  | { kind: "job"; projectId: string }
  | { kind: "standalone"; id: string };

const BLANK_SERIALIZED = JSON.stringify({
  floorplan: { corners: {}, walls: [], wallTextures: [], floorTextures: {}, newFloorTextures: {} },
  items: [],
});

export function ModelStudio({ source }: { source: StudioSource }) {
  const qc = useQueryClient();
  const standaloneId = source.kind === "standalone" ? source.id : null;
  const proj = useQuery({
    queryKey: ["studioProject", standaloneId],
    queryFn: () => getStudioProject(standaloneId!),
    enabled: Boolean(standaloneId),
  });
  // The job everything hangs off: direct for job sources, the linked job
  // (if any) for standalone rows. Blank + unlinked = "" and every job-fed
  // query below stays off.
  const projectId =
    source.kind === "job" ? source.projectId : proj.data?.project_id ?? "";
  const hostReady = useRef(false);
  const bpRef = useRef<Blueprint3d | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const [mode, setModeState] = useState<number>(0);
  /** ONE view at a time (owner ask — no more split panes): 3D is home. */
  const [view, setView] = useState<"model" | "plan">("model");
  /** Floors: serialized plans per floor; only the active one is live in
   * the vendor, the rest render as shells. */
  const floorsRef = useRef<string[]>([]);
  const [floorInfo, setFloorInfo] = useState({ count: 1, active: 0 });
  const shellsRef = useRef<unknown[]>([]);
  const [addingFloor, setAddingFloor] = useState(false);
  /** Full-screen the stage — editing needs the whole laptop screen. */
  const [fs, setFs] = useState(false);
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
  /** 3D drag handles on the selection (grab a side to stretch). */
  const handlesRef = useRef<StudioHandles3d | null>(null);
  const selUnitRef = useRef<StudioItem | null>(null);
  const selWallRef = useRef<StudioWall | null>(null);
  /** Baselines captured at handle-grab; every move applies base + delta. */
  const dragBaseRef = useRef<{
    unit?: {
      item: StudioItem;
      config: UnitConfig;
      widthCm: number;
      heightCm: number;
      sillCm: number;
      x: number;
      z: number;
      ry: number;
    };
    wall?: {
      wall: StudioWall;
      sx: number;
      sy: number;
      ex: number;
      ey: number;
      len: number;
      h: number;
      ax: number;
      az: number;
    };
  } | null>(null);
  const [unitW, setUnitW] = useState("");
  const [unitH, setUnitH] = useState("");
  const [unitSill, setUnitSill] = useState("");
  const [unitGap, setUnitGap] = useState("");
  /** The tapped pane in the grid picker (col 0 = drawing's left, row 0 = top). */
  const [selPane, setSelPane] = useState<{ col: number; row: number } | null>(null);
  const [paneW, setPaneW] = useState("");
  const [paneH, setPaneH] = useState("");
  const [publishPreview, setPublishPreview] = useState<
    { model: Record<string, unknown>; stats: PublishStats } | null
  >(null);
  const units = useQuery({ queryKey: ["studioUnits"], queryFn: listStudioUnits });
  // #21/#26: the same evidence the estimating screen loads (one shared
  // fetch — lib/estimate/liveEstimate owns the query keys), used by the
  // builder's live line and this catalog's confidence badges below.
  const { evidence: cohortEvidence } = useCohortEvidence();
  /** Standalone extras: the job list for linking, and the link action. */
  const allProjects = useQuery({
    queryKey: ["projects"],
    queryFn: listProjects,
    enabled: source.kind === "standalone",
  });
  const jobCodeForLink = useMemo(
    () => (allProjects.data ?? []).find((p) => p.id === projectId)?.job_code ?? null,
    [allProjects.data, projectId],
  );
  const linkToJob = useMutation({
    mutationFn: async (jobId: string) => {
      if (!proj.data) throw new Error("Project not loaded yet");
      // p_model null keeps the saved drawing (the RPC coalesces).
      return saveStudioProject({
        id: proj.data.id,
        name: proj.data.name,
        projectId: jobId,
        model: null,
      });
    },
    onSuccess: () => {
      pushToast("Linked — job specs, seeding and Publish are now available.");
      void qc.invalidateQueries({ queryKey: ["studioProject", standaloneId] });
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });
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

  // Studio live overlays (owner-approved recs #1,3,4,5,6,17,19): the SAME
  // rows the map, Dispatch and the warehouse hub already fetch, under the
  // SAME query keys — this page rides their cache instead of asking the
  // server again. See lib/modelstudio/liveOverlay.ts for the pure match.
  const { effectiveRole } = useEffectiveRole();
  const myProfile = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const packages = useQuery({ queryKey: ["storagePackages"], queryFn: listActivePackages });
  const scheduledMarks = useQuery({
    queryKey: ["scheduledMarks", [projectId]],
    queryFn: () => listScheduledMarks([projectId]),
    enabled: Boolean(projectId),
  });
  const sessions = useQuery({
    queryKey: ["unitSessions", projectId],
    queryFn: () => listProjectSessions(projectId),
    enabled: Boolean(projectId),
  });
  const phases = useQuery({
    queryKey: ["openingPhases", projectId],
    queryFn: () => listOpeningPhases(projectId),
    enabled: Boolean(projectId),
  });
  const qcPassed = useQuery({
    queryKey: ["qcPassed", projectId],
    queryFn: () => listQcPassedOpeningIds(projectId),
    enabled: Boolean(projectId),
  });
  /** One toggle, per the spec — overlays default ON. */
  const [showLiveOverlay, setShowLiveOverlay] = useState(true);
  const overlayMap = useMemo(
    () =>
      buildLiveOverlay(
        {
          openings: openings.data ?? [],
          packages: packages.data ?? [],
          scheduledMarks: scheduledMarks.data ?? [],
          sessions: sessions.data ?? [],
          phases: phases.data ?? [],
          qcPassedOpeningIds: qcPassed.data ?? [],
          viewerId: myProfile.data?.id ?? null,
          managerView: isForemanPlus(effectiveRole),
          projectId,
        },
        // Every opening's own code — a studio unit's itemName IS its
        // opening_code once pulled from plans (buildStudioPull), so this
        // candidate list covers every unit that can legitimately carry
        // live state. A hand-added/renamed unit simply matches nothing.
        (openings.data ?? []).map((o) => o.opening_code),
      ),
    [
      openings.data,
      packages.data,
      scheduledMarks.data,
      sessions.data,
      phases.data,
      qcPassed.data,
      myProfile.data?.id,
      effectiveRole,
      projectId,
    ],
  );
  /** Imperative three.js callbacks (registered once at mount) read these
   * refs, never the React state/memo directly — the same stale-closure
   * defense the file already uses for openings/profiles elsewhere. */
  const overlayMapRef = useRef<Map<string, OverlayState>>(new Map());
  const showLiveOverlayRef = useRef(true);

  const outline = useMemo(
    () => preferModelOutline(outlines.data ?? []),
    [outlines.data],
  );

  // The job the plans describe: traced outline + openings + specs. This is
  // what "Pull from plans" and seeding read — NEVER the published model.
  // (BLACK22 bug, 2026-08-14: publishing an early 8-window Studio model
  // made the authored model the pull's source, so a 42-opening job could
  // only ever pull those same 8 windows back — self-referential.)
  const plansJob = useMemo(() => {
    if (!outline || !openings.data) return null;
    if (!Array.isArray(outline.points) || outline.points.length < 3) return null;
    return buildFitViewJob({
      projectId,
      projectName: "Model Studio",
      projectAddress: null,
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

  // Wall-geometry fallback for jobs with a published model but no usable
  // trace: seeding may use it (it's only wall shapes), the pull NEVER does.
  const authoredJob = useMemo(() => {
    if (!outline || !openings.data) return null;
    const authored = fitviewModel(outline.features);
    if (!authored) return null;
    return buildAuthoredJob(
      authored,
      { projectId, projectName: "Model Studio", projectAddress: null },
      openings.data,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outline, openings.data, projectId]);

  // Seed and Re-seed rebuild from the TRACED building. A HUMAN trace
  // (building.trace — the in-app tracer's own record) wins outright: its
  // per-story, multi-ring, calibrated footprints ARE the plans (owner,
  // 2026-08-14: "trace its outline... then you will have a correct
  // border"). The page-points polygon and the pin-derived model are the
  // fallbacks. A Studio publish never seeds anything.
  const traceModel = useMemo(
    () => (outline ? humanTraceModel(outline.features) : null),
    [outline],
  );
  const seed = useMemo(() => {
    const src = traceModel ? authoredJob : plansJob ?? authoredJob;
    return src ? buildStudioSeed(src as never) : null;
  }, [traceModel, plansJob, authoredJob]);
  // Every traced story → a studio floor (walls only above ground).
  const seedFloors = useMemo(
    () =>
      traceModel && authoredJob
        ? buildStudioFloorsSeed(authoredJob as never)
        : null,
    [traceModel, authoredJob],
  );

  // What the session boots from: a standalone row's own model first, then
  // the job outline's saved model, then the traced seed, then a BLANK plan
  // (the standalone start-from-nothing path). Multi-floor saves carry a
  // floors[] array; a lone serialized string is a one-floor building.
  const savedModel =
    ((source.kind === "standalone" ? proj.data?.model : null) ??
      (outline?.features as {
        modelstudio?: { serialized?: string; floors?: string[] };
      } | null)?.modelstudio ??
      null) as { serialized?: string; floors?: string[] } | null;
  const savedSerialized = savedModel?.floors?.[0] ?? savedModel?.serialized ?? null;

  // Job sources still need their outline chain before mounting (the seed);
  // a standalone source only needs its row fetched — blank is a valid boot.
  const bootReady =
    source.kind === "standalone"
      ? proj.isFetched && (!projectId || Boolean(seed) || Boolean(savedSerialized) || outlines.isFetched)
      : Boolean(seed);

  // Mount once when the boot data and both host elements exist. The vendor
  // core owns everything inside its two containers from here.
  useEffect(() => {
    if (!bootReady || hostReady.current) return;
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

    // Saved Studio model wins; then the traced-building seed (every traced
    // story becomes a floor); then blank.
    const saved = savedSerialized;
    const boot =
      !saved && seedFloors && seedFloors.length > 1
        ? { floors: seedFloors }
        : parseFloors(savedModel, seed?.serialized ?? BLANK_SERIALIZED);
    floorsRef.current = boot.floors;
    activeFloorRef.current = 0;
    setFloorInfo({ count: boot.floors.length, active: 0 });
    bp.model.loadSerialized(boot.floors[0]);
    rebuildFloorContext(boot.floors, 0);

    if (!saved && seed) {
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
        // A saved shelf rebuilds its rack from its own dimensions — same
        // placeholder-then-swap dance the windows do.
        const shelfCfg = normalizeShelfConfig(it?.metadata?.shelfConfig);
        if (shelfCfg) {
          applyShelfGeometryTo(it, shelfCfg);
          return;
        }
        const cfg = it?.metadata?.unitConfig as UnitConfig | undefined;
        if (cfg?.panels?.length) applyUnitGeometry(it, cfg);
        it.placeInRoom();
        snapIfCorner(it);
        growWallToFit(it);
      } catch {
        /* not a wall item */
      }
    });
    // 3D tap-select (owner call: edit from inside the 3D view). Items and
    // walls both land in the SAME palette panels the 2D uses.
    bp.three.itemSelectedCallbacks.add((it) => selectUnit(it));
    // First-tap pick: the vendor only selects what its HOVER raycast
    // already registered, so the first tap after opening (or any tap on a
    // trackpad that didn't glide over the window first) selected nothing.
    // A still click (< 6 px travel) raycasts the items directly, with a
    // small tolerance ring for near misses. Handle grabs never reach this
    // (their capture listener stops propagation).
    {
      const el = bp.three.element;
      const ray = new THREE.Raycaster();
      let downX = 0;
      let downY = 0;
      const pickAt = (px: number, py: number) => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        const ndc = new THREE.Vector2(
          ((px - rect.left) / rect.width) * 2 - 1,
          -((py - rect.top) / rect.height) * 2 + 1,
        );
        ray.setFromCamera(ndc, bp.three.camera);
        const items = bp.model.scene.getItems() as unknown as THREE.Object3D[];
        return (ray.intersectObjects(items, false)[0]?.object ??
          null) as unknown as StudioItem | null;
      };
      // Debug handle alongside __studio; harmless in prod.
      (window as { __studioPick?: unknown }).__studioPick = pickAt;
      el.addEventListener("mousedown", (e) => {
        downX = e.clientX;
        downY = e.clientY;
      });
      el.addEventListener("mouseup", (e) => {
        if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return;
        let hit = pickAt(e.clientX, e.clientY);
        if (!hit) {
          for (const [dx, dy] of [
            [8, 0], [-8, 0], [0, 8], [0, -8], [8, 8], [-8, -8], [8, -8], [-8, 8],
          ]) {
            hit = pickAt(e.clientX + dx, e.clientY + dy);
            if (hit) break;
          }
        }
        if (hit) {
          selectUnit(hit);
          return;
        }
        // No window under the tap — try WALLS. The vendor's own wall click
        // requires a pixel-perfect still mouse AND can only hit a wall from
        // its interior side; this raycast serves the wall the user actually
        // sees (planes forced DoubleSide — floorplan updates recreate them
        // with the default, so force every click; they're invisible).
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const planes = bp.model.floorplan.wallEdgePlanes();
        for (const p of planes) {
          (p.material as THREE.Material & { side: THREE.Side }).side = THREE.DoubleSide;
        }
        const ndc = new THREE.Vector2(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          -((e.clientY - rect.top) / rect.height) * 2 + 1,
        );
        ray.setFromCamera(ndc, bp.three.camera);
        const wallHits = ray.intersectObjects(planes as THREE.Object3D[], false);
        const wall = (wallHits[0]?.object as { edge?: { wall?: StudioWall } } | undefined)
          ?.edge?.wall;
        if (wall) selectWall(wall);
      });
      // Double-click FOCUSES the orbit on the point under the cursor —
      // window, wall or floor — so zoom works on what you care about
      // (owner report: "hard focused on center"). Pan stays on right-drag.
      el.addEventListener("dblclick", (e) => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const planes = bp.model.floorplan.wallEdgePlanes();
        for (const pl of planes) {
          (pl.material as THREE.Material & { side: THREE.Side }).side = THREE.DoubleSide;
        }
        const ndc = new THREE.Vector2(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          -((e.clientY - rect.top) / rect.height) * 2 + 1,
        );
        ray.setFromCamera(ndc, bp.three.camera);
        const targets = [
          ...(bp.model.scene.getItems() as unknown as THREE.Object3D[]),
          ...(planes as THREE.Object3D[]),
        ];
        const pt = ray.intersectObjects(targets, true)[0]?.point;
        if (pt) {
          bp.three.controls.target?.set(pt.x, pt.y, pt.z);
          bp.three.controls.update?.();
          bp.three.getController().needsUpdate = true;
        }
      });
      // Windows read as clickable: pointer cursor on hover (never clobber
      // the handle spheres' grab cursors).
      let hoverPending = false;
      el.addEventListener("mousemove", (e) => {
        if (hoverPending) return;
        hoverPending = true;
        requestAnimationFrame(() => {
          hoverPending = false;
          if (el.style.cursor === "grab" || el.style.cursor === "grabbing") return;
          el.style.cursor = pickAt(e.clientX, e.clientY) ? "pointer" : "";
        });
      });
    }
    // Grab-and-stretch handles in the 3D pane — spheres on the selection's
    // edges drive the same edit math as the numeric cards.
    handlesRef.current = new StudioHandles3d({
      scene: bp.model.scene.getScene(),
      camera: bp.three.camera,
      element: bp.three.element,
      controls: bp.three.controls,
      onGrab: () => onHandleGrab(),
      onUnitDrag: (k, d, p) => onUnitHandleDrag(k, d, p),
      onWallDrag: (k, d, p) => onWallHandleDrag(k, d, p),
    });
    bp.three.itemUnselectedCallbacks.add(() => setSelUnit(null));
    bp.three.wallClicked.add((edge) => {
      const w = edge?.wall;
      if (w) selectWall(w as never);
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
        : seed
          ? `Seeded from the traced building — ${seed.windows.length} opening${seed.windows.length === 1 ? "" : "s"} placed.`
          : "Blank slate — open Tools and Draw walls to start your planset.",
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootReady]);

  // Re-fit whichever view is showing when the view or full screen changes —
  // a hidden canvas keeps its size, but the vendor needs a nudge on swap.
  useEffect(() => {
    requestAnimationFrame(() => {
      const bp = bpRef.current;
      if (!bp) return;
      bp.floorplanner?.resizeView();
      if (view === "plan") fitPlan(bp);
      window.dispatchEvent(new Event("resize"));
      bp.three.updateWindowSize();
    });
  }, [fs, view]);

  useEffect(
    () => () => {
      roRef.current?.disconnect();
      roRef.current = null;
      handlesRef.current?.dispose();
      handlesRef.current = null;
    },
    [],
  );

  // Handles follow the selection (and vanish with it); the pane picker
  // resets so a stale (col,row) can't point past a different unit's grid.
  useEffect(() => {
    selUnitRef.current = selUnit;
    selWallRef.current = selWall;
    setSelPane(null);
    refreshHandles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selUnit, selWall]);

  // Live overlays repaint whenever the underlying data changes or the
  // toggle flips. The mount-time itemLoadedCallbacks (registered once,
  // see the boot effect) read overlayMapRef/showLiveOverlayRef through
  // setUnitAnnotations rather than this state directly — this effect is
  // what keeps those refs (and every already-loaded unit) honest.
  useEffect(() => {
    overlayMapRef.current = overlayMap;
    showLiveOverlayRef.current = showLiveOverlay;
    const bp = bpRef.current;
    if (!bp) return;
    for (const it of bp.model.scene.getItems()) {
      try {
        setUnitAnnotations(it, selUnitRef.current === it);
      } catch {
        /* mid-rebuild */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlayMap, showLiveOverlay]);

  const setMode = (m: number) => {
    bpRef.current?.floorplanner?.setMode(m);
    setModeState(m);
  };

  const save = async () => {
    const bp = bpRef.current;
    if (!bp) return;
    setSaving(true);
    try {
      // Flush the live floor into the set, then save ALL floors. The lone
      // `serialized` field mirrors floor 1 for old readers.
      floorsRef.current[activeFloorRef.current] = bp.model.exportSerialized();
      const floors = [...floorsRef.current];
      const modelBody = {
        serialized: floors[0],
        floors,
        savedAt: new Date().toISOString(),
      };
      if (source.kind === "standalone") {
        if (!proj.data) throw new Error("Project not loaded yet");
        await saveStudioProject({
          id: proj.data.id,
          name: proj.data.name,
          projectId: proj.data.project_id,
          model: modelBody,
        });
        void qc.invalidateQueries({ queryKey: ["studioProject", standaloneId] });
      } else {
        if (!outline) throw new Error("Trace the building first");
        const prev = (outline.features ?? {}) as Record<string, unknown>;
        await savePlanOutline({
          outlineId: outline.id,
          projectId,
          plansetId: outline.planset_id,
          pageNumber: outline.page_number,
          points: outline.points,
          pageAspect: outline.page_aspect,
          // Merge: the fitview model and 2D features must survive untouched.
          features: { ...prev, modelstudio: modelBody },
        });
      }
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

  /** Quiet per-item toasts during bulk placement. */
  const bulkRef = useRef(false);
  const bulkStatsRef = useRef({ raised: 0 });

  /** "Pull from plans": place every specced mark as a parametric labeled
   * unit. ADD-ONLY (owner pick): anything already placed — by an earlier
   * pull or by hand — is skipped, so edits are never moved. Also heals
   * config-less generics whose mark now has a config. */
  const pullFromPlans = (replaceAll = false) => {
    const bp = bpRef.current;
    if (!bp) return;
    if (!plansJob) {
      pushToast(
        "No traced plans to pull from — trace the building on the job's plans first.",
        "error",
      );
      return;
    }
    pushUndo();
    if (replaceAll) {
      for (const it of [...bp.model.scene.getItems()]) {
        bp.model.scene.removeItem(it);
      }
    }
    // Existing names across EVERY floor (frozen floors included).
    const existing = new Set<string>();
    if (!replaceAll) {
      for (const it of bp.model.scene.getItems()) {
        const n = it.metadata?.itemName as string | undefined;
        if (n) existing.add(n);
      }
      floorsRef.current.forEach((f, i) => {
        if (i === activeFloorRef.current) return;
        for (const it of parseFloorLite(f).items) {
          const n = it.metadata?.itemName as string | undefined;
          if (n) existing.add(n);
        }
      });
    }
    // The refined catalog unit for a mark beats the raw spec (brings the
    // hand-split panels and corners of e.g. window 16 into the pull).
    const catalogByMark = new Map<string, UnitConfig>();
    for (const u of units.data ?? []) {
      const m = /^(?:Window|Door)\s+([^\s·]+)/.exec(u.name);
      if (m) catalogByMark.set(m[1].toUpperCase(), u.config);
    }
    // The active floor's REAL walls: placements align to this frame and
    // snap onto these segments — the vendor re-centres saved plans and the
    // owner drags walls, so plan-absolute coordinates float otherwise.
    const wallSegs = bp.model.floorplan.walls.map((w) => ({
      x1: w.getStartX(),
      y1: w.getStartY(),
      x2: w.getEndX(),
      y2: w.getEndY(),
    }));
    const pull = buildStudioPull(
      plansJob as never,
      specs.data ?? [],
      existing,
      catalogByMark,
      { walls: wallSegs, floorIndex: activeFloorRef.current },
    );
    // Heal: a placed generic (no config) whose mark now resolves — same
    // rebuild the tap-heal does, position untouched.
    let healed = 0;
    if (!replaceAll) {
      for (const it of bp.model.scene.getItems()) {
        const cfg = it.metadata?.unitConfig as UnitConfig | undefined;
        const name = it.metadata?.itemName as string | undefined;
        if (cfg?.panels?.length || !name) continue;
        const spec = (specs.data ?? []).find(
          (sp) => sp.mark_code.toUpperCase() === markKeyOf(name),
        );
        const conf =
          catalogByMark.get(markKeyOf(name)) ??
          (spec ? specToUnitConfig(spec) : null);
        if (!conf) continue;
        applyUnitGeometry(it, conf);
        it.placeInRoom();
        growWallToFit(it);
        healed += 1;
      }
    }
    bulkRef.current = true;
    bulkStatsRef.current.raised = 0;
    let placedHere = 0;
    let otherFloors = 0;
    let shifted = 0;
    let lengthened = 0;
    // Walls the PLANS have that this model doesn't (missing wing, newer
    // trace): create them first so their windows have something to land
    // on. Adjacent new edges share endpoints — reuse corners within 10 cm
    // so the added wing arrives CONNECTED, not as loose stubs.
    let wallsAdded = 0;
    {
      const made: { x: number; y: number; c: unknown }[] = [];
      const cornerAt = (x: number, y: number) => {
        const hit = made.find((m) => Math.hypot(m.x - x, m.y - y) <= 10);
        if (hit) return hit.c;
        const c = bp.model.floorplan.newCorner(x, y);
        made.push({ x, y, c });
        return c;
      };
      for (const pl of pull.placements) {
        if (pl.newWall && pl.floorIndex === activeFloorRef.current) {
          bp.model.floorplan.newWall(
            cornerAt(pl.newWall.x1, pl.newWall.y1),
            cornerAt(pl.newWall.x2, pl.newWall.y2),
          );
          wallsAdded += 1;
        }
      }
    }
    if (wallsAdded > 0) bp.model.floorplan.update();
    try {
      for (const pl of pull.placements) {
        if (pl.floorIndex !== activeFloorRef.current) {
          otherFloors += 1;
          continue;
        }
        if (pl.shifted) shifted += 1;
        if (pl.lengthenWallCm && pl.lengthenWallCm > 0) {
          // Last-resort wall WIDTH change (owner: height more often than
          // width): stretch the nearest wall's end so the unit fits.
          const wall = nearestWallTo(pl.xCm, pl.yCm);
          if (wall) {
            const sx = wall.getStartX();
            const sy = wall.getStartY();
            const ex = wall.getEndX();
            const ey = wall.getEndY();
            const len = Math.hypot(ex - sx, ey - sy) || 1;
            const grow = pl.lengthenWallCm;
            wall.getEnd().move(
              sx + ((ex - sx) / len) * (len + grow),
              sy + ((ey - sy) / len) * (len + grow),
            );
            lengthened += 1;
          }
        }
        bp.model.scene.addItem(
          3,
          WINDOW_MODEL,
          { itemName: pl.itemName, itemType: 3, modelUrl: WINDOW_MODEL, unitConfig: pl.config },
          { x: pl.xCm, y: pl.elevationCm, z: pl.yCm },
          pl.rotation,
          undefined,
          false,
        );
        placedHere += 1;
      }
    } finally {
      // Attach/geometry runs async in itemLoadedCallbacks; keep toasts
      // quiet for a beat after the adds too.
      setTimeout(() => {
        bulkRef.current = false;
      }, 2500);
    }
    const auto = (plansJob as { autoScale?: { factor: number; longSideM: number } })
      .autoScale;
    window.setTimeout(() => {
      const bits = [
        `${placedHere} placed`,
        healed > 0 ? `${healed} healed` : null,
        shifted > 0 ? `${shifted} slid to fit their wall` : null,
        lengthened > 0 ? `${lengthened} wall${lengthened === 1 ? "" : "s"} lengthened` : null,
        wallsAdded > 0 ? `${wallsAdded} wall${wallsAdded === 1 ? "" : "s"} added from the plans` : null,
        bulkStatsRef.current.raised > 0
          ? `${bulkStatsRef.current.raised} wall${bulkStatsRef.current.raised === 1 ? "" : "s"} raised`
          : null,
        auto ? `building auto-scaled ×${auto.factor} from specs (${Math.round(auto.longSideM)} m long side)` : null,
        pull.alreadyPlaced > 0 ? `${pull.alreadyPlaced} already placed` : null,
        otherFloors > 0 ? `${otherFloors} on other floors — switch and pull again` : null,
        pull.noWall > 0 ? `${pull.noWall} had no wall to land on` : null,
      ].filter(Boolean);
      pushToast(`Pull from plans: ${bits.join(" · ")}.`);
    }, 1200);
  };

  const reseed = () => {
    const bp = bpRef.current;
    if (!bp || !seed) return;
    if (!window.confirm(
      "Throw away the Studio model and rebuild it from the traced building? " +
      "(Nothing is saved until you tap Save model.)",
    )) return;
    pushUndo();
    // A human trace rebuilds EVERY floor it drew; the fallbacks are one.
    const floors =
      seedFloors && seedFloors.length > 1 ? seedFloors : [seed.serialized];
    floorsRef.current = floors;
    activeFloorRef.current = 0;
    setFloorInfo({ count: floors.length, active: 0 });
    rebuildFloorContext(floors, 0);
    bp.model.loadSerialized(floors[0]);
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
    const corner = cornerGeometryInfo(config);
    if (bb && corner) {
      // The vendor derives its wall offset and drag bounds from the
      // bounding BOX; a wrap leg extending in local z would shove the main
      // leg half a leg-width out of its wall. Clamp the box to the MAIN
      // leg — the wrap leg lives on the neighbouring wall and gets its
      // hole via holeRects below. Culling stays correct: three.js culls by
      // bounding SPHERE, which is left honest.
      bb.min.x = -corner.mainWcm / 2;
      bb.max.x = corner.mainWcm / 2;
      bb.min.z = -corner.depthCm / 2;
      bb.max.z = corner.depthCm / 2;
      built.geometry.computeBoundingSphere?.();
      item.halfSize.set(
        corner.mainWcm / 2,
        (bb.max.y - bb.min.y) / 2,
        corner.depthCm / 2,
      );
    } else if (bb) {
      item.halfSize.set(
        (bb.max.x - bb.min.x) / 2,
        (bb.max.y - bb.min.y) / 2,
        (bb.max.z - bb.min.z) / 2,
      );
    }
    // Explicit world-space hole rects, one per leg, for the vendor's hole
    // cutter (see Edge.makeWall) — the wrap leg's hole lands on a wall the
    // item is NOT attached to.
    const itemAny = item as unknown as {
      rotation?: { y: number };
      holeRects?: () => unknown[];
    };
    if (corner) {
      itemAny.holeRects = () => {
        const ry = itemAny.rotation?.y ?? 0;
        const wx = Math.cos(ry);
        const wz = -Math.sin(ry); // width axis (local +x) in plan coords
        const nx = Math.sin(ry);
        const nz = Math.cos(ry); // local +z (recedes from the outside viewer)
        const halfH = config.heightMm / 20;
        const cx = item.position.x + corner.sideSign * (corner.mainWcm / 2) * wx;
        const cz = item.position.z + corner.sideSign * (corner.mainWcm / 2) * wz;
        const wrapOff = corner.depthCm / 2 + corner.wrapWcm / 2;
        return [
          {
            x: item.position.x, y: item.position.y, z: item.position.z,
            halfW: corner.mainWcm / 2, halfH, dirX: wx, dirZ: wz,
          },
          {
            x: cx + nx * wrapOff, y: item.position.y, z: cz + nz * wrapOff,
            halfW: corner.wrapWcm / 2, halfH, dirX: nx, dirZ: nz,
          },
        ];
      };
    } else {
      delete itemAny.holeRects;
    }
    if (item.metadata) {
      item.metadata.unitConfig = config;
      if (frameGapMm != null) item.metadata.frameGapMm = frameGapMm;
    }
    // Moving sashes become pivot-group children so they can animate
    // (slider slides, casement swings on its hinge stile, hung rises).
    {
      const obj = item as unknown as THREE.Object3D;
      for (const child of [...obj.children]) {
        if (child.name !== "unit-mover") continue;
        obj.remove(child);
        child.traverse((n) => {
          const mesh = n as THREE.Mesh;
          if (mesh.geometry) mesh.geometry.dispose();
        });
      }
      for (const mover of built.movers) {
        const group = new THREE.Group();
        group.name = "unit-mover";
        group.position.set(mover.origin.x, mover.origin.y, mover.origin.z);
        group.userData = { mover, baseX: mover.origin.x, baseY: mover.origin.y };
        group.add(new THREE.Mesh(mover.geometry, built.materials));
        obj.add(group);
      }
    }
    setUnitAnnotations(item, selUnitRef.current === item);
    item.redrawWall?.();
  };

  /** Repaint a unit's glyph/label overlay (map parity): operation glyphs
   * and the mark chip ALWAYS, measurements only while selected (owner
   * pick), plus the live overlay (status/parts/flashing/blocked/loose)
   * when the toggle is on and this unit's mark carries any. Children ride
   * the item, so placement is free. */
  const setUnitAnnotations = (item: StudioItem, dims: boolean) => {
    const obj = item as unknown as THREE.Object3D;
    const cfg = item.metadata?.unitConfig as UnitConfig | undefined;
    for (const child of [...obj.children]) {
      if (child.name !== "unit-annotations") continue;
      obj.remove(child);
      const mesh = child as THREE.Mesh;
      (mesh.material as THREE.MeshBasicMaterial).map?.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.geometry.dispose();
    }
    if (!cfg?.panels?.length) return;
    const name = (item.metadata?.itemName as string | undefined) ?? null;
    const overlay =
      showLiveOverlayRef.current && name ? overlayMapRef.current.get(name) : undefined;
    for (const mesh of buildUnitAnnotations(cfg, {
      mark: name,
      dims,
      overlay,
    })) {
      obj.add(mesh);
    }
  };

  /** Nearest wall to a plan point, cm — for last-resort wall stretching. */
  const nearestWallTo = (xCm: number, yCm: number): StudioWall | null => {
    const bp = bpRef.current;
    if (!bp) return null;
    let best: StudioWall | null = null;
    let bestD = Infinity;
    for (const w of bp.model.floorplan.walls) {
      const ax = w.getStartX();
      const ay = w.getStartY();
      const bx = w.getEndX();
      const by = w.getEndY();
      const dx = bx - ax;
      const dy = by - ay;
      const l2 = dx * dx + dy * dy || 1e-9;
      const t = Math.max(0, Math.min(1, ((xCm - ax) * dx + (yCm - ay) * dy) / l2));
      const d = Math.hypot(xCm - (ax + t * dx), yCm - (ay + t * dy));
      if (d < bestD) {
        bestD = d;
        best = w;
      }
    }
    return bestD < 200 ? best : null;
  };

  /** Seat a corner unit AT a wall end so its wrap leg turns down the
   * adjacent wall — placed anywhere near a corner, it snaps the last bit. */
  const snapIfCorner = (item: StudioItem) => {
    const cfg = item.metadata?.unitConfig as UnitConfig | undefined;
    const corner = cfg ? cornerGeometryInfo(cfg) : null;
    const itemAny = item as unknown as {
      rotation?: { y: number };
      currentWallEdge?: { wall: StudioWall };
    };
    const wall = itemAny.currentWallEdge?.wall;
    if (!corner || !wall) return;
    const ry = itemAny.rotation?.y ?? 0;
    const wx = Math.cos(ry);
    const wz = -Math.sin(ry);
    // Where the wrap end of the main leg sits now, plan cm.
    const reach = corner.sideSign * (corner.mainWcm / 2 + corner.depthCm / 2);
    const ex = item.position.x + reach * wx;
    const ez = item.position.z + reach * wz;
    const ends = [
      { x: wall.getStartX(), z: wall.getStartY() },
      { x: wall.getEndX(), z: wall.getEndY() },
    ];
    const nearest = ends.reduce((a, b) =>
      Math.hypot(a.x - ex, a.z - ez) <= Math.hypot(b.x - ex, b.z - ez) ? a : b,
    );
    if (Math.hypot(nearest.x - ex, nearest.z - ez) > 600) return; // parked mid-wall on purpose
    const delta = (nearest.x - ex) * wx + (nearest.z - ez) * wz;
    item.position.x += wx * delta;
    item.position.z += wz * delta;
    item.redrawWall?.();
  };

  // ------------------------------------------------------- floors 2–10

  const activeFloorRef = useRef(0);

  /** Shells + lids for the frozen floors, and the 2D ghost of the floor
   * below. The active floor edits at y=0, so shells sit RELATIVE to it —
   * the floor below's ceiling is the ground you build on. */
  const rebuildFloorContext = (floors: string[], active: number) => {
    const bp = bpRef.current;
    if (!bp) return;
    const scene = bp.model.scene.getScene();
    for (const g of shellsRef.current) scene.remove(g as never);
    shellsRef.current = [];
    const elevs = floorElevationsCm(floors);
    floors.forEach((f, i) => {
      if (i === active) return;
      const { walls } = parseFloorLite(f);
      if (walls.length === 0) return;
      // A floor with one above it wears its flat ceiling lid.
      const withLid = i < floors.length - 1;
      const g = buildFloorShell(walls, elevs[i] - elevs[active], withLid);
      scene.add(g);
      shellsRef.current.push(g);
    });
    const fp = bp.floorplanner;
    if (fp) {
      fp.view.underlayWalls =
        active > 0 ? parseFloorLite(floors[active - 1]).walls : null;
      fp.view.draw();
    }
  };

  /** Orbit the WHOLE building into view — every floor's extent, not just
   * the (possibly empty) active plan. An empty upper floor used to leave
   * the camera collapsed on its target with rotation locked. */
  const frameBuilding = () => {
    const bp = bpRef.current;
    if (!bp) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let top = 0;
    const consider = (x: number, z: number) => {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    };
    for (const w of bp.model.floorplan.walls) {
      consider(w.getStartX(), w.getStartY());
      consider(w.getEndX(), w.getEndY());
      top = Math.max(top, w.height);
    }
    floorsRef.current.forEach((f, i) => {
      if (i === activeFloorRef.current) return;
      for (const w of parseFloorLite(f).walls) {
        consider(w.x1, w.y1);
        consider(w.x2, w.y2);
        top = Math.max(top, w.height);
      }
    });
    if (!Number.isFinite(minX)) {
      minX = -500; maxX = 500; minZ = -400; maxZ = 400;
    }
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const span = Math.max(maxX - minX, maxZ - minZ, 600);
    const three = bp.three;
    three.controls.target?.set(cx, Math.max(120, top * 0.4), cz);
    three.controls.object.position.set(cx + span * 0.9, span * 0.7, cz + span * 0.9);
    three.controls.update?.();
  };

  const switchFloor = (n: number) => {
    const bp = bpRef.current;
    if (!bp || n === activeFloorRef.current) return;
    if (n < 0 || n >= floorsRef.current.length) return;
    floorsRef.current[activeFloorRef.current] = bp.model.exportSerialized();
    bp.model.loadSerialized(floorsRef.current[n] ?? BLANK_SERIALIZED);
    // Undo history is per-floor: a stack of floor-3 snapshots must never
    // restore onto floor 2.
    undoStack.current = [];
    setUndoDepth(0);
    setSelWall(null);
    setSelUnit(null);
    activeFloorRef.current = n;
    setFloorInfo({ count: floorsRef.current.length, active: n });
    rebuildFloorContext(floorsRef.current, n);
    requestAnimationFrame(() => {
      bp.floorplanner?.resizeView();
      fitPlan(bp);
      frameBuilding();
    });
  };

  const addFloor = (copyBelow: boolean) => {
    const bp = bpRef.current;
    if (!bp || floorsRef.current.length >= MAX_FLOORS) return;
    floorsRef.current[activeFloorRef.current] = bp.model.exportSerialized();
    const below = floorsRef.current[floorsRef.current.length - 1];
    floorsRef.current.push(
      copyBelow ? duplicateFloorSerialized(below) : BLANK_SERIALIZED,
    );
    setAddingFloor(false);
    switchFloor(floorsRef.current.length - 1);
    pushToast(
      copyBelow
        ? `Floor ${floorsRef.current.length} — copied from the floor below.`
        : `Floor ${floorsRef.current.length} — the floor below wears its ceiling; build what actually goes up.`,
    );
  };

  const deleteTopFloor = () => {
    const top = floorsRef.current.length - 1;
    if (top === 0) return;
    if (!window.confirm(`Delete floor ${top + 1}? Its walls and windows go with it.`)) {
      return;
    }
    if (activeFloorRef.current === top) switchFloor(top - 1);
    floorsRef.current.pop();
    setFloorInfo({ count: floorsRef.current.length, active: activeFloorRef.current });
    rebuildFloorContext(floorsRef.current, activeFloorRef.current);
  };

  // ------------------------------------------------ 3D drag handles wiring

  /** Open a unit for editing — the ONE path every selection route uses
   * (vendor hover-click, our first-tap raycast, and future callers).
   * Windows saved before the metadata fix (2026-08-13) lost their panel
   * config permanently; those heal here: a config is rebuilt from the
   * unit's measured size so Apply, the pane picker and the handles all
   * work on first tap. */
  // The shelf (ticket 22, slice 2): Studio's first free-standing object.
  // Selection is its OWN state — a shelf landing in the window palette would
  // get "rebuilt from its size" into a window, which is the one thing the
  // guard below must never let happen.
  const [selShelf, setSelShelf] = useState<StudioItem | null>(null);
  const [shelfDims, setShelfDims] = useState({ l: "", d: "", h: "", levels: "" });

  const applyShelfGeometryTo = (item: StudioItem, cfg: ShelfConfig) => {
    const built = buildShelfGeometry(cfg);
    item.geometry.dispose();
    (item as { geometry: unknown }).geometry = built.geometry;
    (item as { material: unknown }).material = built.materials;
    item.scale.set(1, 1, 1);
    const bb = built.geometry.boundingBox;
    if (bb) {
      item.halfSize.set(
        (bb.max.x - bb.min.x) / 2,
        (bb.max.y - bb.min.y) / 2,
        (bb.max.z - bb.min.z) / 2,
      );
    }
    if (item.metadata) item.metadata.shelfConfig = cfg;
  };

  const selectShelf = (it: StudioItem) => {
    const cfg = normalizeShelfConfig(it.metadata?.shelfConfig) ?? SHELF_DEFAULT;
    setSelShelf(it);
    setSelUnit(null);
    setSelWall(null);
    setShelfDims({
      l: String(cfg.lengthCm),
      d: String(cfg.depthCm),
      h: String(cfg.heightCm),
      levels: String(cfg.levels),
    });
    setPaletteOpen(true);
  };

  const selectUnit = (it: StudioItem) => {
    // A shelf is not a window — route it to its own panel before the
    // window fallback below invents panels for it.
    if (it?.metadata?.shelfConfig) {
      selectShelf(it);
      return;
    }
    let cfg = it.metadata?.unitConfig as UnitConfig | undefined;
    if (!cfg?.panels?.length && it.metadata) {
      cfg = {
        kind: "window",
        heightMm: Math.max(200, Math.round(it.getHeight() * 10)),
        panels: [
          { widthMm: Math.max(200, Math.round(it.getWidth() * 10)), mechanism: "fixed" },
        ],
      };
      applyUnitGeometry(it, cfg);
      it.placeInRoom();
      growWallToFit(it);
      pushToast("Rebuilt this window from its size — panels are editable now.");
    }
    setSelUnit(it);
    const h = cfg ? cfg.heightMm / 10 : it.getHeight();
    const w = cfg
      ? cfg.panels.reduce((t, pp) => t + pp.widthMm, 0) / 10
      : it.getWidth();
    setUnitW(fmtFtIn(w));
    setUnitH(fmtFtIn(h));
    setUnitSill(fmtFtIn(Math.max(0, it.position.y - h / 2)));
    setUnitGap(String(it.metadata?.frameGapMm ?? UNIT_GEOMETRY_DEFAULTS.mullionMm));
    setPaletteOpen(true);
  };

  /** Open a wall for editing — every wall-selection route lands here
   * (vendor wallClicked, the still-click fallback, and future callers). */
  const selectWall = (w: StudioWall) => {
    setSelWall(w);
    setLenInput(fmtFtIn(wallLengthCm(w)));
    setHeightInput(fmtFtIn(w.height));
    setPaletteOpen(true);
  };

  /** The bright outline on whatever is selected in 3D — selection must be
   * unmissable (the owner read a working tap as broken without it). */
  const highlightRef = useRef<THREE.BoxHelper | null>(null);
  /** Blue translucent quads on the selected wall (one per pick plane). */
  const wallHighlightRef = useRef<THREE.Mesh[]>([]);
  /** The unit currently wearing measurement labels (dims-on-selection). */
  const prevAnnotatedRef = useRef<StudioItem | null>(null);

  /** Re-park the handle spheres on the current selection. */
  const refreshHandles = () => {
    const handles = handlesRef.current;
    if (!handles) return;
    const item = selUnitRef.current;
    const wall = selWallRef.current;
    const bp = bpRef.current;
    if (bp) {
      const scene = bp.model.scene.getScene();
      if (highlightRef.current) {
        scene.remove(highlightRef.current);
        highlightRef.current.dispose();
        highlightRef.current = null;
      }
      for (const m of wallHighlightRef.current) {
        scene.remove(m);
        (m.material as THREE.Material).dispose();
        // Geometry is either shared with the vendor's pick plane (never
        // dispose) or our own fallback quad (flagged for disposal).
        if (m.userData.ownGeometry) m.geometry.dispose();
      }
      wallHighlightRef.current = [];
      if (item) {
        const box = new THREE.BoxHelper(item as unknown as THREE.Object3D, 0x2bb3c8);
        (box.material as THREE.LineBasicMaterial).depthTest = false;
        box.renderOrder = 998;
        box.name = "studio-select-highlight";
        scene.add(box);
        highlightRef.current = box;
      }
      if (wall && !item) {
        // Blue translucent glow on the whole straight run (owner ask: "the
        // wall highlights blue when i click on it"). Edges are recreated on
        // every floorplan update, so read them fresh each refresh.
        const mat = () =>
          new THREE.MeshBasicMaterial({
            color: 0x2b7fff,
            transparent: true,
            opacity: 0.35,
            side: THREE.DoubleSide,
            depthTest: false,
          });
        const edges = [wall.frontEdge, wall.backEdge].filter(
          (edg): edg is { plane?: THREE.Mesh } => Boolean(edg),
        );
        for (const edg of edges) {
          if (!edg.plane) continue;
          const m = new THREE.Mesh(edg.plane.geometry, mat());
          m.renderOrder = 997;
          m.name = "studio-wall-highlight";
          scene.add(m);
          wallHighlightRef.current.push(m);
        }
        if (wallHighlightRef.current.length === 0) {
          // Mid-redraw fallback: build the quad from the centerline.
          const sx = wall.getStartX();
          const sy = wall.getStartY();
          const ex = wall.getEndX();
          const ey = wall.getEndY();
          const h = wall.height;
          const geo = new THREE.BufferGeometry();
          geo.setAttribute(
            "position",
            new THREE.Float32BufferAttribute(
              [sx, 0, sy, ex, 0, ey, ex, h, ey, sx, 0, sy, ex, h, ey, sx, h, sy],
              3,
            ),
          );
          const m = new THREE.Mesh(geo, mat());
          m.userData.ownGeometry = true;
          m.renderOrder = 997;
          m.name = "studio-wall-highlight";
          scene.add(m);
          wallHighlightRef.current.push(m);
        }
      }
      // Measurements ride the SELECTED unit only (marks always) — repaint
      // the one losing selection and the one gaining it.
      if (prevAnnotatedRef.current && prevAnnotatedRef.current !== item) {
        try {
          setUnitAnnotations(prevAnnotatedRef.current, false);
        } catch {
          /* item since removed */
        }
      }
      if (item) {
        try {
          setUnitAnnotations(item, true);
        } catch {
          /* mid-rebuild */
        }
      }
      prevAnnotatedRef.current = item;
      bp.three.getController().needsUpdate = true;
    }
    if (item) {
      const cfg = item.metadata?.unitConfig as UnitConfig | undefined;
      const corner = cfg ? cornerGeometryInfo(cfg) : null;
      const widthCm = corner
        ? corner.mainWcm
        : cfg
          ? cfg.panels.reduce((t, p) => t + p.widthMm, 0) / 10
          : item.getWidth();
      const heightCm = cfg ? cfg.heightMm / 10 : item.getHeight();
      handles.attachUnit({
        center: item.position,
        rotationY: item.rotation?.y ?? 0,
        widthCm,
        heightCm,
      });
    } else if (wall) {
      handles.attachWall({
        start: { x: wall.getStartX(), z: wall.getStartY() },
        end: { x: wall.getEndX(), z: wall.getEndY() },
        heightCm: wall.height,
      });
    } else {
      handles.clear();
    }
  };

  const onHandleGrab = () => {
    pushUndo();
    const item = selUnitRef.current;
    const wall = selWallRef.current;
    dragBaseRef.current = {};
    if (item) {
      const cfg = item.metadata?.unitConfig as UnitConfig | undefined;
      if (!cfg) return;
      dragBaseRef.current.unit = {
        item,
        config: JSON.parse(JSON.stringify(cfg)) as UnitConfig,
        widthCm: cfg.panels.reduce((t, p) => t + p.widthMm, 0) / 10,
        heightCm: cfg.heightMm / 10,
        sillCm: Math.max(0, item.position.y - cfg.heightMm / 20),
        x: item.position.x,
        z: item.position.z,
        ry: item.rotation?.y ?? 0,
      };
    } else if (wall) {
      const sx = wall.getStartX();
      const sy = wall.getStartY();
      const ex = wall.getEndX();
      const ey = wall.getEndY();
      const len = Math.hypot(ex - sx, ey - sy) || 1;
      dragBaseRef.current.wall = {
        wall, sx, sy, ex, ey, len,
        h: wall.height,
        ax: (ex - sx) / len,
        az: (ey - sy) / len,
      };
    }
  };

  const onUnitHandleDrag = (kind: UnitHandleKind, deltaCm: number, phase: "move" | "end") => {
    const base = dragBaseRef.current?.unit;
    if (!base) return;
    const item = base.item;
    if (kind === "sill") {
      const sill = Math.min(1200, Math.max(0, base.sillCm + deltaCm));
      item.position.set(base.x, sill + base.heightCm / 2, base.z);
      item.redrawWall?.();
    } else if (kind === "height") {
      const h = Math.min(1500, Math.max(30, base.heightCm + deltaCm));
      const cfg: UnitConfig = { ...base.config, heightMm: h * 10 };
      item.position.set(base.x, base.sillCm + h / 2, base.z);
      applyUnitGeometry(item, cfg);
    } else {
      // width-left / width-right: the grabbed edge follows the mouse, the
      // opposite edge stays planted — so the centre shifts by half.
      const w = Math.min(6000, Math.max(30, base.widthCm + deltaCm));
      const factor = w / base.widthCm;
      const cfg: UnitConfig = {
        ...base.config,
        panels: base.config.panels.map((p) => ({ ...p, widthMm: p.widthMm * factor })),
      };
      const wx = Math.cos(base.ry);
      const wz = -Math.sin(base.ry);
      const sign = kind === "width-left" ? 1 : -1;
      const shift = (sign * (w - base.widthCm)) / 2;
      item.position.set(base.x + wx * shift, item.position.y, base.z + wz * shift);
      applyUnitGeometry(item, cfg);
    }
    if (phase === "end") {
      item.placeInRoom();
      snapIfCorner(item);
      refreshHandles();
      const cfg = item.metadata?.unitConfig as UnitConfig | undefined;
      if (cfg) {
        setUnitW(fmtFtIn(cfg.panels.reduce((t, p) => t + p.widthMm, 0) / 10));
        setUnitH(fmtFtIn(cfg.heightMm / 10));
        setUnitSill(fmtFtIn(Math.max(0, item.position.y - cfg.heightMm / 20)));
      }
    }
  };

  const onWallHandleDrag = (kind: WallHandleKind, deltaCm: number, phase: "move" | "end") => {
    const base = dragBaseRef.current?.wall;
    if (!base) return;
    if (kind === "height") {
      base.wall.height = Math.min(2000, Math.max(60, base.h + deltaCm));
      base.wall.fireRedraw?.();
    } else if (kind === "slide") {
      // Drag the whole wall along its own perpendicular: both corners move
      // together, connected walls stretch to follow.
      const nx = -base.az;
      const nz = base.ax;
      base.wall.getStart().move(base.sx + nx * deltaCm, base.sy + nz * deltaCm);
      base.wall.getEnd().move(base.ex + nx * deltaCm, base.ey + nz * deltaCm);
    } else {
      const len = Math.max(30, base.len + deltaCm);
      if (kind === "length-end") {
        base.wall.getEnd().move(base.sx + base.ax * len, base.sy + base.az * len);
      } else {
        base.wall.getStart().move(base.ex - base.ax * len, base.ey - base.az * len);
      }
    }
    if (phase === "end") {
      refreshModel();
      refreshHandles();
      setLenInput(fmtFtIn(wallLengthCm(base.wall)));
      setHeightInput(fmtFtIn(base.wall.height));
    }
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
    // Every floor publishes: the live one straight from the vendor, frozen
    // ones parsed from their serialized plans — stacked into stories.
    floorsRef.current[activeFloorRef.current] = bp.model.exportSerialized();
    const publishFloors = floorsRef.current.map((f, i) => {
      if (i === activeFloorRef.current) {
        return {
          walls: bp.model.floorplan.walls,
          items: bp.model.scene.getItems(),
        };
      }
      const lite = parseFloorLite(f);
      return {
        walls: lite.walls.map((w) => ({
          height: w.height,
          getStartX: () => w.x1,
          getStartY: () => w.y1,
          getEndX: () => w.x2,
          getEndY: () => w.y2,
        })),
        items: lite.items.map((it) => ({
          position: { x: it.x, y: it.y, z: it.z },
          rotation: { y: it.rotationY },
          metadata: it.metadata,
        })),
      };
    });
    const converted = buildFitviewModelFromStudio(
      publishFloors as never,
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
          snapIfCorner(it);
          growWallToFit(it);
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
    refreshHandles();
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
    snapIfCorner(item);
    growWallToFit(item);
    refreshHandles();
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
      // A corner can't sit past the last split anymore.
      cornerAfterPanel:
        cfg.cornerAfterPanel != null && cfg.cornerAfterPanel < n - 1
          ? cfg.cornerAfterPanel
          : null,
    };
    applyUnitGeometry(item, next);
    item.placeInRoom();
    snapIfCorner(item);
    refreshHandles();
  };

  const saveUnitAsCatalog = useMutation({
    mutationFn: () => {
      const cfg = selUnit?.metadata?.unitConfig as UnitConfig;
      return saveStudioUnit(`${selUnit?.metadata?.itemName ?? "Unit"} (edited)`, cfg);
    },
    onSuccess: () => {
      pushToast("Saved to the catalog.");
      void qc.invalidateQueries({ queryKey: ["studioUnits"] });
      // A refined catalog unit changes its mark's config-of-record.
      if (projectId) void syncProjectSignatures(projectId);
    },
  });

  /** A unit taller than its wall raises the wall to fit (owner ask: "make
   * the wall a window is on at least match the height of it"). */
  const growWallToFit = (item: StudioItem) => {
    const cfg = item.metadata?.unitConfig as UnitConfig | undefined;
    const wall = (item as unknown as { currentWallEdge?: { wall: StudioWall } })
      .currentWallEdge?.wall;
    if (!cfg || !wall) return;
    const topCm = item.position.y + cfg.heightMm / 20;
    if (wall.height < topCm - 1) {
      wall.height = Math.ceil(topCm);
      wall.fireRedraw?.();
      if (bulkRef.current) {
        bulkStatsRef.current.raised += 1;
      } else {
        pushToast(`Wall raised to ${fmtFtIn(wall.height)} to fit the unit.`);
      }
    }
  };

  /** One path for every pane-grid change from the palette. */
  const applyGridChange = (next: UnitConfig) => {
    const item = selUnit;
    if (!item) return;
    // Sill comes from the PREVIOUS config — height changes keep the sill
    // planted and move the head.
    const prev = item.metadata?.unitConfig as UnitConfig | undefined;
    const sill = Math.max(0, item.position.y - (prev?.heightMm ?? next.heightMm) / 20);
    pushUndo();
    applyUnitGeometry(item, next);
    item.position.set(item.position.x, sill + next.heightMm / 20, item.position.z);
    item.redrawWall?.();
    item.placeInRoom();
    snapIfCorner(item);
    growWallToFit(item);
    refreshHandles();
    setUnitW(fmtFtIn(next.panels.reduce((t, p) => t + p.widthMm, 0) / 10));
    setUnitH(fmtFtIn(next.heightMm / 10));
  };

  const deleteUnit = () => {
    if (!selUnit) return;
    pushUndo();
    bpRef.current?.model.scene.removeItem(selUnit);
    setSelUnit(null);
    pushToast("Unit removed.");
  };

  // #26: cohort strength per catalog unit, right now — the same
  // computation the builder's live line uses (#21), one memo for the
  // whole list rather than a hook per row (hooks can't run inside .map).
  const unitEstimates = useMemo(() => {
    const m = new Map<string, CohortEstimate>();
    for (const u of units.data ?? []) m.set(u.id, estimateForUnitConfig(u.config, cohortEvidence));
    return m;
  }, [units.data, cohortEvidence]);

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
        {projectId && (
          <button
            className="button-like studio-mini active-pill"
            title="Auto-place every specced window from the plans (add-only: your edits are never moved)"
            onClick={() => pullFromPlans(false)}
          >
            Pull from plans
          </button>
        )}
        {projectId && (
          <button
            className="button-like studio-mini"
            title="Wipe this floor's windows and re-place everything from the plans"
            onClick={() => {
              if (window.confirm("Replace ALL windows on this floor with a fresh pull from the plans? Your window edits on this floor are lost.")) {
                pullFromPlans(true);
              }
            }}
          >
            Replace from plans
          </button>
        )}
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
      {/* Studio live overlays (owner-approved recs #1,3,4,5,6,17,19): ON
          by default, one toggle to hide them — no per-overlay settings. */}
      <div className="row-gap" style={{ alignItems: "center", marginTop: 4 }}>
        <button
          type="button"
          className={
            showLiveOverlay
              ? "button-like studio-mini active-pill"
              : "button-like studio-mini"
          }
          aria-pressed={showLiveOverlay}
          onClick={() => setShowLiveOverlay((v) => !v)}
        >
          {showLiveOverlay ? "Live overlays: on" : "Live overlays: off"}
        </button>
        <span className="muted" style={{ fontSize: 11 }}>
          live: status · parts · flashing
        </span>
      </div>
      {/* The build starts at the plans (owner, 2026-08-14): upload the
          plan-sets and trace the building right here — the trace's floors
          and buildings become this model's walls on Re-seed. */}
      {projectId && (
        <div className="row-gap" style={{ flexWrap: "wrap", marginTop: 4 }}>
          <Link className="button-like studio-mini" to={`/projects/${projectId}/upload`}>
            📄 Upload plan-sets
          </Link>
          <Link
            className="button-like studio-mini"
            title="Trace the building outline over the plans — corner to corner, one shape per building, a story per floor"
            to={`/projects/${projectId}/trace-model`}
          >
            ✏️ Trace plans
          </Link>
          {traceModel && (
            <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>
              trace on file
              {Array.isArray(traceModel.building.stories)
                ? ` · ${traceModel.building.stories.length} floor${traceModel.building.stories.length === 1 ? "" : "s"}`
                : ""}
            </span>
          )}
        </div>
      )}
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
          <button
            className="button-like"
            onClick={() => {
              bpRef.current?.model.scene.addItem(
                8,
                WINDOW_MODEL,
                {
                  itemName: "Shelf",
                  itemType: 8,
                  modelUrl: WINDOW_MODEL,
                  shelfConfig: { ...SHELF_DEFAULT },
                },
                undefined,
                undefined,
                undefined,
                false,
              );
              pushToast("Shelf added — drag it where it stands.");
            }}
          >
            + Add shelf
          </button>
        </div>
      </details>
      <details>
        <summary className="tcx-label">Building</summary>
        <div className="studio-palette-body">
          <label className="field-label">Floors</label>
          <div className="row-gap" style={{ flexWrap: "wrap" }}>
            {Array.from({ length: floorInfo.count }, (_, i) => (
              <button
                key={i}
                className={
                  floorInfo.active === i
                    ? "button-like active-pill studio-mini"
                    : "button-like studio-mini"
                }
                onClick={() => switchFloor(i)}
              >
                {i + 1}
              </button>
            ))}
            {floorInfo.count < MAX_FLOORS && (
              <button
                className="button-like studio-mini"
                onClick={() => setAddingFloor((v) => !v)}
              >
                + Floor
              </button>
            )}
            {floorInfo.count > 1 && (
              <button
                className="button-like studio-mini"
                title={`Delete floor ${floorInfo.count}`}
                style={{ color: "var(--danger, #f87171)" }}
                onClick={deleteTopFloor}
              >
                🗑
              </button>
            )}
          </div>
          {addingFloor && (
            <div className="row-gap" style={{ flexWrap: "wrap" }}>
              <button className="button-like studio-mini active-pill" onClick={() => addFloor(false)}>
                Start empty
              </button>
              <button className="button-like studio-mini" onClick={() => addFloor(true)}>
                Copy floor below
              </button>
              <span className="muted" style={{ fontSize: 10.5, alignSelf: "center" }}>
                empty = only what goes up (like BLACK22); copy = hotel repeats
              </span>
            </div>
          )}
          {floorInfo.active > 0 && (
            <p className="muted" style={{ margin: 0, fontSize: 10.5 }}>
              Floor {floorInfo.active + 1} — the floor below shows as a ghost
              in 2D and wears its ceiling in 3D.
            </p>
          )}
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
      {selShelf && (
        <details open>
          <summary className="tcx-label">Selected shelf</summary>
          <div className="studio-palette-body">
            <p className="muted" style={{ margin: 0, fontSize: 11.5 }}>
              Real centimeters — the drawing tells the truth about what fits.
            </p>
            <div className="row-gap" style={{ flexWrap: "wrap" }}>
              {(
                [
                  ["l", "Length"],
                  ["d", "Depth"],
                  ["h", "Height"],
                  ["levels", "Boards"],
                ] as const
              ).map(([k, label]) => (
                <div key={k} style={{ width: 84 }}>
                  <label className="field-label">{label}</label>
                  <input
                    inputMode="numeric"
                    value={shelfDims[k]}
                    onChange={(e) =>
                      setShelfDims({ ...shelfDims, [k]: e.target.value })
                    }
                  />
                </div>
              ))}
            </div>
            <div className="row-gap" style={{ marginTop: 6 }}>
              <button
                className="button-like active-pill"
                onClick={() => {
                  const cfg = normalizeShelfConfig({
                    lengthCm: Number(shelfDims.l),
                    depthCm: Number(shelfDims.d),
                    heightCm: Number(shelfDims.h),
                    levels: Number(shelfDims.levels),
                  });
                  if (!cfg || !selShelf) {
                    pushToast("A shelf needs all three sizes, above zero.", "error");
                    return;
                  }
                  applyShelfGeometryTo(selShelf, cfg);
                  refreshHandles();
                  pushToast("Shelf resized.");
                }}
              >
                Apply size
              </button>
              <button
                className="button-like"
                onClick={() => {
                  if (!selShelf) return;
                  bpRef.current?.model.scene.removeItem(selShelf);
                  setSelShelf(null);
                  pushToast("Shelf removed.");
                }}
              >
                Remove shelf
              </button>
            </div>
          </div>
        </details>
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
            {(() => {
              const cfg = selUnit.metadata?.unitConfig as UnitConfig | undefined;
              if (!cfg) return null;
              const rows = cfg.rows?.length ? cfg.rows : [{ heightMm: cfg.heightMm }];
              const cols = cfg.panels;
              const pane =
                selPane &&
                selPane.col < cols.length &&
                selPane.row < rows.length
                  ? selPane
                  : null;
              return (
                <>
                  <label className="field-label">
                    Panes — tap one, then type its size or split it
                  </label>
                  <div
                    className="studio-pane-grid-picker"
                    style={{
                      gridTemplateColumns: cols
                        .map((p) => `${Math.max(p.widthMm, 200)}fr`)
                        .join(" "),
                    }}
                  >
                    {rows.map((r, ri) =>
                      cols.map((p, ci) => (
                        <button
                          key={`${ci}-${ri}`}
                          title={`Pane ${ci + 1}·${ri + 1} — ${fmtInchesFromMm(p.widthMm)} × ${fmtInchesFromMm(r.heightMm)}`}
                          className={
                            pane && pane.col === ci && pane.row === ri
                              ? "studio-pane-cell on"
                              : "studio-pane-cell"
                          }
                          style={{ height: Math.max(16, Math.min(40, r.heightMm / 60)) }}
                          onClick={() => {
                            setSelPane({ col: ci, row: ri });
                            setPaneW(fmtInchesFromMm(p.widthMm));
                            setPaneH(fmtInchesFromMm(r.heightMm));
                          }}
                        />
                      )),
                    )}
                  </div>
                  {pane && (
                    <div className="studio-card" style={{ padding: "6px 8px" }}>
                      <p className="tcx-label" style={{ margin: "0 0 4px" }}>
                        Pane {pane.col + 1}·{pane.row + 1}
                      </p>
                      <div className="row-gap">
                        <input
                          aria-label="Pane width"
                          style={{ flex: 1, minWidth: 0 }}
                          value={paneW}
                          onChange={(e) => setPaneW(e.target.value)}
                          onBlur={() => {
                            const cm = paneW ? parseFtIn(paneW) : null;
                            if (cm != null && cm * 10 >= 50) {
                              applyGridChange(setColumnWidthMm(cfg, pane.col, cm * 10));
                            }
                          }}
                        />
                        <span className="muted" style={{ alignSelf: "center" }}>×</span>
                        <input
                          aria-label="Pane height"
                          style={{ flex: 1, minWidth: 0 }}
                          value={paneH}
                          onChange={(e) => setPaneH(e.target.value)}
                          onBlur={() => {
                            const cm = paneH ? parseFtIn(paneH) : null;
                            if (cm != null && cm * 10 >= 50) {
                              applyGridChange(setRowHeightMm(cfg, pane.row, cm * 10));
                            }
                          }}
                        />
                      </div>
                      {(() => {
                        const col = cfg.panels[pane.col];
                        const setOp = (
                          mechanism: UnitPanel["mechanism"],
                          direction?: "left" | "right",
                        ) =>
                          applyGridChange({
                            ...cfg,
                            panels: cfg.panels.map((pp, i) =>
                              i === pane.col ? { ...pp, mechanism, direction } : pp,
                            ),
                          });
                        const isOp = (m: string, d?: string) =>
                          col.mechanism === m && (d === undefined || col.direction === d);
                        return (
                          <div className="row-gap" style={{ flexWrap: "wrap", marginTop: 4 }}>
                            <button
                              className={
                                isOp("slider", "left") || isOp("bifold", "left")
                                  ? "button-like studio-mini active-pill"
                                  : "button-like studio-mini"
                              }
                              title="This panel slides open to the left"
                              onClick={() => setOp(col.mechanism === "bifold" ? "bifold" : "slider", "left")}
                            >
                              ← Opens left
                            </button>
                            <button
                              className={
                                isOp("slider", "right") || isOp("bifold", "right")
                                  ? "button-like studio-mini active-pill"
                                  : "button-like studio-mini"
                              }
                              title="This panel slides open to the right"
                              onClick={() => setOp(col.mechanism === "bifold" ? "bifold" : "slider", "right")}
                            >
                              Opens right →
                            </button>
                            <button
                              className={
                                isOp("fixed")
                                  ? "button-like studio-mini active-pill"
                                  : "button-like studio-mini"
                              }
                              title="This panel doesn't move"
                              onClick={() => setOp("fixed", undefined)}
                            >
                              F Fixed
                            </button>
                            <select
                              aria-label="More mechanisms"
                              className="studio-mini"
                              value=""
                              onChange={(e) => {
                                const v = e.target.value;
                                if (v === "casement-l") setOp("casement", "left");
                                else if (v === "casement-r") setOp("casement", "right");
                                else if (v === "hung") setOp("hung", undefined);
                                else if (v === "bifold-l") setOp("bifold", "left");
                                else if (v === "bifold-r") setOp("bifold", "right");
                              }}
                            >
                              <option value="">More…</option>
                              <option value="casement-l">Casement (hinge left)</option>
                              <option value="casement-r">Casement (hinge right)</option>
                              <option value="hung">Single-hung</option>
                              <option value="bifold-l">Bi-fold left</option>
                              <option value="bifold-r">Bi-fold right</option>
                            </select>
                            {col.mechanism === "slider" && (() => {
                              const n = slideCountOf(col);
                              const setSlides = (next: number) =>
                                applyGridChange({
                                  ...cfg,
                                  panels: cfg.panels.map((pp, i) =>
                                    i === pane.col
                                      ? { ...pp, slideCount: Math.min(8, Math.max(1, next)) }
                                      : pp,
                                  ),
                                });
                              return (
                                <span
                                  className="row-gap"
                                  style={{ alignItems: "center", gap: 4 }}
                                  title="How many panel-widths this pane slides (multi-track, up to 8)"
                                >
                                  <button
                                    className="button-like studio-mini"
                                    aria-label="Slides fewer panels"
                                    disabled={n <= 1}
                                    onClick={() => setSlides(n - 1)}
                                  >
                                    −
                                  </button>
                                  <span style={{ minWidth: 26, textAlign: "center" }}>
                                    ×{n}
                                  </span>
                                  <button
                                    className="button-like studio-mini"
                                    aria-label="Slides more panels"
                                    disabled={n >= 8}
                                    onClick={() => setSlides(n + 1)}
                                  >
                                    +
                                  </button>
                                </span>
                              );
                            })()}
                            <button
                              className="button-like studio-mini"
                              title="This pane and its neighbour meet in the middle and slide apart"
                              onClick={() =>
                                applyGridChange(applyPanePreset(cfg, pane.col, "middle-pair"))
                              }
                            >
                              ⇤⇥ Part from middle
                            </button>
                            <button
                              className="button-like studio-mini"
                              title="French pair — casements hinged at the outer stiles, opening from the middle"
                              onClick={() =>
                                applyGridChange(applyPanePreset(cfg, pane.col, "french-pair"))
                              }
                            >
                              French pair
                            </button>
                          </div>
                        );
                      })()}
                      <div className="row-gap" style={{ flexWrap: "wrap", marginTop: 4 }}>
                        <button
                          className="button-like studio-mini"
                          title="Split this pane's column in two"
                          onClick={() => applyGridChange(splitColumn(cfg, pane.col))}
                        >
                          ▯▯ Split
                        </button>
                        <button
                          className="button-like studio-mini"
                          title="Split this pane's row in two"
                          onClick={() => applyGridChange(splitRow(cfg, pane.row))}
                        >
                          ▭ Split
                        </button>
                        {cols.length > 1 && (
                          <button
                            className="button-like studio-mini"
                            title="The unit turns 90° after this pane's column"
                            onClick={() =>
                              applyGridChange({
                                ...cfg,
                                cornerAfterPanel:
                                  cfg.cornerAfterPanel === pane.col &&
                                  pane.col < cols.length - 1
                                    ? null
                                    : Math.min(pane.col, cols.length - 2),
                              })
                            }
                          >
                            ⌐ Corner here
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </>
              );
            })()}
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
                title="Play this unit's real opening motion"
                onClick={() => {
                  const item = selUnit;
                  if (!item) return;
                  const groups = (item as unknown as THREE.Object3D).children.filter(
                    (c) => c.name === "unit-mover",
                  );
                  const r = toggleUnitOpening(item, groups as never, () => {
                    const b = bpRef.current;
                    if (b) b.three.getController().needsUpdate = true;
                  });
                  if (r === "none") {
                    pushToast("No moving panels — set a pane to Opens left/right first.");
                  }
                }}
              >
                ▶ Open / close
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
          {(units.data ?? []).map((u) => {
            const est = unitEstimates.get(u.id);
            return (
              <div key={u.id} className="studio-unit-item">
                <div
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
                {/* #25/#26: weight when the paperwork gave one, and how
                    much real install data backs this cohort's estimate —
                    same rung-label helpers as the builder's live line. */}
                <div className="studio-unit-meta">
                  {u.config.weightLb != null && (
                    <span className="muted">~{Math.round(u.config.weightLb)} lb</span>
                  )}
                  {est && (
                    <span
                      className={est.rung === "none" ? "muted" : "ok"}
                      title="How much real install data backs this unit's estimate"
                    >
                      {est.label}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
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
    <div className="page studio-page">
      <header className="page-header">
        <div>
          <p className="home-greeting">Studio</p>
          <h1>
            {source.kind === "standalone"
              ? proj.data?.name ?? "Studio project"
              : "Model Studio"}
          </h1>
          {source.kind === "standalone" && jobCodeForLink && (
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              Linked to {jobCodeForLink}
            </p>
          )}
        </div>
        <BackChip fallback="/studio" label="Back" />
      </header>

      {narrow && (
        <p className="warn-text" style={{ fontSize: 12.5 }}>
          The Studio is built for a laptop screen — editing tools need the room.
        </p>
      )}

      <div className="row-gap" style={{ flexWrap: "wrap", marginBottom: 8 }}>
        {source.kind === "standalone" && !proj.data?.project_id && (
          <select
            aria-label="Link to job"
            value=""
            onChange={(e) => {
              if (e.target.value) linkToJob.mutate(e.target.value);
            }}
          >
            <option value="">Link to a job… (enables Publish)</option>
            {(allProjects.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.job_code} — {p.name}
              </option>
            ))}
          </select>
        )}
        <button
          className="button-like active-pill"
          style={{ marginLeft: "auto" }}
          disabled={saving || (source.kind === "job" && !outline)}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save model"}
        </button>
      </div>
      {status && (
        <p className="muted" style={{ margin: "0 0 8px", fontSize: 11.5 }}>{status}</p>
      )}

      {source.kind === "job" && !outline && !outlines.isLoading && (
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

      {/* ONE stage, one view at a time (owner ask): the 2D/3D dropdown top
          right swaps them; both hosts stay mounted (the vendor binds to both
          at construction) — the inactive one is just invisible. */}
      <div className={fs ? "studio-pane single fs" : "studio-pane single"}>
        <div className="row-gap" style={{ alignItems: "baseline" }}>
          <p className="tcx-label" style={{ margin: "0 0 4px" }}>
            {view === "model" ? "Model (3D)" : "Plan (2D)"}
          </p>
          <span className="muted" style={{ fontSize: 11 }}>
            {view === "model"
              ? "drag to orbit · right-drag to pan · double-click to focus · tap to edit"
              : "drag walls & corners · drag empty space to pan"}
          </span>
          <span className="row-gap" style={{ marginLeft: "auto" }}>
            {view === "plan" && (
              <>
                <button className="button-like studio-mini" aria-label="Zoom in"
                  onClick={() => bpRef.current && zoomPlan(bpRef.current, 1.35)}>+</button>
                <button className="button-like studio-mini" aria-label="Zoom out"
                  onClick={() => bpRef.current && zoomPlan(bpRef.current, 1 / 1.35)}>−</button>
                <button className="button-like studio-mini"
                  onClick={() => bpRef.current && fitPlan(bpRef.current)}>Fit</button>
              </>
            )}
            {view === "model" && (
              <button
                className="button-like studio-mini"
                title="Frame the whole building"
                onClick={() => frameBuilding()}
              >
                Recenter
              </button>
            )}
            <select
              className="studio-view-switch"
              aria-label="View"
              value={view}
              onChange={(e) => setView(e.target.value as "model" | "plan")}
            >
              <option value="model">3D</option>
              <option value="plan">2D</option>
            </select>
            <button
              className="button-like studio-mini"
              onClick={() => setFs((v) => !v)}
            >
              {fs ? "Exit full screen" : "Full screen"}
            </button>
          </span>
        </div>
        <div
          className="studio-stage"
          onDragOver={(e) => {
            if (view === "plan" && e.dataTransfer.types.includes("application/x-studio-unit")) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
            }
          }}
          onDrop={(e) => {
            if (view === "plan") onPlanDrop(e);
          }}
        >
          {palette}
          <div className={view === "plan" ? "studio-view" : "studio-view studio-view-hidden"}>
            <canvas id="studio-floorplan" className="studio-canvas" />
          </div>
          <div className={view === "model" ? "studio-view" : "studio-view studio-view-hidden"}>
            <div id="studio-three" className="studio-three" />
          </div>
        </div>
      </div>
    </div>
  );
}
