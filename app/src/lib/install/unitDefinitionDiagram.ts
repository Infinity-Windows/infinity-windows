import { unitSvg, type Mechanism, type UnitConfig } from "../modelstudio/units";
import type { UnitDetails } from "./unitDetails";

// A curtain wall or a storefront has no preset and no schematic: its bays are
// whatever the shop drawing says.
const framed = (kind: UnitDetails["kind"]): kind is "curtain_wall" | "storefront" =>
  kind === "curtain_wall" || kind === "storefront";

const presets: Record<string, Mechanism[]> = {
  "Fixed": ["fixed"],
  "Two fixed panels": ["fixed", "fixed"],
  "Sliding + fixed": ["slider", "fixed"],
  "Casement": ["casement"],
  "Swing door": ["casement"],
  "Sliding door": ["slider", "fixed"],
};

export function unitDefinitionPresets(kind: UnitDetails["kind"]) {
  return kind && !framed(kind) ? Object.keys(presets).filter(label =>
    kind === "door" ? label.endsWith("door") : !label.endsWith("door")) : [];
}

export function unitDefinitionDiagram(details: UnitDetails | undefined, width = 220, height = 140) {
  const kind = details?.kind;
  const label = details?.configuration;
  if (!kind || framed(kind) || !label || !Object.hasOwn(presets, label)) return null;
  const mechanisms = presets[label];
  // Equal panes are schematic; drawing geometry and dimensions are recorded separately.
  const y = details?.height ?? 40;
  const x = details?.width ?? 40;
  return unitSvg({ kind, heightMm: y * 25.4,
    panels: mechanisms.map(mechanism => ({ widthMm: x * 25.4 / mechanisms.length, mechanism, direction: "left" })) }, width, height);
}

// One picture rule for every place a unit is drawn (details panel, Workday
// tiles, Plan tiles): the definition saved on the unit wins, then the spec's
// drawing when it is the same kind of unit. A unit retyped from window to door
// must not keep showing the window its mark resolves to. Null means the caller
// shows the door/window icon instead.
export function unitPicture(details: UnitDetails | undefined, resolved: UnitConfig | null | undefined, width: number, height: number) {
  const config = resolved && (!details?.kind || details.kind === resolved.kind) ? resolved : null;
  return unitDefinitionDiagram(details, width, height) ?? (config ? unitSvg(config, width, height) : null);
}
