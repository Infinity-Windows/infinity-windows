import type { ProjectOpening } from "./types";
import type { SetDepth } from "./buildFacts";
import { BUILDING_3_PROJECT } from "../installerWorkflow/jobPlan";
import { building3ByMark } from "../../pages/installerPilot/building3Openings";
import { normalizeMarkCode } from "../fitview/adapter";

// What a unit on a job can be. Curtain walls joined windows and doors on
// 2026-11-20 (Matt): Building 3's shop CAD has four, and with only two types
// they could not be put on the job at all. save_unit_details holds the same
// list (20261130100000); change them together.
export const UNIT_KINDS = ["window", "door", "curtain_wall"] as const;
export type UnitKind = typeof UNIT_KINDS[number];
export const isUnitKind = (value: unknown): value is UnitKind => UNIT_KINDS.some(kind => kind === value);
export function unitKindLabel(kind: UnitKind, spanish = false) {
  return kind === "door" ? (spanish ? "Puerta" : "Door")
    : kind === "curtain_wall" ? (spanish ? "Muro cortina" : "Curtain wall")
    : (spanish ? "Ventana" : "Window");
}

export type UnitDetails = {
  placeholder?: boolean;
  builderDeferred?: boolean;
  configuration?: string | null;
  sourceMark?: string;
  kind?: UnitKind | null;
  floor?: string | null;
  face?: string | null;
  material?: string | null;
  inset?: SetDepth | null;
  width?: number | null;
  height?: number | null;
  basis?: "unit" | "rough" | "drawing" | null;
};

export function unitSourceMark(opening: ProjectOpening): string | null {
  return opening.unit_details?.placeholder ? null : opening.unit_details?.sourceMark ?? opening.opening_code;
}

export function trainingDrawing(opening: ProjectOpening) {
  const mark = unitSourceMark(opening);
  return opening.project_id === BUILDING_3_PROJECT && mark
    ? building3ByMark.get(normalizeMarkCode(mark))
    : undefined;
}

export function unitFloor(opening: ProjectOpening): string | null {
  if (opening.unit_details?.floor !== undefined) {
    const floor = opening.unit_details.floor;
    return floor == null ? null : `Level ${floor}`;
  }
  return trainingDrawing(opening)?.location.split("·")[0].trim() ?? null;
}

export type UnitDetailsWrite = {
  editId: string;
  reason?: string;
  projectId: string;
  id: string;
  create: boolean;
  code: string;
  details: UnitDetails;
  previousCode: string | null;
  previousDetails: UnitDetails;
};
