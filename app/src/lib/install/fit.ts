// Fit + condition gate: "never carry a window that won't go in."
// Pure logic so it can be unit-tested and run offline.

export type FitVerdict = "fits" | "tight" | "too_small" | "too_big" | "unknown";

export interface FitClearance {
  /** Minimum gap per side the unit needs to shim/level (inches). Default 1/4". */
  minPerSide: number;
  /** Maximum gap per side before the opening is oversized for the unit. Default 1/2". */
  maxPerSide: number;
}

export const DEFAULT_CLEARANCE: FitClearance = {
  minPerSide: 0.25,
  maxPerSide: 0.5,
};

export interface FitInput {
  unitWidthIn: number | null | undefined;
  unitHeightIn: number | null | undefined;
  roWidthIn: number | null | undefined;
  roHeightIn: number | null | undefined;
  clearance?: FitClearance;
}

export interface FitResult {
  verdict: FitVerdict;
  /** Gap = RO minus unit, per dimension (inches). Null when inputs missing. */
  widthGap: number | null;
  heightGap: number | null;
  message: string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Compare rough-opening dims to the unit's nominal dims. The RO must be
 * larger than the unit by between (2 x minPerSide) and (2 x maxPerSide) on
 * each axis: enough gap to shim/level, not so much the unit floats.
 */
export function checkFit(input: FitInput): FitResult {
  const { unitWidthIn, unitHeightIn, roWidthIn, roHeightIn } = input;
  const clearance = input.clearance ?? DEFAULT_CLEARANCE;

  if (
    unitWidthIn == null ||
    unitHeightIn == null ||
    roWidthIn == null ||
    roHeightIn == null
  ) {
    return {
      verdict: "unknown",
      widthGap: null,
      heightGap: null,
      message: "Measure the rough opening and set unit dimensions to check fit.",
    };
  }

  const widthGap = round2(roWidthIn - unitWidthIn);
  const heightGap = round2(roHeightIn - unitHeightIn);
  const minGap = clearance.minPerSide * 2;
  const maxGap = clearance.maxPerSide * 2;

  // Too small on either axis is the hard stop — the unit will not go in.
  if (widthGap < 0 || heightGap < 0) {
    const axis = widthGap < 0 && heightGap < 0 ? "width and height" : widthGap < 0 ? "width" : "height";
    return {
      verdict: "too_small",
      widthGap,
      heightGap,
      message: `Rough opening is smaller than the unit on ${axis}. Do not carry it up — flag the office.`,
    };
  }

  const tightWidth = widthGap < minGap;
  const tightHeight = heightGap < minGap;
  const bigWidth = widthGap > maxGap;
  const bigHeight = heightGap > maxGap;

  if (bigWidth || bigHeight) {
    return {
      verdict: "too_big",
      widthGap,
      heightGap,
      message: `Opening is oversized (gap over ${clearance.maxPerSide}" per side). Confirm the right unit and plan extra shimming/trim.`,
    };
  }

  if (tightWidth || tightHeight) {
    return {
      verdict: "tight",
      widthGap,
      heightGap,
      message: `Fits, but tight (under ${clearance.minPerSide}" per side to shim). Check square before setting.`,
    };
  }

  return {
    verdict: "fits",
    widthGap,
    heightGap,
    message: `Fits: ${widthGap}" width gap, ${heightGap}" height gap.`,
  };
}

/** Smallest of the measured points is the binding dimension (window-install rule). */
export function smallest(values: (number | null | undefined)[]): number | null {
  const nums = values.filter((v): v is number => typeof v === "number" && v > 0);
  if (nums.length === 0) return null;
  return Math.min(...nums);
}

export type ReadyStatus = "ready" | "blocked" | "incomplete";

export interface ReadyInput {
  hasUnit: boolean;
  typeMatches: boolean;
  fit: FitVerdict;
  condition: "unknown" | "ok" | "damaged";
  atLocationOrLoaded: boolean;
}

export interface ReadyResult {
  status: ReadyStatus;
  reasons: string[];
}

/**
 * "Ready to install?" gate: right unit + fits + undamaged + on hand.
 * blocked = a hard stop (wrong type / too small / damaged).
 * incomplete = missing info (no unit, unmeasured, condition unchecked).
 */
export function readyToInstall(input: ReadyInput): ReadyResult {
  const reasons: string[] = [];
  let blocked = false;

  if (!input.hasUnit) {
    reasons.push("No unit assigned yet.");
  } else if (!input.typeMatches) {
    reasons.push("Assigned unit is the wrong type.");
    blocked = true;
  }

  if (input.condition === "damaged") {
    reasons.push("Unit is marked damaged.");
    blocked = true;
  } else if (input.condition === "unknown") {
    reasons.push("Condition not checked yet.");
  }

  if (input.fit === "too_small") {
    reasons.push("Rough opening is too small for the unit.");
    blocked = true;
  } else if (input.fit === "unknown") {
    reasons.push("Rough opening not measured.");
  }

  if (input.hasUnit && !input.atLocationOrLoaded) {
    reasons.push("Unit is not staged/loaded/on-site.");
  }

  if (blocked) return { status: "blocked", reasons };
  if (reasons.length > 0) return { status: "incomplete", reasons };
  return { status: "ready", reasons: ["Right unit, fits, undamaged, on hand."] };
}
