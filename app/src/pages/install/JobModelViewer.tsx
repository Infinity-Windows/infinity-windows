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
import { useQuery } from "@tanstack/react-query";
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
import { listOpenings, listPlanOutlines } from "../../lib/install/api";
import {
  listInstallMedia,
  listOpeningInstallEvents,
} from "../../lib/install/record";
import { listLocations, listProjects } from "../../lib/api";
import { getPackageBySerial, listActivePackages, listContainers } from "../../lib/storage";
import { toLocationsById } from "../../lib/warehouse/containment";
import { unitPackageLine, unitParts } from "../../lib/warehouse/unitParts";
import { normalizeMarkCode, preferModelOutline } from "../../lib/fitview/adapter";
import {
  describeAge,
  readJobModel,
  resolveJobModel,
  writeJobModel,
} from "../../lib/install/jobModelCache";

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
      // Re-decide the glow every time one more item lands — items arrive
      // one at a time, so the match set is only complete once the last
      // one has loaded.
      syncGlow();
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
  const tapOpeningId = useMemo(() => {
    if (!tapMark) return null;
    const norm = normalizeMarkCode(tapMark);
    return (
      (openings.data ?? []).find((o) => normalizeMarkCode(o.opening_code) === norm)?.id ?? null
    );
  }, [tapMark, openings.data]);
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
          <div
            ref={hostRef}
            style={{ flex: 1, minHeight: 420, borderRadius: 12, overflow: "hidden" }}
          />
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
            Drag to orbit · pinch or scroll to zoom · tap a window or door for
            its size. Nothing here can be moved — this is the map, not the
            pen.
          </p>
        </>
      )}
    </div>
  );
}
