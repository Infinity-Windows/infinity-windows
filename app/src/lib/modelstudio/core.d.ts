// Hand-written types for exactly the vendor surface the Studio uses.
// See core.js for why this boundary exists.

import type * as THREE from "three";

export interface StudioOptions {
  widget?: boolean;
  threeElement?: string;
  floorplannerElement?: string;
  textureDir?: string;
  enableWheelZoom?: boolean;
  alwaysSpin?: boolean;
}

export interface StudioVector3 {
  x: number;
  y: number;
  z: number;
}

export interface StudioCorner {
  x: number;
  y: number;
  move(x: number, y: number): void;
}

/** A wall's material choice, one per face — the vendor's own persisted
 * shape (see vendor/model/wall.ts, vendor/model/floorplan.ts's
 * SavedFloorplan). `stretch: true, scale: 0` is a flat-color swatch tiled
 * to fit; `stretch: false` repeats the texture every `scale` cm (Studio
 * 100x #46 — see lib/modelstudio/finishes.ts). */
export interface StudioTexture {
  url: string;
  stretch?: boolean;
  scale: number;
}

export interface StudioWall {
  /** Per-wall height, cm — defaults to the building-wide config value. */
  height: number;
  remove(): void;
  fireRedraw?(): void;
  getStart(): StudioCorner;
  getEnd(): StudioCorner;
  getStartX(): number;
  getStartY(): number;
  getEndX(): number;
  getEndY(): number;
  /** Recreated on every floorplan update — re-read, never cache. The
   * invisible pick plane's geometry doubles as the selection highlight. */
  frontEdge?: { plane?: THREE.Mesh } | null;
  backEdge?: { plane?: THREE.Mesh } | null;
  /** Public vendor fields (Wall.frontTexture/backTexture) — set both to
   * apply one "Finish" to a wall (Studio 100x #46), then call
   * fireRedraw(). Persisted per-wall in SavedFloorplan already. */
  frontTexture: StudioTexture;
  backTexture: StudioTexture;
}

export interface StudioRoom {
  /** Sets this room's floor material and redraws it (Studio 100x #46). The
   * vendor keys floor textures by room UUID under the hood; this is the
   * only entry point the app needs. */
  setTexture(url: string, stretch: boolean, scale: number): void;
}

export interface StudioFloorplan {
  walls: StudioWall[];
  newCorner(x: number, y: number, id?: string): unknown;
  newWall(start: unknown, end: unknown): unknown;
  getCorners(): { x: number; y: number }[];
  /** Every wall's invisible pick planes (monkey-patched with .edge). */
  wallEdgePlanes(): THREE.Mesh[];
  /** Auto-detected enclosed floor areas — "Floor finish" (Studio 100x #46)
   * applies to every one of them. */
  getRooms(): StudioRoom[];
  update(): void;
}

export interface StudioItem {
  position: { x: number; y: number; z: number; set(x: number, y: number, z: number): void };
  /** Item yaw — set by the vendor to face its wall on attach. */
  rotation: { y: number };
  scale: { set(x: number, y: number, z: number): void };
  metadata?: { itemName?: string; unitConfig?: unknown; frameGapMm?: number; shelfConfig?: unknown };
  geometry: { dispose(): void; computeBoundingBox(): void; boundingBox: { max: { x: number; y: number; z: number }; min: { x: number; y: number; z: number } } | null };
  material: unknown;
  halfSize: { x: number; y: number; z: number; set(x: number, y: number, z: number): void };
  resize(height: number, width: number, depth: number): void;
  getWidth(): number;
  getHeight(): number;
  getDepth(): number;
  /** Attach to the closest wall — this is what cuts the hole. */
  placeInRoom(): void;
  redrawWall?(): void;
  remove?(): void;
}

export interface StudioScene {
  /** The underlying THREE scene — page-side overlays (3D drag handles). */
  getScene(): THREE.Scene;
  removeItem(item: StudioItem): void;
  itemLoadedCallbacks: StudioEventEmitter<StudioItem>;
  addItem(
    itemType: number,
    fileName: string,
    metadata: Record<string, unknown>,
    position?: StudioVector3,
    rotation?: number,
    scale?: StudioVector3,
    fixed?: boolean,
  ): void;
  getItems(): StudioItem[];
}

export interface StudioModel {
  floorplan: StudioFloorplan;
  scene: StudioScene;
  loadSerialized(json: string): void;
  exportSerialized(): string;
}

export interface StudioFloorplanner {
  mode: number;
  originX: number;
  originY: number;
  /** Hover targets the vendor tracks every mousemove — read at mousedown for selection. */
  activeWall: StudioWall | null;
  activeCorner: StudioCorner | null;
  /**
   * Private in the vendor's TS but plain fields at runtime — the Studio
   * mutates them for fit/zoom (the vendor draws through them every frame).
   * Spike-level maneuver; Phase 1 upstreams a real zoom API.
   */
  pixelsPerCm: number;
  cmPerPixel: number;
  wallWidth: number;
  /** 6-inch drawing snap (0 disables) — infinity vendor diff. */
  gridSnapCm: number;
  /** The 2D canvas view; `underlayWalls` ghosts the floor below. */
  view: {
    underlayWalls: Array<{ x1: number; y1: number; x2: number; y2: number }> | null;
    draw(): void;
  };
  setMode(mode: number): void;
  reset(): void;
  resizeView(): void;
}

export interface StudioEventEmitter<T> {
  add(cb: (v: T) => void): void;
  remove?(cb: (v: T) => void): void;
}

export interface StudioThree {
  updateWindowSize(): void;
  centerCamera(): void;
  getController(): { enabled: boolean; needsUpdate: boolean };
  stopSpin?: () => void;
  /**
   * A PNG data URL of the renderer's current frame (Studio 100x #41). The
   * vendor's WebGLRenderer is constructed with `preserveDrawingBuffer: true`
   * specifically so this works — see vendor/three/main.ts's `dataUrl()`.
   */
  dataUrl(): string;
  /** The 3D pane's container element (the renderer canvas lives inside). */
  element: HTMLElement;
  camera: THREE.PerspectiveCamera;
  /**
   * The vendor's own WebGLRenderer (Studio 100x #36) — exposed so an
   * offscreen capture can render one frame through a camera OTHER than the
   * live `camera` above (see lib/modelstudio/elevationRender.ts) without
   * fighting the vendor's own per-frame render loop for control of it.
   * `renderer.domElement` is the actual canvas.
   */
  renderer: THREE.WebGLRenderer;
  /**
   * Stop the vendor's animation loop and free the renderer's GPU resources
   * (Studio 100x #36). Every Blueprint3d starts its `requestAnimationFrame`
   * loop in its constructor with no way to stop it — harmless for the one
   * instance ModelStudio/JobModelViewer mount for the page's own lifetime,
   * but a THROWAWAY instance (an offscreen capture, one per render) would
   * otherwise leak a live WebGL context and a forever-running render loop
   * per call. Idempotent; safe to call more than once.
   */
  dispose(): void;
  /** Orbit controls — `enabled = false` freezes orbit during a handle drag. */
  controls: {
    enabled: boolean;
    update?(): void;
    object: { position: { set(x: number, y: number, z: number): void } };
    target?: { set(x: number, y: number, z: number): void };
  };
  itemSelectedCallbacks: StudioEventEmitter<StudioItem>;
  itemUnselectedCallbacks: StudioEventEmitter<void>;
  wallClicked: StudioEventEmitter<{ wall: StudioWall }>;
}

export class Blueprint3d {
  constructor(options: StudioOptions);
  model: StudioModel;
  three: StudioThree;
  floorplanner?: StudioFloorplanner;
}

export const floorplannerModes: { MOVE: number; DRAW: number; DELETE: number };

export const configWallHeight: string;
export const Configuration: {
  getNumericValue(key: string): number;
  setValue(key: string, value: string | number): void;
};

// ---------------------------------------------------------------------------
// Studio 100x #42 — the model-to-text serializer behind "Ask about this
// model". Turns a floorplan+items snapshot into something small enough to
// hand an LLM (UUIDs → indices, coordinates rounded, materials dropped). The
// vendor built and tested this for a Feng Shui feature that was never wired
// up; we reuse it as-is. See lib/modelstudio/aiAssist.ts for the app-facing
// wrapper — never call simplifyCanvasData directly from a page/component.
// ---------------------------------------------------------------------------

/** What `bp.model.exportSerialized()` parses to, typed just precisely enough
 * to hand to simplifyCanvasData. Mirrors the vendor's own SavedFloorplan
 * (vendor/model/floorplan.ts) — kept as a separate hand-written type rather
 * than an `import type` from vendor, same reasoning as every other type in
 * this file. */
export interface StudioSavedFloorplan {
  corners: Record<string, { x: number; y: number }>;
  walls: Array<{
    corner1: string;
    corner2: string;
    frontTexture?: { url: string; stretch?: boolean; scale: number };
    backTexture?: { url: string; stretch?: boolean; scale: number };
    height?: number;
  }>;
  wallTextures?: unknown[];
  floorTextures?: Record<string, { url: string; scale: number }>;
  newFloorTextures?: Record<string, { url: string; scale: number }>;
}

/** Mirrors the vendor's own SerializedItem (vendor/model/model.ts). */
export interface StudioSerializedItem {
  item_name: string;
  item_type: number;
  model_url: string;
  xpos: number;
  ypos: number;
  zpos: number;
  rotation: number;
  scale_x: number;
  scale_y: number;
  scale_z: number;
  fixed: boolean;
  resizable?: boolean;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface SimplifiedArea {
  name: string;
  /** Corner indices, in order, bounding this room/area. */
  boundary: number[];
}

export interface SimplifiedWall {
  /** [start corner index, end corner index] into SimplifiedCanvasData.corners
   * — also this wall's own 0-based position in layout.walls, which is the
   * only "id" a wall has anywhere in the Studio (see aiAssist.ts). */
  corners: [number, number];
}

export interface SimplifiedItem {
  /** Plan-space [x, y, z] cm — same coordinate system as StudioWall's
   * getStartX/getStartY etc. and SimplifiedCanvasData.corners. */
  pos: [number, number, number];
  rot: number;
  scale: [number, number, number];
  fixed?: boolean;
  resizable?: boolean;
  /** The one human-readable label an item carries into the simplified
   * payload — absent unless the caller populated SerializedItem.description
   * first (see aiAssist.ts's item-name backfill). */
  description?: string;
}

export interface SimplifiedCanvasData {
  corners: [number, number][];
  layout: {
    walls: SimplifiedWall[];
    areas: SimplifiedArea[];
  };
  items: SimplifiedItem[];
}

/** Compacts a floorplan+items snapshot for LLM consumption: UUIDs become
 * indices, coordinates round to 2 decimals, materials and technical names
 * drop out. Pure — the vendor's own tested implementation, unchanged. */
export function simplifyCanvasData(data: {
  floorplan: StudioSavedFloorplan;
  items: StudioSerializedItem[];
}): SimplifiedCanvasData;

/** `JSON.stringify(data)` with no whitespace — the form to actually send. */
export function toMinifiedJSON(data: SimplifiedCanvasData): string;
