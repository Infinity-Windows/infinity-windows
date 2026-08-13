// Hand-written types for exactly the vendor surface the Studio uses.
// See core.js for why this boundary exists.

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
  getStart(): StudioCorner;
  getEnd(): StudioCorner;
  getStartX(): number;
  getStartY(): number;
  getEndX(): number;
  getEndY(): number;
}

export interface StudioFloorplan {
  walls: StudioWall[];
  newCorner(x: number, y: number, id?: string): unknown;
  newWall(start: unknown, end: unknown): unknown;
  getCorners(): { x: number; y: number }[];
  update(): void;
}

export interface StudioScene {
  addItem(
    itemType: number,
    fileName: string,
    metadata: Record<string, unknown>,
    position?: StudioVector3,
    rotation?: number,
    scale?: StudioVector3,
    fixed?: boolean,
  ): void;
  getItems(): unknown[];
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
  setMode(mode: number): void;
  reset(): void;
  resizeView(): void;
}

export interface StudioThree {
  updateWindowSize(): void;
  centerCamera(): void;
  getController(): { enabled: boolean };
  stopSpin?: () => void;
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
