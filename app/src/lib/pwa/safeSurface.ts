// "Is the person on a screen where an automatic reload can cost them nothing?"
//
// Two claim counts, read together, the same shape as unsavedWork.ts:
//
//   - SAFE claims: a screen that holds nothing declares itself. Today that is
//     the sign-in screen, the landing splash in front of it, and the Work
//     landing ("/": My Work, Home, Heartbeat). Nothing else, on purpose — a
//     screen is a safe surface because someone read it and said so, never
//     because it did not say otherwise.
//   - OVERLAY claims: a sheet, drawer or dialog open on top of a screen. A
//     landing with the clock sheet or the capture sheet up is not the landing
//     any more; it is whatever the person is doing in that sheet.
//
// So a surface is safe only while at least one screen claims it AND no
// overlay is open. The update banner reads this for the automatic paths that
// PR #632 added — "just opened" and "on the sign-in screen" — after an
// independent review (2026-09-23) showed the opening window treating any
// screen as safe once four seconds passed without a tap, including one with a
// voice memo recording. The older "came back after a minute away" path does
// not read this: it was already live everywhere and is guarded by the
// unsaved-work and queued-work checks instead.
//
// Claims come from React effects (useSafeSurface.ts), so mounting is the
// claim and unmounting is the release, and a double release cannot drop
// somebody else's claim.

type Listener = () => void;

let safeClaims = 0;
let overlayClaims = 0;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // One bad listener must not strand the others, and none of them are
      // important enough to break a screen over.
    }
  }
}

function claim(bump: (delta: 1 | -1) => void): () => void {
  bump(1);
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    bump(-1);
    notify();
  };
}

/** This screen holds nothing a reload could lose. Returns the release. */
export function claimSafeSurface(): () => void {
  return claim((d) => {
    safeClaims += d;
  });
}

/** A sheet, drawer or dialog is open on top of whatever screen is showing. */
export function claimOverlay(): () => void {
  return claim((d) => {
    overlayClaims += d;
  });
}

/** Safe screen on show, and nothing open on top of it. */
export function onSafeSurface(): boolean {
  return safeClaims > 0 && overlayClaims === 0;
}

/** The raw counts. Exposed for tests and debugging. */
export function safeSurfaceClaims(): { safe: number; overlays: number } {
  return { safe: safeClaims, overlays: overlayClaims };
}

/** Subscribe to changes. Returns an unsubscribe function. */
export function subscribeSafeSurface(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: drop every claim and listener. */
export function resetSafeSurface(): void {
  safeClaims = 0;
  overlayClaims = 0;
  listeners.clear();
}
