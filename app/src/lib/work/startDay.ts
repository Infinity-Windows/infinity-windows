// Start day (crew redesign K1.3, owner's rule + Q69, 2026-09-23): what the
// one big button on Work does when it is tapped.
//
// Three facts decide it — is there a talk today, has this person signed it,
// and is the paid-time rule in force — and there are exactly three plans:
//
//   clock-in            already signed (or nothing to sign): the tap IS the
//                       clock-in, and the person lands on Work with Next up.
//   sign-then-clock-in  unsigned, rule OFF (today's timing): the tap opens the
//                       talk; signing it fires the clock-in. Same two taps
//                       the classic landing block has had since 2026-09-06.
//   clock-in-then-sign  unsigned, rule ON: paid time starts at this tap, so
//                       the clock-in goes first and the talk is signed on the
//                       clock. Unit work stays locked until it is signed, the
//                       clock keeps running, "Finish your toolbox talk" stays
//                       on Work, and the foreman's compliance list reads "not
//                       signed" — all of which follow from the record, not
//                       from anything this file remembers.
//
// Unknown answers fail OPEN to "clock-in": the server's gate is the backstop
// (20261031000000, _toolbox_gate_open), and a talk that could not load must
// not strand a crew who may already be signed — the same rule the classic
// block and the clock sheet play by. Pure; unit-tested.

export type StartDayPlan = "clock-in" | "sign-then-clock-in" | "clock-in-then-sign";

export interface StartDayInput {
  /** A talk exists for today. null = could not load (fail open). */
  talkExists: boolean | null;
  /** This person signed today's talk. null = not known yet (fail open). */
  signedToday: boolean | null;
  /** The paid-time rule is in force today (lib/paidTimeRule.ts). */
  ruleActive: boolean;
}

export function startDayPlan(i: StartDayInput): StartDayPlan {
  if (i.talkExists !== true) return "clock-in";
  if (i.signedToday !== false) return "clock-in";
  return i.ruleActive ? "clock-in-then-sign" : "sign-then-clock-in";
}

/**
 * Is unit work locked right now? Only when it is POSITIVELY known that a talk
 * exists today and this person has not signed it. Unknown never locks — a
 * lock drawn from a missing answer is a red banner on every cold load, and
 * the server refuses an unsigned unit start anyway (start_opening_work).
 */
export function unitWorkLocked(i: Pick<StartDayInput, "talkExists" | "signedToday">): boolean {
  return i.talkExists === true && i.signedToday === false;
}

/**
 * How many taps from Start day to working — the K-X3 number the PR states.
 * "Working" means on the clock with unit work unlocked: one tap when the talk
 * is already signed; two (Start day, Sign) for either unsigned plan — the
 * order of the two differs, their count does not.
 */
export function tapsToWorking(plan: StartDayPlan): number {
  return plan === "clock-in" ? 1 : 2;
}

/** Is the shift the app holds a queued punch that has not reached Forge? */
export function isPendingShiftId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith("pending:");
}
