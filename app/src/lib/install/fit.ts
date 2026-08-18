// Fit + condition gate: "never carry a window that won't go in."
// Pure logic so it can be unit-tested and run offline.

export type FitVerdict = "fits" | "tight" | "too_small" | "too_big" | "unknown";

/**
 * Single source of truth for "the unit is on hand and can be installed now."
 * A unit unloaded at the jobsite is `on_site`; warehouse stock, staged, and
 * loaded units are also physically available to set. Keep this list here so
 * every screen (MyWork/Dispatch via openingReadiness, and the install sheet)
 * agrees — do not re-copy the check inline.
 */
export const INSTALL_READY_STATUSES = [
  "in_warehouse",
  "staged",
  "loaded",
  "on_site",
] as const;

export function isInstallReadyStatus(s: string | null | undefined): boolean {
  return s != null && (INSTALL_READY_STATUSES as readonly string[]).includes(s);
}

export interface FitClearance {
  /** Minimum gap per side the unit needs to shim/level (inches). Default 1/4". */
  minPerSide: number;
  /** Maximum gap per side before the opening is oversized for the unit. Default 1/2". */
  maxPerSide: number;
}

/**
 * Owner's rule (2026-08-11): the opening must be at least 1/8" looser than
 * the unit OVERALL (tighter won't shim in) and at most 1/2" looser overall
 * (sloppier is a framing problem). Stored per side: totals halved.
 */
export const DEFAULT_CLEARANCE: FitClearance = {
  minPerSide: 0.0625,
  maxPerSide: 0.25,
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
  /**
   * Has a person checked this opening's specs against the plans?
   *
   * The docstring below has always said ready means "confirmed", and the
   * calculation never looked at it — so an unreviewed AI draft, with
   * dimensions nobody verified, could be marked ready, auto-distributed, and
   * recommended as somebody's next window. Optional so callers that genuinely
   * cannot know (older rows, partial selects) behave exactly as before rather
   * than silently flipping every opening to incomplete.
   */
  confirmed?: boolean;
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

  // Incomplete, never blocked: the window is fine, nobody has checked its
  // numbers yet. Blocking would need a foreman; incomplete keeps it in the
  // list wearing the reason, and any installer can clear it from the sheet.
  if (input.confirmed === false) {
    reasons.push("Specs not checked against the plans yet.");
  }

  if (blocked) return { status: "blocked", reasons };
  if (reasons.length > 0) return { status: "incomplete", reasons };
  return { status: "ready", reasons: ["Right unit, fits, undamaged, on hand."] };
}

export interface OpeningLike {
  status: string;
  /** Whether a person has checked this opening against the plans. */
  confirmed?: boolean;
  assigned_window_id: string | null;
  window_type_id: string | null;
  condition: "unknown" | "ok" | "damaged";
  ro_width_in: number | null;
  ro_height_in: number | null;
  window_types?: { width_in: number | null; height_in: number | null } | null;
  windows?: { window_type_id: string; status: string } | null;
}

export interface OpeningReadiness {
  status: ReadyStatus;
  reasons: string[];
  fit: FitVerdict;
}

/** Compute the ready/blocked/incomplete verdict for an opening row. */
export function openingReadiness(o: OpeningLike): OpeningReadiness {
  const fit = checkFit({
    unitWidthIn: o.window_types?.width_in,
    unitHeightIn: o.window_types?.height_in,
    roWidthIn: o.ro_width_in,
    roHeightIn: o.ro_height_in,
  });
  const typeMatches =
    !o.assigned_window_id ||
    !o.window_type_id ||
    o.windows?.window_type_id === o.window_type_id;
  const unitStatus = o.windows?.status ?? null;
  const atLocationOrLoaded = isInstallReadyStatus(unitStatus);

  const result = readyToInstall({
    hasUnit: Boolean(o.assigned_window_id),
    typeMatches,
    fit: fit.verdict,
    condition: o.condition,
    atLocationOrLoaded,
    confirmed: o.confirmed,
  });
  return { status: result.status, reasons: result.reasons, fit: fit.verdict };
}
