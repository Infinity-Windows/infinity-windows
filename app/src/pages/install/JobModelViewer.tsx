// The installer's window into a JOB's 3D Studio model (Studio 100x #27).
//
// Read-only on purpose, and NOT the Studio: Studio (the editor) is
// supervisor+ and desktop-only by design, so installers never see it at
// all. This page mounts the exact same vendored engine ContainerViewer uses
// for a warehouse container (ticket 22, slice 3) — widget mode, orbit-only,
// every item pinned — and points it at a JOB'S saved model instead of a
// container's shell. Nothing here can be moved, published or reverted.
//
// The model lives on the job's plan outline
// (project_plan_outlines.features.modelstudio), read the same way
// ModelStudio.tsx reads it for a job source: the outline row that carries a
// model wins (preferModelOutline), and a lone `serialized` string or a
// multi-floor `floors` array both boot the same way.
//
// #29: the loaded model is cached on this phone (lib/install/jobModelCache)
// so a job already walked once keeps opening with no signal — the crop
// cache's precedent (lib/install/cropCache.ts), pointed at a whole model
// instead of a mark's drawing.

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import * as THREE from "three";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BackChip } from "../../components/BackChip";
import { Blueprint3d, type StudioItem } from "../../lib/modelstudio/core";
import {
  buildUnitGeometry,
  cornerGeometryInfo,
  UNIT_GEOMETRY_DEFAULTS,
} from "../../lib/modelstudio/unitGeometry";
import type { UnitConfig } from "../../lib/modelstudio/units";
import { fmtInchesFromMm } from "../../lib/modelstudio/dims";
import { jobModelFromFeatures } from "../../lib/modelstudio/projects";
import { markKeyOf } from "../../lib/modelstudio/fromProject";
import { markOfPackage, unitsForMark } from "../../lib/modelstudio/unitGlow";
import { parseFloorLite, parseRoof } from "../../lib/modelstudio/floors";
import { buildRoof } from "../../lib/modelstudio/roofShell";
import {
  assignOpeningsInOrder,
  listOpenings,
  listPlanOutlines,
  listProfiles,
} from "../../lib/install/api";
import {
  listInstallMedia,
  listOpeningInstallEvents,
} from "../../lib/install/record";
import { listLocations, listProjects } from "../../lib/api";
import { getPackageBySerial, listActivePackages, listContainers } from "../../lib/storage";
import { toLocationsById } from "../../lib/warehouse/containment";
import { unitPackageLine, unitParts } from "../../lib/warehouse/unitParts";
import { openingIdForMark, preferModelOutline } from "../../lib/fitview/adapter";
import {
  describeAge,
  readJobModel,
  resolveJobModel,
  writeJobModel,
} from "../../lib/install/jobModelCache";
import { installerColorMap, orderNumberMap, toggleSelection } from "../../lib/install/mapDispatch";
import { isForemanPlus } from "../../lib/install/types";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { pushToast } from "../../lib/toast";
import { formatApiError } from "../../lib/install/errors";

/**
 * Mark + size for the tap info line — pure, so it's testable without
 * mocking a live 3D item. Width/height fall back to the item's own measured
 * box (cm, the vendor's native unit) when there's no panel config yet (an
 * unresolved seeded window with no matching spec).
 */
export function unitTapInfo(
  metadata: { itemName?: string; unitConfig?: UnitConfig } | null | undefined,
  fallbackWidthCm: number,
  fallbackHeightCm: number,
): { mark: string; dims: string } {
  const mark = metadata?.itemName?.trim() || "Unit";
  const cfg = metadata?.unitConfig;
  if (cfg?.panels?.length) {
    const widthMm = cfg.panels.reduce((total, p) => total + p.widthMm, 0);
    return {
      mark,
      dims: `${fmtInchesFromMm(widthMm)} × ${fmtInchesFromMm(cfg.heightMm)}`,
    };
  }
  return {
    mark,
    dims: `${fmtInchesFromMm(fallbackWidthCm * 10)} × ${fmtInchesFromMm(fallbackHeightCm * 10)}`,
  };
}

/**
 * Rebuild a window/door item's real parametric shape from its saved config.
 * The serialized model stores a placeholder box (window.json) plus this
 * metadata; without this, every unit in the walk would render as an
 * identical blank box instead of the job's real geometry.
 *
 * Trimmed from ModelStudio's applyUnitGeometry: no moving-sash rig (nothing
 * here ever animates) and no per-item frame-gap override (view-only always
 * uses the shop default). Everything that decides what the unit LOOKS like
 * and how its wall hole cuts stays, corner units included.
 */
function applyUnitGeometry(item: StudioItem, config: UnitConfig): void {
  const built = buildUnitGeometry(config, { mullionMm: UNIT_GEOMETRY_DEFAULTS.mullionMm });
  item.geometry.dispose();
  (item as { geometry: unknown }).geometry = built.geometry;
  (item as { material: unknown }).material = built.materials;
  item.scale.set(1, 1, 1);
  built.geometry.computeBoundingBox?.();
  const bb = (
    built.geometry as {
      boundingBox: {
        max: { x: number; y: number; z: number };
        min: { x: number; y: number; z: number };
      } | null;
    }
  ).boundingBox;
  const corner = cornerGeometryInfo(config);
  if (bb && corner) {
    // Clamp the bounding box to the MAIN leg — the wrap leg lives on the
    // neighbouring wall and gets its hole via holeRects below.
    bb.min.x = -corner.mainWcm / 2;
    bb.max.x = corner.mainWcm / 2;
    bb.min.z = -corner.depthCm / 2;
    bb.max.z = corner.depthCm / 2;
    built.geometry.computeBoundingSphere?.();
    item.halfSize.set(corner.mainWcm / 2, (bb.max.y - bb.min.y) / 2, corner.depthCm / 2);
  } else if (bb) {
    item.halfSize.set(
      (bb.max.x - bb.min.x) / 2,
      (bb.max.y - bb.min.y) / 2,
      (bb.max.z - bb.min.z) / 2,
    );
  }
  // Explicit world-space hole rects for the vendor's hole cutter — the wrap
  // leg's hole lands on a wall the item is NOT attached to.
  const itemAny = item as unknown as {
    rotation?: { y: number };
    holeRects?: () => unknown[];
  };
  if (corner) {
    itemAny.holeRects = () => {
      const ry = itemAny.rotation?.y ?? 0;
      const wx = Math.cos(ry);
      const wz = -Math.sin(ry);
      const nx = Math.sin(ry);
      const nz = Math.cos(ry);
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
  if (item.metadata) item.metadata.unitConfig = config;
  item.redrawWall?.();
}

// --- Assign mode (Studio 100x #8): tap-order pick badges -------------------
//
// A small canvas-texture sprite per picked unit, same technique as
// ModelStudio's own measurement label (a redrawable CanvasTexture on a
// billboard Sprite) — kept local here rather than imported, since this
// viewer never reaches into the Studio editor's internals. depthTest:false
// so a badge always reads through the unit it's pinned to.

/** A fresh, unpainted numbered badge — reused in place (paintBadge repaints
 * its canvas) rather than recreated on every renumber. */
function makeBadgeSprite(): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.name = "assign-pick-badge";
  sprite.renderOrder = 1000;
  sprite.userData.canvas = canvas;
  sprite.scale.set(26, 26, 1); // cm — reads clearly without dwarfing the unit
  return sprite;
}

/** Redraw a badge's canvas with its current 1..N tap-order number. */
function paintBadge(sprite: THREE.Sprite, n: number): void {
  const canvas = sprite.userData.canvas as HTMLCanvasElement;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.beginPath();
  ctx.arc(32, 32, 29, 0, Math.PI * 2);
  ctx.fillStyle = "#ff6a1a"; // theme accent — same coral as INSTALLER_PALETTE[0]
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#fff";
  ctx.stroke();
  ctx.fillStyle = "#fff";
  ctx.font = "bold 30px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(n), 32, 34);
  (sprite.material.map as THREE.CanvasTexture).needsUpdate = true;
}

function disposeBadgeSprite(sprite: THREE.Sprite): void {
  (sprite.material.map as THREE.CanvasTexture | null)?.dispose();
  (sprite.material as THREE.Material).dispose();
}

export function JobModelViewer() {
  const { projectId = "" } = useParams();
  const [searchParams] = useSearchParams();

  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const project = projects.data?.find((p) => p.id === projectId);

  // Studio↔warehouse links (#15/#16/#18/#7): the SAME query keys ModelStudio
  // and the Warehouse hub already use, so a visit to any of them warms this
  // page's cache too. Job-scoped openings resolve a tapped mark to its
  // physical opening (for photos); packages/containers/locations answer
  // "where are the parts" on demand for whichever unit was tapped or the
  // job-building glow points at.
  const openings = useQuery({
    queryKey: ["openings", projectId],
    queryFn: () => listOpenings(projectId),
    enabled: Boolean(projectId),
  });

  // Tap-to-assign in 3D (Studio 100x #8): port of the fit-view map's own
  // Assign mode (MapsInteractive.tsx) onto this read-only viewer — same
  // foreman+ gate, same crew roster, same sequenced RPC path
  // (assignOpeningsInOrder), so a foreman never sees the two surfaces
  // disagree about who's assigned what or in which order.
  const queryClient = useQueryClient();
  const { effectiveRole } = useEffectiveRole();
  const canAssign = isForemanPlus(effectiveRole);
  const profiles = useQuery({
    queryKey: ["profiles"],
    queryFn: listProfiles,
    enabled: canAssign,
  });
  const activeCrew = useMemo(
    () => (profiles.data ?? []).filter((p) => p.active),
    [profiles.data],
  );
  // Stable installer -> color map, active-crew order — the SAME order
  // ProjectMap.tsx and DispatchBoard.tsx key their own installerColorMap
  // off, so an installer's glow color here never disagrees with the map's.
  const crewColors = useMemo(
    () => installerColorMap(activeCrew.map((c) => c.id)),
    [activeCrew],
  );

  const packages = useQuery({ queryKey: ["storagePackages"], queryFn: listActivePackages });
  const containers = useQuery({ queryKey: ["storageContainers"], queryFn: listContainers });
  const locations = useQuery({ queryKey: ["locations"], queryFn: listLocations });
  const containersById = useMemo(
    () => new Map((containers.data ?? []).map((c) => [c.id, c])),
    [containers.data],
  );
  const locationsById = useMemo(
    () => toLocationsById(locations.data ?? []),
    [locations.data],
  );

  // Job-building glow (#16): ?mark=CODE directly, or ?pkg=SERIAL resolved
  // to its tagged mark — same getPackageBySerial query ContainerViewer.tsx
  // already runs for its own ?pkg= glow, same 0xff5a36 @ 0.28 box.
  const markParam = searchParams.get("mark");
  const pkgParam = searchParams.get("pkg");
  const glowPkg = useQuery({
    queryKey: ["storagePackage", pkgParam ?? ""],
    queryFn: () => getPackageBySerial(pkgParam!),
    enabled: Boolean(pkgParam),
  });
  const glowCode = markParam ?? markOfPackage(glowPkg.data);

  // Same query key ModelStudio.tsx and MapsInteractive.tsx use for this job
  // — arriving here from the Maps Interactive "Walk the 3D model" button
  // reuses their already-warm cache instead of re-fetching.
  const outlines = useQuery({
    queryKey: ["planOutlines", projectId],
    queryFn: () => listPlanOutlines(projectId),
    enabled: Boolean(projectId),
  });
  const outline = useMemo(() => preferModelOutline(outlines.data ?? []), [outlines.data]);
  const liveModel = useMemo(() => jobModelFromFeatures(outline?.features), [outline]);

  // #29: this phone's own copy, read once per project and refreshed
  // whenever a live model loads. FAIL SOFT throughout — a cache miss must
  // never block the view.
  const [cached, setCached] = useState<Awaited<ReturnType<typeof readJobModel>>>(null);
  const [cacheChecked, setCacheChecked] = useState(false);
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setCacheChecked(false);
    void readJobModel(projectId).then((m) => {
      if (cancelled) return;
      setCached(m);
      setCacheChecked(true);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  useEffect(() => {
    if (liveModel && projectId) void writeJobModel(projectId, liveModel);
  }, [liveModel, projectId]);

  const resolved = resolveJobModel({
    live: liveModel,
    fetchFailed: outlines.isError,
    cached,
  });
  const savedSerialized = resolved.model?.floors?.[0] ?? resolved.model?.serialized ?? null;
  // A primitive (not `resolved.model` itself, a fresh object every render)
  // so the boot effect's dependency array is stable.
  const roofStyle = parseRoof(resolved.model);
  const stillWorking = !projectId || outlines.isLoading || !cacheChecked;

  const hostRef = useRef<HTMLDivElement | null>(null);
  const bpRef = useRef<Blueprint3d | null>(null);
  const [booted, setBooted] = useState(false);
  const [tap, setTap] = useState<{ mark: string; dims: string } | null>(null);
  // The tapped item's RAW mark (not the display fallback "Unit"), for the
  // package/photo lookups below — kept separate from `tap.mark` so an
  // unnamed item never gets treated as a real mark code.
  const [tapMark, setTapMark] = useState<string | null>(null);

  // Assign mode (Studio 100x #8): picked openings in tap order. The
  // toggle/order semantics themselves are mapDispatch's own
  // toggleSelection/orderNumberMap (already pure + tested for the map);
  // reused as-is here rather than reimplemented.
  const [assignMode, setAssignMode] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [selectedInstaller, setSelectedInstaller] = useState("");
  const [assigning, setAssigning] = useState(false);

  // Refs mirrored fresh every render so the tap-to-inspect/assign pointer
  // listener (a stable closure — see that effect below) and the item-loaded
  // callback (registered once at boot) always read the LATEST
  // openings/crew-colors/assign-mode instead of whatever was current when
  // they were created. Same stale-closure defense glowCodeRef uses just
  // below, and MapsInteractive.tsx's openingsRef/profilesRef.
  const openingsRef = useRef(openings.data);
  openingsRef.current = openings.data;
  const assignModeRef = useRef(false);
  assignModeRef.current = assignMode;
  const crewColorsRef = useRef<Map<string, string>>(new Map());
  crewColorsRef.current = crewColors;
  // Which live 3D item a picked opening id came from, so its number badge
  // attaches to the exact tapped object with no re-search of the scene.
  const pickedItemsRef = useRef<Map<string, StudioItem>>(new Map());

  // Job-building glow (#16): read inside the vendor's async item-load
  // callback below, same stale-closure defense the rest of this app's
  // imperative three.js listeners use (ModelStudio.tsx's overlayMapRef).
  const glowCodeRef = useRef<string | null>(null);
  const glowMeshesRef = useRef<{ parent: THREE.Object3D; mesh: THREE.Mesh }[]>([]);
  /**
   * Clears whatever is glowing and redraws for the CURRENT glow code.
   * Called after every item load — the vendor's GLB items arrive async,
   * one at a time (GLBLoader.ts), so the matching set is incomplete until
   * the last one lands — and again whenever the code itself changes post
   * boot. Added as a CHILD of the matched item so it inherits that item's
   * position/rotation for free: a rotated side-wall unit's box turns with
   * it instead of drawing axis-aligned over the wrong footprint.
   */
  const syncGlow = () => {
    const bp = bpRef.current;
    if (!bp) return;
    for (const { parent, mesh } of glowMeshesRef.current) {
      parent.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.MeshBasicMaterial).dispose();
    }
    glowMeshesRef.current = [];
    const code = glowCodeRef.current;
    if (!code) return;
    const items = bp.model.scene.getItems();
    const names = items
      .map((it) => it.metadata?.itemName)
      .filter((n): n is string => Boolean(n));
    const targets = new Set(unitsForMark(names, code));
    for (const it of items) {
      const name = it.metadata?.itemName;
      if (!name || !targets.has(name)) continue;
      const geo = new THREE.BoxGeometry(
        Math.max(it.halfSize.x * 2, 4),
        Math.max(it.halfSize.y * 2, 4),
        Math.max(it.halfSize.z * 2, 4),
      );
      const mat = new THREE.MeshBasicMaterial({
        color: 0xff5a36,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = "mark-glow";
      const parent = it as unknown as THREE.Object3D;
      parent.add(mesh);
      glowMeshesRef.current.push({ parent, mesh });
    }
  };
  useEffect(() => {
    glowCodeRef.current = glowCode;
    if (booted) syncGlow();
    // syncGlow reads bpRef/glowCodeRef/glowMeshesRef fresh every call, so
    // it never needs to be a dependency itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glowCode, booted]);

  // Installer color glow (Studio 100x #8): while assign mode is on, every
  // ALREADY-assigned unit glows in its installer's color — same
  // installerColorMap the map uses, so a foreman sees at a glance who has
  // what before tapping the next batch. A different layer from the pick
  // badges below: this reflects SAVED assignments (openings.data), not the
  // in-progress selection.
  const assignGlowMeshesRef = useRef<{ parent: THREE.Object3D; mesh: THREE.Mesh }[]>([]);
  const syncAssignGlow = () => {
    const bp = bpRef.current;
    if (!bp) return;
    for (const { parent, mesh } of assignGlowMeshesRef.current) {
      parent.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.MeshBasicMaterial).dispose();
    }
    assignGlowMeshesRef.current = [];
    if (!assignModeRef.current) return;
    const allOpenings = openingsRef.current ?? [];
    for (const it of bp.model.scene.getItems()) {
      const mark = it.metadata?.itemName?.trim() || null;
      const id = openingIdForMark(allOpenings, mark);
      const installerId = id ? allOpenings.find((o) => o.id === id)?.assigned_to : null;
      const color = installerId ? crewColorsRef.current.get(installerId) : undefined;
      if (!color) continue;
      const geo = new THREE.BoxGeometry(
        Math.max(it.halfSize.x * 2, 4),
        Math.max(it.halfSize.y * 2, 4),
        Math.max(it.halfSize.z * 2, 4),
      );
      const mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = "assign-installer-glow";
      const parent = it as unknown as THREE.Object3D;
      parent.add(mesh);
      assignGlowMeshesRef.current.push({ parent, mesh });
    }
  };
  useEffect(() => {
    if (booted) syncAssignGlow();
    // syncAssignGlow reads every ref fresh, so none of them need to be
    // dependencies themselves — only what should TRIGGER a re-sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignMode, openings.data, crewColors, booted]);

  // Pick-order badges: a small numbered sprite per picked unit, renumbered
  // together whenever the selection changes (mapDispatch.orderNumberMap) so
  // un-picking #1 of 3 relabels the rest 1..2 exactly like the map's own
  // tap-order renumbering.
  const badgeSpritesRef = useRef<Map<string, THREE.Sprite>>(new Map());
  useEffect(() => {
    if (!booted) return;
    for (const [id, sprite] of badgeSpritesRef.current) {
      if (picked.includes(id)) continue;
      sprite.parent?.remove(sprite);
      disposeBadgeSprite(sprite);
      badgeSpritesRef.current.delete(id);
    }
    const numbers = orderNumberMap(picked);
    for (const id of picked) {
      const item = pickedItemsRef.current.get(id);
      const n = numbers.get(id);
      if (!item || n == null) continue;
      let sprite = badgeSpritesRef.current.get(id);
      if (!sprite) {
        sprite = makeBadgeSprite();
        sprite.position.set(0, item.halfSize.y + 15, 0);
        (item as unknown as THREE.Object3D).add(sprite);
        badgeSpritesRef.current.set(id, sprite);
      }
      paintBadge(sprite, n);
    }
  }, [picked, booted]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !savedSerialized || bpRef.current) return;
    host.innerHTML = "";
    const el = document.createElement("div");
    el.id = "job-model-viewer-three";
    el.style.width = "100%";
    el.style.height = "100%";
    host.appendChild(el);

    // widget mode: no floorplanner pane… but it also disables the orbit
    // controller, so re-enable it — LOOKING is the whole feature (same
    // pattern as ContainerViewer).
    const bp = new Blueprint3d({
      widget: true,
      threeElement: "#job-model-viewer-three",
      textureDir: "/modelstudio/",
      enableWheelZoom: true,
      alwaysSpin: false,
    });
    bp.three.getController().enabled = true;
    bpRef.current = bp;
    // Debug/e2e handle, mirrors ModelStudio's __studio — harmless in prod.
    (window as { __jobModelViewer?: unknown }).__jobModelViewer = bp;

    // Every wall-mounted unit rebuilds its real shape and re-attaches to
    // its wall (cutting the hole) — the serialized model only stores a
    // placeholder box plus this metadata. Everything is furniture, not
    // controls: every item ends up pinned where it stands.
    bp.model.scene.itemLoadedCallbacks.add((it) => {
      try {
        const cfg = it?.metadata?.unitConfig as UnitConfig | undefined;
        if (cfg?.panels?.length) applyUnitGeometry(it, cfg);
        it.placeInRoom();
        (it as { fixed?: boolean }).fixed = true;
      } catch {
        /* not an item that needs help */
      }
      // Re-decide the glows every time one more item lands — items arrive
      // one at a time, so the match set is only complete once the last
      // one has loaded.
      syncGlow();
      syncAssignGlow();
    });

    bp.model.loadSerialized(savedSerialized);

    // Studio 100x #49: the same flat-parapet roof Studio can draw over the
    // top floor — this viewer only ever loads floor 0 (see savedSerialized
    // above, a pre-existing scope limit), so the roof caps whatever it
    // loaded, same as it caps the top floor there.
    if (roofStyle === "flat") {
      const { walls } = parseFloorLite(savedSerialized);
      const roof = buildRoof(walls, 0);
      if (roof) bp.model.scene.getScene().add(roof);
    }

    setBooted(true);
    return () => {
      bpRef.current = null;
    };
  }, [savedSerialized, roofStyle]);

  // Tap-to-inspect: the vendor's own hover-based item selection never fires
  // on a touchscreen (there is no hover before a tap), so a plain raycast
  // on pointer-up stands in. Pointer events (not mouse/click) so this works
  // identically whether the crew member is on a phone or a laptop trackpad,
  // and fire regardless of whatever the orbit controller's own touch
  // handling does with the touch event underneath. A move past 6px between
  // down and up is an orbit drag, not a tap.
  useEffect(() => {
    const bp = bpRef.current;
    if (!bp || !booted) return;
    const el = bp.three.element;
    const ray = new THREE.Raycaster();
    let downX = 0;
    let downY = 0;
    const pickAt = (px: number, py: number): StudioItem | null => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      const ndc = new THREE.Vector2(
        ((px - rect.left) / rect.width) * 2 - 1,
        -((py - rect.top) / rect.height) * 2 + 1,
      );
      ray.setFromCamera(ndc, bp.three.camera);
      const items = bp.model.scene.getItems() as unknown as THREE.Object3D[];
      return (ray.intersectObjects(items, false)[0]?.object ?? null) as unknown as StudioItem | null;
    };
    const onDown = (e: PointerEvent) => {
      downX = e.clientX;
      downY = e.clientY;
    };
    const onUp = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return;
      const hit = pickAt(e.clientX, e.clientY);
      // Assign mode (Studio 100x #8): a tap picks/un-picks the unit instead
      // of opening the inspect line — same split fitviewRenderer's own
      // togglePick-vs-select branch makes on the map. Only a unit that
      // resolves to a real opening is pickable, same as the map's own
      // pins (each already IS one opening).
      if (assignModeRef.current) {
        const mark = (hit?.metadata as { itemName?: string } | undefined)?.itemName?.trim() || null;
        const id = openingIdForMark(openingsRef.current ?? [], mark);
        if (id && hit) {
          if (pickedItemsRef.current.has(id)) pickedItemsRef.current.delete(id);
          else pickedItemsRef.current.set(id, hit);
          setPicked((p) => toggleSelection(p, id));
        }
        return;
      }
      const metadata = hit?.metadata as
        | { itemName?: string; unitConfig?: UnitConfig }
        | undefined;
      setTap(hit ? unitTapInfo(metadata ?? null, hit.getWidth(), hit.getHeight()) : null);
      setTapMark(hit ? metadata?.itemName?.trim() || null : null);
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
    };
  }, [booted]);

  // Where's-my-glass tap-through (#15/#18): on demand, for whichever unit
  // was just tapped — the SAME unitPackageLine wording ModelStudio.tsx
  // shows, so the two screens never say it differently.
  const tapMarkKey = tapMark ? markKeyOf(tapMark) : null;
  const tapPartsReport = useMemo(
    () => (tapMarkKey ? unitParts(packages.data ?? [], projectId, tapMarkKey) : null),
    [tapMarkKey, packages.data, projectId],
  );
  const tapPackageLine = useMemo(
    () =>
      tapPartsReport ? unitPackageLine(tapPartsReport, containersById, locationsById) : null,
    [tapPartsReport, containersById, locationsById],
  );

  // Photo pins (#7): the tapped unit's own opening (twin-aware, same
  // match every live signal uses), then its install record's media —
  // fetched only once a unit is actually tapped, signed lazily just like
  // the Record card itself, same query keys so a job already opened there
  // is a cache hit here too.
  const tapOpeningId = useMemo(
    () => openingIdForMark(openings.data ?? [], tapMark),
    [tapMark, openings.data],
  );
  const tapEvents = useQuery({
    queryKey: ["recordEvents", tapOpeningId],
    queryFn: () => listOpeningInstallEvents(tapOpeningId!),
    enabled: Boolean(tapOpeningId),
  });
  const tapMedia = useQuery({
    queryKey: ["recordMedia", tapOpeningId, (tapEvents.data ?? []).length],
    queryFn: () => listInstallMedia((tapEvents.data ?? []).map((e) => e.id)),
    enabled: Boolean(tapOpeningId) && (tapEvents.data?.length ?? 0) > 0,
  });
  // Most recent first — listInstallMedia orders ascending, so the last 3
  // are the newest 3.
  const tapPhotos = useMemo(
    () =>
      (tapMedia.data ?? [])
        .filter((m) => m.kind === "photo" && m.signedUrl)
        .slice(-3)
        .reverse(),
    [tapMedia.data],
  );

  // Enter/exit assign mode — clears any in-progress pick either way, same
  // as the map's enterAssign/exitAssign both resetting state.picked.
  const toggleAssignMode = () => {
    setAssignMode((on) => !on);
    setPicked([]);
    pickedItemsRef.current.clear();
    setSelectedInstaller("");
    setTap(null);
    setTapMark(null);
  };

  // Assign: the same sequenced RPC path the map uses (assignOpeningsInOrder
  // — mapDispatch's pure sequencing under a Supabase-calling orchestration
  // both surfaces share), same "openings" invalidation so the Dispatch
  // board reflects it immediately, same toast wording. Mode stays ON and
  // only the picks/installer reset, so a foreman can assign the next batch
  // without re-entering — unlike the map, which exits on every assign.
  const handleAssign = () => {
    if (picked.length === 0 || !selectedInstaller || assigning) return;
    const ids = [...picked];
    const n = ids.length;
    setAssigning(true);
    void (async () => {
      try {
        await assignOpeningsInOrder(openingsRef.current ?? [], ids, selectedInstaller);
        await queryClient.invalidateQueries({ queryKey: ["openings", projectId] });
        pushToast(`${n} unit${n === 1 ? "" : "s"} assigned.`);
        setPicked([]);
        pickedItemsRef.current.clear();
        setSelectedInstaller("");
      } catch (e) {
        pushToast(formatApiError(e), "error");
      } finally {
        setAssigning(false);
      }
    })();
  };

  return (
    <div className="page" style={{ display: "flex", flexDirection: "column", minHeight: "100dvh" }}>
      <header className="page-header">
        <div>
          <BackChip />
          <p className="home-greeting">{project?.job_code ?? "Job"}</p>
          <h1>{project?.name ?? "3D model"} in 3D</h1>
          {glowCode && (
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              Window {glowCode} glows below
            </p>
          )}
        </div>
      </header>

      {stillWorking ? (
        <p className="muted">Loading the model…</p>
      ) : !savedSerialized ? (
        <div className="empty-state">
          <h3>No 3D model yet</h3>
          <p className="muted">
            This job doesn't have a saved Studio model yet. A supervisor
            builds one from the job's Maps Interactive tab, and it opens
            here for the whole crew to walk through.
          </p>
        </div>
      ) : (
        <>
          {resolved.fromCache && (
            <p className="muted" style={{ margin: "0 0 8px", fontSize: 13 }}>
              No signal — showing this phone's saved copy
              {cached ? `, from ${describeAge(cached.cachedAt)}` : ""}.
            </p>
          )}
          {/* Tap-to-assign in 3D (Studio 100x #8) — foreman+ only, same
              gate the fit-view map's own Assign button uses. */}
          {canAssign && (
            <button
              type="button"
              className={assignMode ? "button-like active-pill" : "button-like"}
              aria-pressed={assignMode}
              style={{ marginBottom: 8, alignSelf: "flex-start" }}
              onClick={toggleAssignMode}
            >
              {assignMode ? "Assign: on" : "Assign"}
            </button>
          )}
          <div
            ref={hostRef}
            style={{ flex: 1, minHeight: 420, borderRadius: 12, overflow: "hidden" }}
          />
          {assignMode && (
            <div
              style={{
                margin: "8px 0 0",
                padding: 10,
                borderRadius: 12,
                background: "var(--card-raised, rgba(255,255,255,0.06))",
              }}
            >
              <b>{picked.length} picked</b>
              <label style={{ display: "block", marginTop: 8 }}>
                <span className="field-label">Installer</span>
                <select
                  value={selectedInstaller}
                  onChange={(e) => setSelectedInstaller(e.target.value)}
                >
                  <option value="">Choose an installer…</option>
                  {activeCrew.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.display_name}
                      {c.role !== "installer" ? ` (${c.role})` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="button-like button-like--primary"
                style={{ marginTop: 8 }}
                disabled={picked.length === 0 || !selectedInstaller || assigning}
                onClick={handleAssign}
              >
                {assigning ? "Assigning…" : "Assign"}
              </button>
            </div>
          )}
          {tap && (
            <div style={{ margin: "8px 0 0" }}>
              <p className="muted" style={{ fontSize: 13, margin: 0 }}>
                {tap.mark} — {tap.dims}
              </p>
              {/* Where's-my-glass tap-through (#15/#18). */}
              {tapPackageLine && (
                <>
                  <p className="muted" style={{ fontSize: 12.5, margin: "2px 0 0" }}>
                    {tapPackageLine}
                  </p>
                  <Link
                    className="button-like studio-mini"
                    style={{ marginTop: 4 }}
                    to={`/warehouse?q=${encodeURIComponent(tapMarkKey ?? "")}`}
                  >
                    Find it in the warehouse
                  </Link>
                </>
              )}
              {/* Photo pins (#7): up to 3 thumbnails, signed lazily just
                  like the Unit Record — nothing signs until this unit is
                  actually tapped. */}
              {tapPhotos.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  <div className="row-gap" style={{ flexWrap: "wrap" }}>
                    {tapPhotos.map((m) => (
                      <a key={m.id} href={m.signedUrl!} target="_blank" rel="noreferrer">
                        <img
                          src={m.signedUrl!}
                          alt="Install"
                          style={{ height: 56, borderRadius: 6 }}
                        />
                      </a>
                    ))}
                  </div>
                  {tapOpeningId && (
                    <Link
                      to={`/projects/${projectId}/opening/${tapOpeningId}`}
                      style={{ fontSize: 12 }}
                    >
                      See all on the Unit Record
                    </Link>
                  )}
                </div>
              )}
            </div>
          )}
          <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
            {assignMode
              ? "Tap units to pick them, in order · then choose an installer and Assign."
              : "Drag to orbit · pinch or scroll to zoom · tap a window or door for its size. Nothing here can be moved — this is the map, not the pen."}
          </p>
        </>
      )}
    </div>
  );
}
