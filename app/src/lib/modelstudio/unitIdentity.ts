// A placed Studio unit's identity, in the SAME voice the Maps Interactive
// elevations view already uses (owner ask: "Studio should show the same
// identity"). Every piece here wraps a helper that view already owns —
// adapter.ts's displayMarkCode for the work-order dialect, fitviewRenderer's
// inches() for the tape-reading fraction format — rather than reimplementing
// either, so a unit never reads differently in the two screens.
//
// PURE and unit-tested. ModelStudio.tsx is the caller: the 3D mark chip
// (setUnitAnnotations) uses unitMarkLabel; the "Selected unit" panel uses
// all five to build the identity card the owner asked for.
//
// Mad Moose bug (owner report, 2026-09-01): marks 1, 7 and 8 all spec at the
// same 167.5x143.5in size, and mark 7's CAD sheet never printed an overall
// `operation` string. `unitPaneSummary` used to read the PLACED unit's own
// config.panels — whatever a catalog build or specToUnitConfig's own
// building defaults happened to carry — and presented that as fact
// ("2× Slider"), even though "slider" appears nowhere on mark 7's sheet.
// Below this line, every function that describes what a unit's panes DO
// reads the SPEC (`extra.panels`'s op/width_in, `operation`), never the
// placed config — CAD-WINS (CONTEXT.md's "Vision placement": extraction
// never invents a mark; this is the same rule applied to what a mark's
// panes are said to do). `unitTypeLabel`/`unitSizeLabel` keep reading the
// config because Window/Door and the overall W×L are structural facts the
// config always gets right (unitSizeLabel's own test pins its number
// straight off a real spec width) — only the PANE MECHANISMS were ever the
// invented part.

import { displayMarkCode } from "../fitview/adapter";
import { inches } from "../fitview/fitviewRenderer";
import type { MarkSpec } from "../install/specs";
import { unitWidthMm, type UnitConfig } from "./units";

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

/**
 * "Window" / "Door", plus the sheet's own `operation` string when the spec
 * has one ("Door · Fixed / Double Swing Door") — the type/operation chip.
 * Kind stays off the config (units.ts's specToUnitConfig sets it the same
 * way for a spec-derived or hand-built unit alike); operation is read
 * straight off the spec and left off the chip entirely when the sheet
 * never printed one, rather than guessing from the config's own panels.
 */
export function unitTypeLabel(
  config: Pick<UnitConfig, "kind">,
  operation?: string | null,
): string {
  const kind = config.kind === "door" ? "Door" : "Window";
  const op = operation?.trim();
  return op ? `${kind} · ${op}` : kind;
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

/** One entry of `spec.extra.panels` this module trusts: an op letter read
 * straight off the CAD elevation (window-vendor-conventions.md's own
 * shorthand — F = fixed, X = operating, O = fixed the OXXO way; whatever
 * the sheet actually printed, verbatim, never renamed to a catalog
 * mechanism name like "Slider") plus the width that validates the entry. */
interface SpecPanel {
  op: string | null;
  widthIn: number;
}

/**
 * Read `spec.extra.panels` defensively — same shape specToUnitConfig
 * already trusts for geometry (`op`/`width_in` per entry), but here purely
 * for DISPLAY, so a spec with no panel array (or nothing parseable in it)
 * is null, never an empty/invented list. `width_in` is what makes a panel
 * entry real (specToUnitConfig's own `> 2` filter, so a stray zero/garbage
 * entry can't inflate the panel count); `op` rides along unmodified for the
 * caller to letter or fall back on.
 */
function specPanels(spec: Pick<MarkSpec, "extra"> | null | undefined): SpecPanel[] | null {
  const raw = spec?.extra as { panels?: unknown } | null | undefined;
  if (!raw || !Array.isArray(raw.panels)) return null;
  const panels: SpecPanel[] = [];
  for (const p of raw.panels) {
    if (!p || typeof p !== "object") continue;
    const rec = p as Record<string, unknown>;
    const widthIn = typeof rec.width_in === "number" ? rec.width_in : null;
    if (widthIn == null || !(widthIn > 2)) continue;
    const op = typeof rec.op === "string" && rec.op.trim() ? rec.op.trim().toUpperCase() : null;
    panels.push({ op, widthIn });
  }
  return panels.length > 0 ? panels : null;
}

/**
 * "4 panels · F · X · X · F" — the panel breakdown, off the SPEC
 * (`spec.extra.panels`), never off a placed/catalog config's own panels.
 * The Mad Moose bug (module header): a catalog build's mechanisms are a
 * BUILDING decision, not what the CAD sheet said, so they never belong in
 * a line that claims to describe the spec.
 *
 * Each panel prints the sheet's own op letter verbatim (F/X/O — window-
 * vendor-conventions.md's shorthand, not a renamed "Slider"/"Fixed"). A
 * null op on a DOOR-kind mark is the swing-door leaf itself — the one
 * panel type the extractor's F/O/X vocabulary can't capture (mark 1's real
 * third panel) — so it prints "Door"; a null op on a window is genuinely
 * unknown and prints "?" rather than guessing. Returns null (omit the
 * clause entirely) when the sheet gave no panel breakdown at all — the
 * caller falls back to plain W×L, never a fabricated one.
 */
export function unitPaneSummary(
  config: Pick<UnitConfig, "kind">,
  spec?: Pick<MarkSpec, "extra"> | null,
): string | null {
  const panels = specPanels(spec);
  if (!panels) return null;
  const letters = panels.map((p) => p.op ?? (config.kind === "door" ? "Door" : "?"));
  return `${panels.length} panel${panels.length === 1 ? "" : "s"} · ${letters.join(" · ")}`;
}

/**
 * "Storefront Fixed · TruLite Bronze" — style and color straight off the
 * spec, each cut at its first parenthetical (the sheet's own asides —
 * "(With threshold)", "(Aluminum profile Color)" — clutter a one-line
 * glance and aren't why the field is on the card). What's left is shown
 * VERBATIM; "truncated" here means the card clips it with CSS ellipsis if
 * it still doesn't fit, not that this function shortens or summarizes the
 * wording — that would be the same invention this module exists to avoid,
 * just aimed at prose instead of a mechanism.
 */
export function unitStyleColorLine(
  spec?: Pick<MarkSpec, "style" | "color"> | null,
): string | null {
  const cut = (s: string | null | undefined) => {
    const head = s?.split("(")[0]?.trim();
    return head ? head : null;
  };
  const style = cut(spec?.style);
  const color = cut(spec?.color);
  if (style && color) return `${style} · ${color}`;
  return style ?? color ?? null;
}
