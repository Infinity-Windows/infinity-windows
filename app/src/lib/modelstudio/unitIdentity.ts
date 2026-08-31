// A placed Studio unit's identity, in the SAME voice the Maps Interactive
// elevations view already uses (owner ask: "Studio should show the same
// identity"). Every piece here wraps a helper that view already owns —
// adapter.ts's displayMarkCode for the work-order dialect, fitviewRenderer's
// inches() for the tape-reading fraction format — rather than reimplementing
// either, so a unit never reads differently in the two screens.
//
// PURE and unit-tested. ModelStudio.tsx is the caller: the 3D mark chip
// (setUnitAnnotations) uses unitMarkLabel; the "Selected unit" panel uses
// all four to build the identity + spec line the owner asked for.

import { displayMarkCode } from "../fitview/adapter";
import { inches } from "../fitview/fitviewRenderer";
import { MECHANISM_LABELS, unitWidthMm, type Mechanism, type UnitConfig } from "./units";

/**
 * A unit's itemName re-spelled in the crew's work-order dialect — the exact
 * conversion `buildAuthoredJob` applies for the elevations map when it's
 * given a crew view (adapter.ts's displayMarkCode: "1A" -> "1-1"). Studio
 * never passes that view context (its ids double as overlay/package lookup
 * keys), so it has to apply the same conversion itself at display time.
 *
 * Safe to call on anything: displayMarkCode only rewrites the digit+letter
 * survey pattern, so a hand-typed catalog name ("Window 16", "New window")
 * or an already-dashed id ("16-1") passes through unchanged — the "show what
 * they have" degrade the owner asked for costs nothing extra here.
 */
export function unitMarkLabel(itemName: string | null | undefined): string | null {
  const trimmed = itemName?.trim();
  return trimmed ? displayMarkCode(trimmed) : null;
}

/** "Window" / "Door" — the one type field every placement's config carries,
 * spec-derived or hand-built alike (units.ts's specToUnitConfig sets it the
 * same way for both). */
export function unitTypeLabel(config: Pick<UnitConfig, "kind">): string {
  return config.kind === "door" ? "Door" : "Window";
}

/**
 * "W 59 1/2" · L 84"" — total panel width (unitWidthMm, the same number the
 * Width field edits) by overall height, through the SAME inches() tape
 * formatter the elevations sheet's own W×L line uses (fitviewRenderer.ts),
 * so Studio never shows a different fraction for the same millimetre value.
 */
export function unitSizeLabel(config: Pick<UnitConfig, "panels" | "heightMm">): string {
  return `W ${inches(unitWidthMm(config as UnitConfig))} · L ${inches(config.heightMm)}`;
}

/**
 * "3 panes · 2× Slider, 1× Fixed" — the base tier's panels (`config.panels`,
 * the same array the pane-grid picker right below it in the panel already
 * edits), grouped by mechanism, most-common-first-seen. "×n" matches the
 * multi-track glyph badge's own convention (unitAnnotations.ts) rather than
 * inventing a second way to say "more than one".
 */
export function unitPaneSummary(config: Pick<UnitConfig, "panels">): string {
  const panels = config.panels ?? [];
  if (panels.length === 0) return "No panes yet";
  const counts = new Map<Mechanism, number>();
  for (const p of panels) counts.set(p.mechanism, (counts.get(p.mechanism) ?? 0) + 1);
  const breakdown = [...counts.entries()]
    .map(([m, n]) => `${n}× ${MECHANISM_LABELS[m]}`)
    .join(", ");
  return `${panels.length} pane${panels.length === 1 ? "" : "s"} · ${breakdown}`;
}
