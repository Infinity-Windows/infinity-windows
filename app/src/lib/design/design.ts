// Which front door a person sees: the classic screens or the new design.
//
// WHY (crew redesign spec K-X2, the owner's own words, 2026-09-23): "roll out
// the new design option to everybody to have the option to switch to. But
// still have the old option as well." So there are exactly two designs, both
// writing the same records, and three facts decide which one renders:
//
//   1. The person's own choice (`profiles.ui_design`, written only through
//      set_my_ui_design — theirs to flip either way, any time, from Settings).
//   2. The owner's master switch for this release
//      (`company_settings.new_design_r1_enabled`). Off means EVERYONE is back
//      on the classic screens at once, whatever they chose — that is the
//      rollback lever, and it has to win.
//   3. A per-device cache of the last resolved answer, so a cold load paints
//      the right design before the profile query returns instead of flashing
//      classic and then jumping. The cache never outranks a fresh answer.
//
// Pure, no React, no Supabase — unit-tested directly.

export type UiDesign = "classic" | "new";

/** localStorage key for the last resolved design on this device. */
export const DESIGN_CACHE_KEY = "forge.design";

/** Only the two words the database accepts; anything else reads as classic. */
export function normalizeDesign(value: unknown): UiDesign {
  return value === "new" ? "new" : "classic";
}

export interface ResolveDesignInput {
  /** `profiles.ui_design` once the profile has loaded; null while unknown. */
  personChoice: UiDesign | null;
  /**
   * The owner's master switch for this release. null while the settings row
   * has not answered yet (cold load, no signal, a database that predates the
   * column) — an unknown switch is treated as ON, because the only reason to
   * flip it off is a deliberate owner action, and a phone with no signal must
   * not bounce a person back to the classic screens for the morning.
   */
  masterOn: boolean | null;
  /** The device cache, for the first paint before the profile answers. */
  cached: UiDesign | null;
}

/** The one rule: master off wins, then the person's choice, then the cache. */
export function resolveDesign(input: ResolveDesignInput): UiDesign {
  if (input.masterOn === false) return "classic";
  if (input.personChoice) return input.personChoice;
  return input.cached ?? "classic";
}

export function readCachedDesign(): UiDesign | null {
  try {
    const v = localStorage.getItem(DESIGN_CACHE_KEY);
    return v === "new" || v === "classic" ? v : null;
  } catch {
    return null;
  }
}

export function writeCachedDesign(design: UiDesign): void {
  try {
    localStorage.setItem(DESIGN_CACHE_KEY, design);
  } catch {
    // Storage blocked: the choice still lives on the profile; only the
    // instant first paint is lost, and a one-render flash is not a break.
  }
}

// ---------------------------------------------------------------------------
// The one-time "Try the new Forge" card (K-X2)
// ---------------------------------------------------------------------------
// Shown once on the classic landing while the master switch is on and the
// person has not switched. Dismissal is per person per device: it is an
// invitation, not a setting, so it does not need to follow the person to a
// new phone — Settings still offers the switch there.

const TRY_CARD_PREFIX = "forge.design.try-card-dismissed.";

export function tryCardDismissed(userId: string): boolean {
  try {
    return localStorage.getItem(TRY_CARD_PREFIX + userId) === "1";
  } catch {
    return false;
  }
}

export function dismissTryCard(userId: string): void {
  try {
    localStorage.setItem(TRY_CARD_PREFIX + userId, "1");
  } catch {
    // Storage blocked: the card comes back next visit. Mild, never a break.
  }
}

/**
 * Should the classic landing show the invitation? Pure so the decision is
 * testable without a DOM: master on, person still on classic, not dismissed.
 */
export function showTryCard(input: {
  masterOn: boolean | null;
  personChoice: UiDesign | null;
  dismissed: boolean;
}): boolean {
  if (input.masterOn === false) return false;
  if (input.personChoice === "new") return false;
  return !input.dismissed;
}
