// A count of "there is work in memory that would be lost by a reload".
//
// Why this is a module and not a prop: the thing that wants to know is the PWA
// update banner, which is mounted once at the very top of the tree (main.tsx),
// while the thing that knows is whatever screen the installer happens to be on.
// Threading a flag between them through every route would be worse than a small
// registry, and it would be quietly wrong the day someone forgets.
//
// A COUNT rather than a boolean because two screens can hold unsaved work at
// once, and the second one releasing must not clear the first one's claim.
//
// Anything that claims must release. `claimUnsavedWork()` hands back the release
// function so it can be returned straight out of a React effect, which is the
// shape that cannot leak on unmount.

type Listener = () => void;

let claims = 0;
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

/**
 * Declare that unsaved work exists. Returns a release function that is safe to
 * call more than once — a double release would otherwise drop somebody else's
 * claim and make a reload look safe when it is not.
 */
export function claimUnsavedWork(): () => void {
  claims += 1;
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    claims -= 1;
    notify();
  };
}

/** Is anything holding work that a reload would destroy? */
export function hasUnsavedWork(): boolean {
  return claims > 0;
}

/** Number of outstanding claims. Exposed for tests and debugging. */
export function unsavedWorkClaims(): number {
  return claims;
}

/** Subscribe to changes. Returns an unsubscribe function. */
export function subscribeUnsavedWork(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: drop every claim and listener. */
export function resetUnsavedWork(): void {
  claims = 0;
  listeners.clear();
}
