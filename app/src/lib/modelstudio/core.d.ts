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

export interface StudioFloorplan {
  newCorner(x: number, y: number, id?: string): unknown;
  newWall(start: unknown, end: unknown): unknown;
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
