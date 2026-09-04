/**
 * Is this opening a window or a door?
 *
 * The supplier's own words decide. Every mark we have read off a specs sheet
 * carries a description — "Thermal Break Aluminum Fixed Window", "Thermal break
 * Aluminum French Door (Low track)" — and that sentence is the most direct
 * statement anyone has of what the unit is. Read it and believe it.
 *
 * What we used to do instead, and why it was wrong: the answer came from
 * `window_types.category`. That category is not the supplier's word, it is one
 * WE write during extraction (see `ensureWindowTypes` in `api.ts`), and on Black
 * Desert it is wrong on seventeen openings in both directions — mark #2 was
 * filed as a door while its sheet plainly reads "Fixed Window", and the whole
 * run of French doors on marks #26 and #28–#39 was filed as windows.
 *
 * Shared so the map pin, the map's list, dispatch, the plan editor, the review
 * screen and the issues list can never colour the same opening two ways.
 *
 * Wave X moved the word-matching itself into `specKinds.mjs` — plain JavaScript
 * so the backfill script runs the very same function — and re-exports it here,
 * which is where every caller in the app has always imported it from. Wave X's
 * `doorKind` (which door: slider, French, bifold, swing) lives there too.
 */
import { indexSpecsByMark, specForOpeningCode } from "./specs";
import { unitKindFromDescription } from "./specKinds.mjs";

export { doorKind, specKindColumns, unitKindFromDescription } from "./specKinds.mjs";
export type {
  DoorKind,
  SpecKindColumns,
  SpecKindInput,
} from "./specKinds.mjs";

/**
 * The little an opening has to carry to be classified. Structural rather than
 * `ProjectOpening`, so the issues list — which selects only the few columns it
 * needs — gets the same answer as the map.
 */
export interface UnitKindOpening {
  opening_code?: string | null;
  window_types?: {
    category?: string | null;
    type_code?: string | null;
    name?: string | null;
  } | null;
}

/**
 * The description decides. Without one — a job whose specs have not been
 * extracted, or a mark the spec sheet is missing — fall back to the category
 * and type code we used before, so those jobs keep the colours they had rather
 * than going all one colour.
 */
export function openingUnitKind(
  o: UnitKindOpening,
  description?: string | null,
): "door" | "window" {
  const said = unitKindFromDescription(description);
  if (said) return said;

  const category = (o.window_types?.category ?? "").toLowerCase();
  if (category.includes("door")) return "door";
  if (category.includes("window")) return "window";
  const code =
    `${o.window_types?.type_code ?? ""} ${o.window_types?.name ?? ""}`.toUpperCase();
  if (/\b\d{2}(70|80)\b/.test(code) && /\b(XO|OX|SC)\b/.test(code)) return "door";
  if (/\bDOOR\b/.test(code)) return "door";
  return "window";
}

/**
 * One job's answer for every opening on it, given whatever specs have been
 * extracted for that job. Specs are held per MARK and shared by every opening
 * of that mark (1-1, 1-2, …), which is what `specForOpeningCode` resolves.
 *
 * Build this once per screen and use it everywhere on that screen: it is the
 * reason the pin, the row and the card can't drift apart.
 */
export function openingUnitKindResolver(
  specs: { mark_code: string; style: string | null }[],
): (o: UnitKindOpening) => "door" | "window" {
  const index = indexSpecsByMark(specs);
  return (o) =>
    openingUnitKind(o, specForOpeningCode(index, o.opening_code)?.style);
}
