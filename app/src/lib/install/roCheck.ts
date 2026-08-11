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
  /** Height points (left/right), inches. Smallest binds. */
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

function present(values: (number | null)[]): number[] {
  return values.filter((v): v is number => typeof v === "number" && v > 0);
}

/** Judge one axis's smallest measurement against the unit's dimension. */
function gapVerdict(
  smallestIn: number | null,
  unitIn: number | null,
  axis: "width" | "height",
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
          ? `${r2(Math.abs(gap))}" SMALLER than the unit on ${axis} — it will not go in`
          : `only ${gap}" over the unit — needs at least ${GAP_MIN_IN}" to shim`,
    };
  }
  if (gap > GAP_MAX_IN) {
    return {
      measured: "bad",
      detail: `${gap}" over the unit — more than the ${GAP_MAX_IN}" max, opening is oversized`,
    };
  }
  return { measured: "good", detail: `${gap}" over the unit — within range` };
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
          ? `diagonals ${r2(diags[0])}" vs ${r2(diags[1])}" — ${diff}" out of square`
          : `diagonals within ${diff}" — square`,
    });
  }

  const w = present(input.widths);
  out.push({
    check: "width",
    ...gapVerdict(w.length ? Math.min(...w) : null, input.unitWidthIn, "width"),
  });

  const h = present(input.heights);
  out.push({
    check: "height",
    ...gapVerdict(h.length ? Math.min(...h) : null, input.unitHeightIn, "height"),
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

const CHECK_LABEL: Record<RoCheckId, string> = {
  square: "out of square",
  width: "width",
  height: "height",
};

/** The framing issue's note — leads with the window, reads like a punch list. */
export function framingIssueNote(
  openingCode: string,
  failures: RoVerdict[],
  judgments: Record<RoCheckId, RoJudgment>,
): string {
  const parts = failures.map((f) => {
    const label = CHECK_LABEL[f.check];
    if (f.detail && f.measured === "bad") return `${label}: ${f.detail}`;
    if (judgments[f.check] === "bad" && f.detail) return `${label} (marked bad): ${f.detail}`;
    return `${label} marked bad by installer`;
  });
  return `${openingCode} — rough opening needs framing fix: ${parts.join("; ")}`;
}
