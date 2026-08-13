// Grab-and-stretch handles on the selected unit or wall in the 3D pane —
// the Home-Design-3D-style editing the owner asked for. Research verdict
// (2026-08-13): the published gizmos (three-gizmo, three-pivot-controls,
// TransformControls) are generic move/rotate/scale rigs; trade editing
// wants EDGE handles constrained to a wall's own axes, driving the same
// math as the numeric cards. That is ~150 lines of raycast, so it lives
// here with no new dependency.
//
// The module owns only the meshes and the drag math. The page owns every
// mutation: each drag reports (kind, deltaCm since grab, phase) and the
// page applies it through the same helpers the numeric inputs use.

import * as THREE from "three";

export type UnitHandleKind = "width-left" | "width-right" | "height" | "sill";
export type WallHandleKind = "length-start" | "length-end" | "height" | "slide";

export interface UnitHandleSpec {
  /** Unit centre, world cm. */
  center: { x: number; y: number; z: number };
  /** Yaw — the vendor's wall alignment. Local +x is the outside viewer's left. */
  rotationY: number;
  widthCm: number;
  heightCm: number;
}

export interface WallHandleSpec {
  start: { x: number; z: number };
  end: { x: number; z: number };
  heightCm: number;
}

export interface Handles3dHost {
  scene: THREE.Scene;
  camera: THREE.Camera;
  /** The 3D pane container — the renderer canvas is inside it. */
  element: HTMLElement;
  controls: { enabled: boolean };
  /** Snapshot state for the drag (push undo, capture baselines). */
  onGrab(): void;
  onUnitDrag(kind: UnitHandleKind, deltaCm: number, phase: "move" | "end"): void;
  onWallDrag(kind: WallHandleKind, deltaCm: number, phase: "move" | "end"): void;
}

interface HandleDef {
  kind: UnitHandleKind | WallHandleKind;
  target: "unit" | "wall";
  /** Drag axis, world unit vector. Positive delta = "outward/up/along". */
  axis: THREE.Vector3;
  mesh: THREE.Mesh;
}

const HANDLE_RADIUS = 10; // cm — chunky enough to grab at building scale
const COLOR: Record<string, number> = {
  "width-left": 0x2bb3c8,
  "width-right": 0x2bb3c8,
  height: 0xf29e38,
  sill: 0x53c46c,
  "length-start": 0x2bb3c8,
  "length-end": 0x2bb3c8,
  slide: 0xa78bfa,
};

export class StudioHandles3d {
  private readonly host: Handles3dHost;
  private readonly group = new THREE.Group();
  private handles: HandleDef[] = [];
  private readonly ray = new THREE.Raycaster();
  private drag: {
    def: HandleDef;
    origin: THREE.Vector3;
    startT: number;
  } | null = null;

  private readonly onDown: (e: MouseEvent) => void;
  private readonly onMove: (e: MouseEvent) => void;
  private readonly onUp: (e: MouseEvent) => void;

  constructor(host: Handles3dHost) {
    this.host = host;
    this.group.renderOrder = 999;
    host.scene.add(this.group);
    this.onDown = this.handleDown.bind(this);
    this.onMove = this.handleMove.bind(this);
    this.onUp = this.handleUp.bind(this);
    // Capture phase: the event's target is the renderer canvas INSIDE the
    // container, so this runs before the vendor's own bubble listeners —
    // stopPropagation keeps a handle grab from also starting an orbit.
    host.element.addEventListener("mousedown", this.onDown, true);
    window.addEventListener("mousemove", this.onMove, true);
    window.addEventListener("mouseup", this.onUp, true);
  }

  dispose(): void {
    this.clear();
    this.host.scene.remove(this.group);
    this.host.element.removeEventListener("mousedown", this.onDown, true);
    window.removeEventListener("mousemove", this.onMove, true);
    window.removeEventListener("mouseup", this.onUp, true);
  }

  clear(): void {
    for (const h of this.handles) {
      this.group.remove(h.mesh);
      h.mesh.geometry.dispose();
      (h.mesh.material as THREE.Material).dispose();
    }
    this.handles = [];
    this.drag = null;
  }

  /** Four handles: pull a side to widen, the top to raise the head, the
   * bottom to lift the whole unit off the floor (sill). */
  attachUnit(spec: UnitHandleSpec): void {
    this.clear();
    const ry = spec.rotationY;
    const wx = Math.cos(ry);
    const wz = -Math.sin(ry); // world width axis (local +x)
    const off = spec.widthCm / 2 + HANDLE_RADIUS * 1.6;
    const c = spec.center;
    this.add("width-left", "unit", new THREE.Vector3(wx, 0, wz),
      new THREE.Vector3(c.x + wx * off, c.y, c.z + wz * off));
    this.add("width-right", "unit", new THREE.Vector3(-wx, 0, -wz),
      new THREE.Vector3(c.x - wx * off, c.y, c.z - wz * off));
    const vOff = spec.heightCm / 2 + HANDLE_RADIUS * 1.6;
    this.add("height", "unit", new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(c.x, c.y + vOff, c.z));
    this.add("sill", "unit", new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(c.x, Math.max(HANDLE_RADIUS, c.y - vOff), c.z));
  }

  /** Ends slide the wall longer/shorter; the top mid handle sets height;
   * the purple mid handle DRAGS the whole wall along its own perpendicular
   * (owner ask: "click on walls and drag them around" in 3D). */
  attachWall(spec: WallHandleSpec): void {
    this.clear();
    const dx = spec.end.x - spec.start.x;
    const dz = spec.end.z - spec.start.z;
    const len = Math.hypot(dx, dz) || 1;
    const ax = dx / len;
    const az = dz / len;
    const top = spec.heightCm + HANDLE_RADIUS * 1.6;
    const midX = (spec.start.x + spec.end.x) / 2;
    const midZ = (spec.start.z + spec.end.z) / 2;
    this.add("length-start", "wall", new THREE.Vector3(-ax, 0, -az),
      new THREE.Vector3(spec.start.x, top, spec.start.z));
    this.add("length-end", "wall", new THREE.Vector3(ax, 0, az),
      new THREE.Vector3(spec.end.x, top, spec.end.z));
    this.add("height", "wall", new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(midX, top + HANDLE_RADIUS, midZ));
    // Perpendicular = rotate the wall direction 90° in plan.
    this.add("slide", "wall", new THREE.Vector3(-az, 0, ax),
      new THREE.Vector3(midX, spec.heightCm * 0.55, midZ));
  }

  private add(
    kind: UnitHandleKind | WallHandleKind,
    target: "unit" | "wall",
    axis: THREE.Vector3,
    at: THREE.Vector3,
  ): void {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(HANDLE_RADIUS, 16, 12),
      new THREE.MeshBasicMaterial({
        color: COLOR[kind] ?? 0x2bb3c8,
        depthTest: false,
        transparent: true,
        opacity: 0.92,
      }),
    );
    mesh.renderOrder = 999;
    mesh.position.copy(at);
    this.group.add(mesh);
    this.handles.push({ kind, target, axis: axis.clone().normalize(), mesh });
  }

  /** Mouse position → NDC within the pane. */
  private ndc(e: MouseEvent): THREE.Vector2 | null {
    const r = this.host.element.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    const x = ((e.clientX - r.left) / r.width) * 2 - 1;
    const y = -((e.clientY - r.top) / r.height) * 2 + 1;
    if (x < -1 || x > 1 || y < -1 || y > 1) return null;
    return new THREE.Vector2(x, y);
  }

  /** Parameter along the drag axis closest to the mouse ray (cm). */
  private axisT(e: MouseEvent, origin: THREE.Vector3, axis: THREE.Vector3): number {
    const p = this.ndc(e);
    if (!p) return 0;
    this.ray.setFromCamera(p, this.host.camera as THREE.PerspectiveCamera);
    const ro = this.ray.ray.origin;
    const rd = this.ray.ray.direction;
    // Closest points of two lines: origin+t*axis and ro+s*rd.
    const w0 = new THREE.Vector3().subVectors(origin, ro);
    const a = axis.dot(axis);
    const b = axis.dot(rd);
    const c = rd.dot(rd);
    const d = axis.dot(w0);
    const ee = rd.dot(w0);
    const denom = a * c - b * b;
    if (Math.abs(denom) < 1e-6) return 0; // axis parallel to the view ray
    return (b * ee - c * d) / denom;
  }

  private handleDown(e: MouseEvent): void {
    if (this.handles.length === 0 || e.button !== 0) return;
    const p = this.ndc(e);
    if (!p) return;
    this.ray.setFromCamera(p, this.host.camera as THREE.PerspectiveCamera);
    const hit = this.ray.intersectObjects(this.handles.map((h) => h.mesh), false)[0];
    if (!hit) return;
    const def = this.handles.find((h) => h.mesh === hit.object);
    if (!def) return;
    e.stopPropagation();
    e.preventDefault();
    this.host.controls.enabled = false;
    const origin = def.mesh.position.clone();
    this.drag = { def, origin, startT: this.axisT(e, origin, def.axis) };
    this.host.element.style.cursor = "grabbing";
    this.host.onGrab();
  }

  private handleMove(e: MouseEvent): void {
    if (!this.drag) {
      // Hover affordance only when handles exist.
      if (this.handles.length === 0) return;
      const p = this.ndc(e);
      if (!p) return;
      this.ray.setFromCamera(p, this.host.camera as THREE.PerspectiveCamera);
      const over = this.ray.intersectObjects(this.handles.map((h) => h.mesh), false).length > 0;
      this.host.element.style.cursor = over ? "grab" : "";
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    const { def, origin, startT } = this.drag;
    const delta = this.axisT(e, origin, def.axis) - startT;
    if (def.target === "unit") {
      this.host.onUnitDrag(def.kind as UnitHandleKind, delta, "move");
    } else {
      this.host.onWallDrag(def.kind as WallHandleKind, delta, "move");
    }
  }

  private handleUp(e: MouseEvent): void {
    if (!this.drag) return;
    e.stopPropagation();
    const { def, origin, startT } = this.drag;
    const delta = this.axisT(e, origin, def.axis) - startT;
    this.drag = null;
    this.host.controls.enabled = true;
    this.host.element.style.cursor = "";
    if (def.target === "unit") {
      this.host.onUnitDrag(def.kind as UnitHandleKind, delta, "end");
    } else {
      this.host.onWallDrag(def.kind as WallHandleKind, delta, "end");
    }
  }
}
