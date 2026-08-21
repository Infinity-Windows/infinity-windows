// The rough-opening checklist's referee: Square? Width? Height? — judged by
// the numbers, against the WINDOW, in the order a framer would check them.
//
// The rule (owner, 2026-08-11) is relative, not a flat tolerance: the
// opening must be at least 1/8" looser than the unit overall (tighter and
// the window won't shim in) and at most 1/2" looser (sloppier is a framing
// problem). Square is the X across the diagonals — legs disagreeing by more
// than 1/4" means a racked opening. The installer taps Good or Bad, but the
// tape measure outranks the thumb: measurements that prove a problem file
// the framing issue even under a Good tap.
//
// Pure and unit-tested; the OpeningSheet renders it, the issues list
// receives it.

import { DEFAULT_CLEARANCE } from "./fit";

/** Diagonals disagreeing by more than this = racked (out of square). */
export const SQUARE_TOL_IN = 0.25;

/** Overall gap bounds (RO minus unit), from the shared clearance rule. */
export const GAP_MIN_IN = DEFAULT_CLEARANCE.minPerSide * 2;
export const GAP_MAX_IN = DEFAULT_CLEARANCE.maxPerSide * 2;

export type RoCheckId = "square" | "width" | "height";
export type RoJudgment = "good" | "bad" | null;

export interface RoCheckInput {
  /** Two diagonal measurements (the X), inches. */
  diagonals: (number | null)[];
  /** Width points (top/mid/bot), inches. Smallest binds. */
  widths: (number | null)[];
  /**
   * Height points, inches. Smallest of everything present binds.
   *
   * `[left, right]` normally. A wide opening needs the header checked for
   * bow mid-span, so extra points insert BETWEEN left and right, in
   * left-to-right order: `[left, mid, right]` past 60" nominal width,
   * `[left, midLeft, midRight, right]` past 120" (owner rule, 2026-08-21).
   * First and last are always left/right; whatever sits between them (0, 1,
   * or 2 entries) is the mid points — this is what keeps an old saved
   * `[left, right]` pair reading correctly with no migration.
   */
  heights: (number | null)[];
  /** The unit's nominal size, when known. */
  unitWidthIn: number | null;
  unitHeightIn: number | null;
}

export interface RoVerdict {
  check: RoCheckId;
  /** What the numbers say: null = not enough numbers to judge. */
  measured: "good" | "bad" | null;
  /** Plain-words reading of the numbers, always shown. */
  detail: string | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Inches the way the trade writes them: 0.5 -> 1/2", 1.0625 -> 1 1/16".
 * Rounded to the nearest sixteenth — finer than anyone's tape matters.
 */
export function inFrac(n: number): string {
  const a = Math.abs(n);
  let whole = Math.floor(a + 1e-9);
  let sixteenths = Math.round((a - whole) * 16);
  if (sixteenths === 16) {
    whole += 1;
    sixteenths = 0;
  }
  if (sixteenths === 0) return `${whole}"`;
  let num = sixteenths;
  let den = 16;
  while (num % 2 === 0) {
    num /= 2;
    den /= 2;
  }
  return whole > 0 ? `${whole} ${num}/${den}"` : `${num}/${den}"`;
}

function present(values: (number | null)[]): number[] {
  return values.filter((v): v is number => typeof v === "number" && v > 0);
}

/** Judge one axis's smallest measurement against the unit's dimension. */
function gapVerdict(
  smallestIn: number | null,
  unitIn: number | null,
): Pick<RoVerdict, "measured" | "detail"> {
  if (smallestIn == null) return { measured: null, detail: null };
  if (unitIn == null) {
    return {
      measured: null,
      detail: `${r2(smallestIn)}" measured — no unit size on file to judge against`,
    };
  }
  const gap = r2(smallestIn - unitIn);
  if (gap < GAP_MIN_IN) {
    return {
      measured: "bad",
      detail:
        gap < 0
          ? `${inFrac(gap)} smaller than the unit — it will not go in`
          : `only ${inFrac(gap)} over the unit — needs ${inFrac(GAP_MIN_IN)} minimum to shim`,
    };
  }
  if (gap > GAP_MAX_IN) {
    return {
      measured: "bad",
      detail: `${inFrac(gap)} over the unit — past the ${inFrac(GAP_MAX_IN)} maximum, opening is oversized`,
    };
  }
  return { measured: "good", detail: `${inFrac(gap)} over the unit — within range` };
}

/**
 * How many extra height points a wide opening requires, beyond left/right
 * (owner standard, 2026-08-21): a header bows across a wide span, and that
 * shows up as the height shrinking mid-span — not at the jambs where it's
 * easy to catch. Gated on the unit's NOMINAL width (the same value the width
 * check judges against), not the measured RO width: it is knowable before a
 * single measurement is taken, which is the point — the installer should see
 * the requirement before they start.
 *
 * No nominal on file means no requirement: never gate on a number we don't
 * have.
 */
export function requiredMidHeightCount(nominalWidthIn: number | null): 0 | 1 | 2 {
  if (nominalWidthIn == null) return 0;
  if (nominalWidthIn > 120) return 2;
  if (nominalWidthIn > 60) return 1;
  return 0;
}

/**
 * Are the mid-span point(s) a wide opening requires actually entered?
 * `heights` is `[left, ...mids, right]` (see RoCheckInput) so the mids are
 * always the slice between the first and last entries, however many slots
 * are currently offered. Null when satisfied — the ordinary gap verdict
 * takes over from there; otherwise "not finished" outranks good or bad,
 * because a Good tap has to mean the header was actually checked for bow.
 */
function heightGate(
  heights: (number | null)[],
  requiredMids: number,
): Pick<RoVerdict, "measured" | "detail"> | null {
  const midsEntered = present(heights.slice(1, -1)).length;
  if (midsEntered >= requiredMids) return null;
  return {
    measured: null,
    detail:
      requiredMids === 1
        ? "mid-span height not entered yet — required on a wide opening to catch a bowed header"
        : "both third-point heights not entered yet — required on a wide opening to catch a bowed header",
  };
}

/** All three verdicts, in checking order. */
export function roVerdicts(input: RoCheckInput): RoVerdict[] {
  const out: RoVerdict[] = [];

  const diags = present(input.diagonals);
  if (diags.length < 2) {
    out.push({ check: "square", measured: null, detail: null });
  } else {
    const diff = r2(Math.abs(diags[0] - diags[1]));
    out.push({
      check: "square",
      measured: diff > SQUARE_TOL_IN ? "bad" : "good",
      detail:
        diff > SQUARE_TOL_IN
          ? `diagonals ${inFrac(diags[0])} vs ${inFrac(diags[1])} — ${inFrac(diff)} out of square`
          : `diagonals within ${inFrac(diff)} — square`,
    });
  }

  const w = present(input.widths);
  out.push({
    check: "width",
    ...gapVerdict(w.length ? Math.min(...w) : null, input.unitWidthIn),
  });

  const h = present(input.heights);
  const requiredMids = requiredMidHeightCount(input.unitWidthIn);
  out.push({
    check: "height",
    ...(heightGate(input.heights, requiredMids) ??
      gapVerdict(h.length ? Math.min(...h) : null, input.unitHeightIn)),
  });

  return out;
}

/**
 * The checks that should file a framing issue: a Bad tap, or numbers that
 * prove it. A Good tap never overrides bad numbers.
 */
export function roFailures(
  verdicts: RoVerdict[],
  judgments: Record<RoCheckId, RoJudgment>,
): RoVerdict[] {
  return verdicts.filter(
    (v) => judgments[v.check] === "bad" || v.measured === "bad",
  );
}

const CHECK_TITLE: Record<RoCheckId, string> = {
  square: "Square",
  width: "Width",
  height: "Height",
};

/**
 * The framing issue's note: one plain sentence per failed check, joined with
 * " • " so the issue card can break them into a readable list. The card
 * already names the window and the kind, so the note carries only the facts
 * a framer needs on the wall.
 */
export function framingIssueNote(
  _openingCode: string,
  failures: RoVerdict[],
  judgments: Record<RoCheckId, RoJudgment>,
): string {
  const parts = failures.map((f) => {
    const title = CHECK_TITLE[f.check];
    if (f.measured === "bad" && f.detail) return `${title}: ${f.detail}`;
    if (judgments[f.check] === "bad" && f.measured === "good" && f.detail) {
      return `${title} marked Bad by the installer — but the tape reads fine (${f.detail})`;
    }
    return `${title} marked Bad by the installer`;
  });
  return parts.join(" \u2022 ");
}
