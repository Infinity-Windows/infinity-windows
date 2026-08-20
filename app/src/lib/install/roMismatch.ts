// Studio 100x #14 — "does the measured rough opening actually take this
// unit?" Reuses roCheck's own gap math (roVerdicts) VERBATIM — no new
// tolerance, GAP_MIN_IN/GAP_MAX_IN inside roCheck.ts still decide "bad"
// exactly as they do on the installer's own RO checklist — pointed at the
// SUMMARY numbers already stored on the opening (ro_width_in/ro_height_in)
// and a mark's resolved Studio config, so a mismatch shows up before
// anyone's on a ladder: on the modeled unit itself (liveOverlay's
// roProblem) and on the mark's spec-review row.
//
// This module supplies only the OTHER half of that comparison — the
// config's real width/height, in inches — and turns roVerdicts' width and
// height findings into one plain sentence.

import { roVerdicts } from "./roCheck";
import { cornerLegs, unitWidthMm, type UnitConfig } from "../modelstudio/units";

const MM_PER_IN = 25.4;

/** The bits of an opening this check reads — a real ProjectOpening satisfies it. */
export interface RoMismatchOpening {
  ro_width_in: number | null;
  ro_height_in: number | null;
}

/**
 * A plain-language warning when the opening's site-measured RO and the
 * mark's resolved config disagree on roCheck's gap math — or null when
 * there's nothing to say: no RO recorded yet, no real size on the config,
 * or the numbers are fine.
 *
 * Corner units are skipped on purpose: a wrapped unit's two legs have no
 * ONE straight-opening width for a single ro_width_in to judge against, and
 * forcing the comparison would misjudge window 16 and every corner unit
 * like it.
 */
export function roMismatchWarning(
  opening: RoMismatchOpening,
  config: UnitConfig,
): string | null {
  if (opening.ro_width_in == null || opening.ro_height_in == null) return null;
  if (cornerLegs(config)) return null;

  const unitWidthIn = unitWidthMm(config) / MM_PER_IN;
  const unitHeightIn = config.heightMm / MM_PER_IN;
  if (!(unitWidthIn > 0) || !(unitHeightIn > 0)) return null;

  const verdicts = roVerdicts({
    diagonals: [],
    widths: [opening.ro_width_in],
    heights: [opening.ro_height_in],
    unitWidthIn,
    unitHeightIn,
  });
  const bad = verdicts.filter((v) => v.measured === "bad" && v.detail);
  if (bad.length === 0) return null;
  return bad.map((v) => `${v.check} ${v.detail}`).join("; ");
}
