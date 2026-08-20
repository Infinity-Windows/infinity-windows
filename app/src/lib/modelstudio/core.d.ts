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
}

export interface StudioFloorplan {
  walls: StudioWall[];
  newCorner(x: number, y: number, id?: string): unknown;
  newWall(start: unknown, end: unknown): unknown;
  getCorners(): { x: number; y: number }[];
  /** Every wall's invisible pick planes (monkey-patched with .edge). */
  wallEdgePlanes(): THREE.Mesh[];
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
