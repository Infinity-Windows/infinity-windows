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
//
// Below the rule: the per-tab unlock, and the one call App makes at every
// change of who is signed in (syncPinLockWithAuth).

import { syncOfflinePinWithAuth } from "./offlinePin";

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
  /**
   * This person entered the right PIN in this tab, in the sign-in they are in
   * now (isUnlockedInThisTab, tied to lib/signedIn's generation by PinGate).
   */
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

/**
 * Where the per-tab unlock is kept. sessionStorage: it lasts for this tab's
 * life — through the reloads the app does by itself (the update-on-open
 * takeover, the missing-chunk recovery) — and ends when the app is closed.
 * That lifetime is its own. The twelve-hour offline unlock (lib/offlinePin.ts)
 * is a different thing: it only decides whether a PIN typed with no signal is
 * the right one, and never opens a lock nobody typed into.
 */
export const TAB_UNLOCK_KEY = "wops-pin-unlocked";

type TabStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function tabStorage(): TabStore | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null; // storage switched off: an unlock lasts as long as the screen
  }
}

/**
 * Has `userId` unlocked the lock in this tab? The unlock holds the id of the
 * person who unlocked and opens for nobody else. It used to be a bare "1" that
 * opened the lock for whoever was signed in next: A unlocked, signed out, B
 * signed in on the same tab and went straight past B's own PIN (Codex review
 * of #651, 2026-09-25). The old "1" is nobody's, so it opens nothing.
 */
export function isUnlockedInThisTab(userId: string, tab: TabStore | null = tabStorage()): boolean {
  try {
    return tab?.getItem(TAB_UNLOCK_KEY) === userId;
  } catch {
    return false;
  }
}

/** `userId` entered the right PIN in this tab. */
export function rememberUnlockInThisTab(userId: string, tab: TabStore | null = tabStorage()): void {
  try {
    tab?.setItem(TAB_UNLOCK_KEY, userId);
  } catch {
    /* storage full or off: the unlock lasts as long as this screen */
  }
}

/**
 * Follow the sign-in on this phone. App.tsx calls this for the session found
 * at launch and for every auth event after it, with the signed-in id — the
 * same moments it tells lib/signedIn, whose mark drops any PIN check still in
 * flight for the sign-in before. The lock keeps nothing for anybody but the
 * person signed in now: the per-tab unlock goes at sign-out and at any change
 * of who is signed in, and the offline unlock follows its own rules
 * (syncOfflinePinWithAuth).
 */
export function syncPinLockWithAuth(
  event: string,
  userId: string | null,
  tab: TabStore | null = tabStorage(),
): void {
  if (event === "SIGNED_OUT" || !userId || !isUnlockedInThisTab(userId, tab)) {
    try {
      tab?.removeItem(TAB_UNLOCK_KEY);
    } catch {
      /* nothing kept, nothing to clear */
    }
  }
  syncOfflinePinWithAuth(event, userId);
}
