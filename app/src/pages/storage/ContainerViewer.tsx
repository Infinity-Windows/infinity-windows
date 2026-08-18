// The installer's window into a container's 3D shell (ticket 22, slice 3).
//
// Read-only on purpose, and NOT the Studio: installers never see the
// supervisor editor, and this page can't edit anything — it mounts the same
// engine, loads the same saved model, wires NO tools, and locks every item
// in place. What it adds is the one thing the map exists for: the glowing
// zone where a package sits, read straight off its area (ADR-0006).
//
// Zone geometry leans on a convention the shell generator pinned with a
// test: the DOOR END of a movable box is +x. Front/middle/back are thirds
// along x. The building gets a 3×3 compass grid; north is -y (the "back
// left" corner of a generated shell), and the floor wears a compass mark so
// the convention is visible instead of secret.

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import * as THREE from "three";
import { useQuery } from "@tanstack/react-query";
import { BackChip } from "../../components/BackChip";
import { Blueprint3d } from "../../lib/modelstudio/core";
import { getStudioProject } from "../../lib/modelstudio/projects";
import { buildShelfGeometry, normalizeShelfConfig } from "../../lib/modelstudio/shelfGeometry";
import {
  containerKind,
  getPackageBySerial,
  listContainers,
} from "../../lib/storage";
import { areaLabel } from "../../lib/warehouse/areas";

/** The floor-plan footprint of the loaded model, from its serialized corners. */
export function modelBounds(serialized: string): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} | null {
  try {
    const parsed = JSON.parse(serialized) as {
      floorplan?: { corners?: Record<string, { x: number; y: number }> };
    };
    const corners = Object.values(parsed.floorplan?.corners ?? {});
    if (corners.length === 0) return null;
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    return {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    };
  } catch {
    return null;
  }
}

/**
 * The zone an area names, as a plan-rectangle inside the bounds. Movable
 * boxes: thirds along x, front = the +x (door) end. The building: a 3×3
 * compass grid, north = -y.
 */
export function zoneRect(
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  area: string,
  kind: string,
): { x0: number; x1: number; y0: number; y1: number } | null {
  const W = bounds.maxX - bounds.minX;
  const D = bounds.maxY - bounds.minY;
  if (kind !== "building") {
    const third = W / 3;
    if (area === "front")
      return { x0: bounds.maxX - third, x1: bounds.maxX, y0: bounds.minY, y1: bounds.maxY };
    if (area === "middle")
      return { x0: bounds.minX + third, x1: bounds.maxX - third, y0: bounds.minY, y1: bounds.maxY };
    if (area === "back")
      return { x0: bounds.minX, x1: bounds.minX + third, y0: bounds.minY, y1: bounds.maxY };
    return null;
  }
  const col = (i: number) => bounds.minX + (W / 3) * i;
  const row = (i: number) => bounds.minY + (D / 3) * i;
  // Columns run west→east along x, rows run north→south along y.
  const GRID: Record<string, [number, number]> = {
    northwest: [0, 0], north: [1, 0], northeast: [2, 0],
    west: [0, 1], middle: [1, 1], east: [2, 1],
    southwest: [0, 2], south: [1, 2], southeast: [2, 2],
  };
  const cell = GRID[area];
  if (!cell) return null;
  const [cx, cy] = cell;
  return { x0: col(cx), x1: col(cx + 1), y0: row(cy), y1: row(cy + 1) };
}

export function ContainerViewer() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const glowSerial = params.get("pkg");

  const containers = useQuery({ queryKey: ["storageContainers"], queryFn: listContainers });
  const container = (containers.data ?? []).find((c) => c.id === id) ?? null;
  const project = useQuery({
    queryKey: ["studioProject", container?.studio_project_id ?? ""],
    queryFn: () => getStudioProject(container!.studio_project_id!),
    enabled: Boolean(container?.studio_project_id),
  });
  const glowPkg = useQuery({
    queryKey: ["storagePackage", glowSerial ?? ""],
    queryFn: () => getPackageBySerial(glowSerial!),
    enabled: Boolean(glowSerial),
  });

  const hostRef = useRef<HTMLDivElement | null>(null);
  const bpRef = useRef<Blueprint3d | null>(null);
  const [booted, setBooted] = useState(false);

  const serialized = useMemo(() => {
    const m = project.data?.model;
    if (!m) return null;
    if (m.floors?.length) return m.floors[0] ?? null;
    return m.serialized ?? null;
  }, [project.data]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !serialized || bpRef.current) return;
    host.innerHTML = "";
    const el = document.createElement("div");
    el.id = "container-viewer-three";
    el.style.width = "100%";
    el.style.height = "100%";
    host.appendChild(el);

    // widget mode: no floorplanner pane… but it also disables the orbit
    // controller, so re-enable it — LOOKING is the whole feature.
    const bp = new Blueprint3d({
      widget: true,
      threeElement: "#container-viewer-three",
      textureDir: "/modelstudio/",
      enableWheelZoom: true,
      alwaysSpin: false,
    });
    bp.three.getController().enabled = true;
    bpRef.current = bp;

    // Everything in a viewer is furniture, not controls: shelves rebuild
    // their racks, and every item is pinned where it stands.
    bp.model.scene.itemLoadedCallbacks.add((it) => {
      try {
        const cfg = normalizeShelfConfig(it?.metadata?.shelfConfig);
        if (cfg) {
          const built = buildShelfGeometry(cfg);
          it.geometry.dispose();
          (it as { geometry: unknown }).geometry = built.geometry;
          (it as { material: unknown }).material = built.materials;
          it.scale.set(1, 1, 1);
        }
        (it as { fixed?: boolean }).fixed = true;
      } catch {
        /* not an item that needs help */
      }
    });

    bp.model.loadSerialized(serialized);
    setBooted(true);
    return () => {
      bpRef.current = null;
    };
  }, [serialized]);

  // The glow: a translucent pillar over the package's zone.
  const area = glowPkg.data?.area ?? null;
  useEffect(() => {
    const bp = bpRef.current;
    if (!bp || !booted || !serialized) return;
    // The overlay lives in the model scene, beside the items themselves.
    const sceneObj = bp.model.scene.getScene();

    const bounds = modelBounds(serialized);
    if (!bounds || !area || !container) return;
    const rect = zoneRect(bounds, area, containerKind(container));
    if (!rect) return;

    const height = 40;
    const geo = new THREE.BoxGeometry(rect.x1 - rect.x0, height, rect.y1 - rect.y0);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xff5a36,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    });
    const glow = new THREE.Mesh(geo, mat);
    glow.position.set(
      (rect.x0 + rect.x1) / 2,
      height / 2,
      (rect.y0 + rect.y1) / 2,
    );
    sceneObj.add(glow);
    return () => {
      sceneObj.remove(glow);
      geo.dispose();
      mat.dispose();
    };
  }, [booted, serialized, area, container]);

  const kind = container ? containerKind(container) : "conex";

  return (
    <div className="page" style={{ display: "flex", flexDirection: "column", minHeight: "100dvh" }}>
      <header className="page-header">
        <div>
          <BackChip />
          <p className="home-greeting">Warehouse</p>
          <h1>{container?.name ?? "Container"} in 3D</h1>
          {glowSerial && (
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              {glowPkg.data
                ? area
                  ? `${glowSerial} — the ${areaLabel(area).toLowerCase()} zone glows`
                  : `${glowSerial} — no area recorded; a foreman can point at it from the package page`
                : glowSerial}
            </p>
          )}
        </div>
      </header>
      {!container?.studio_project_id && containers.isSuccess && (
        <p className="muted">
          This container has no 3D shell yet — a supervisor creates one from
          its page.
        </p>
      )}
      <div
        ref={hostRef}
        style={{ flex: 1, minHeight: 420, borderRadius: 12, overflow: "hidden" }}
      />
      <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
        {kind === "building"
          ? "Compass zones: north is the back-left of the drawing."
          : "The door end is the front."}
        {" "}Drag to orbit · pinch or scroll to zoom. Nothing here can be moved —
        this is the map, not the pen.
      </p>
      {container && (
        <Link className="button-like" style={{ marginTop: 8 }} to={`/storage/c/${container.id}`}>
          Open {container.name}
        </Link>
      )}
    </div>
  );
}
