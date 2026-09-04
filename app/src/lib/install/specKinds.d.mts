// Types for specKinds.mjs. The rules live in the .mjs so the backfill script
// (scripts/seed-spec-kinds.mjs) runs the SAME function the app does; this is
// only the shape of it, so TypeScript callers are checked as usual.

export type UnitKind = "window" | "door";
export type DoorKind = "slider" | "french" | "bifold" | "swing" | "other";

export interface SpecKindInput {
  style?: string | null;
  operation?: string | null;
}

export interface SpecKindColumns {
  unit_kind: UnitKind | null;
  door_kind: DoorKind | null;
}

export declare function unitKindFromDescription(
  description: string | null | undefined,
): UnitKind | null;

export declare function doorKind(
  style: string | null | undefined,
  operation: string | null | undefined,
): DoorKind;

export declare function specKindColumns(spec: SpecKindInput): SpecKindColumns;
