// What the device lock shows, decided from what the phone knows.
//
// The lock (components/PinGate.tsx) opens on one answer only: a definite "this
// person has no PIN", from the server just now or from the last answer this
// phone got. Everything else keeps it shut — the PIN pad when the answer is "has
// a PIN", a short "Checking device lock…" while the first answer is on its way,
// and, when there is no answer and none arriving, a plain message with a Try
// again button.
//
// That last state is why this exists (2026-09-24). Reopened with no signal, the
// lock used to have nothing to go on: it sat on "Checking device lock…" for as
// long as the read hung, and when the read FAILED it took the failure for "no
// PIN" and opened for somebody who has one. Crews on a site with no bars were
// either stuck in front of their own clock or let past a lock they had set.

/**
 * How long "Checking device lock…" may show before the person is told why.
 * The read itself keeps going; an answer that lands later still opens the lock
 * (or shows the pad). Well inside the 15 s request deadline in
 * lib/offline/weakSignal.ts, so nobody watches a spinner for the whole of it.
 */
export const PIN_CHECK_WAIT_MS = 8_000;

export type PinGateView =
  /** Let them in. */
  | "open"
  /** "Checking device lock…" — bounded by PIN_CHECK_WAIT_MS. */
  | "checking"
  /** The PIN pad. */
  | "pin"
  /** No answer at all, and none arriving: say so, offer Try again. */
  | "no-answer";

export interface PinGateFacts {
  /** The right PIN was entered earlier in this launch (sessionStorage). */
  unlocked: boolean;
  /** The phone's saved copy is still being read back from storage. */
  restoring: boolean;
  /**
   * The last answer to "does this person have a PIN": from the server just
   * now, or the copy kept on the phone. `undefined` when there is neither.
   */
  hasPin: boolean | undefined;
  /** A read of that answer is on the wire right now. */
  asking: boolean;
  /** The profile — the name on the PIN pad — is still loading. */
  profileLoading: boolean;
  /** "Checking device lock…" has had its PIN_CHECK_WAIT_MS. */
  waitedOut: boolean;
}

export function pinGateView(f: PinGateFacts): PinGateView {
  if (f.unlocked) return "open";
  // Until the saved copy is back there is no telling a PIN account from a
  // no-PIN one; opening "for now" would let the app mount behind the lock.
  if (f.restoring) return "checking";
  if (f.hasPin === undefined) return f.asking && !f.waitedOut ? "checking" : "no-answer";
  // Same order as before this change: wait for the name as well as the answer,
  // but never longer than the lock waits for anything else.
  if (f.profileLoading && !f.waitedOut) return "checking";
  return f.hasPin ? "pin" : "open";
}
