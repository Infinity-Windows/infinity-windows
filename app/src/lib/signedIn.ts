// Who is signed in, answered out of memory instead of over the network.
//
// WHY THIS EXISTS. The photo shutter needs an email for "who took this". It
// used to `await supabase.auth.getUser()` on every tap — a GET /auth/v1/user
// round trip standing between a person pressing the button and the picture
// being compressed. Swapping that for `getSession()` looks free and is not:
// when the stored access token is inside its expiry margin, getSession() fires
// a POST /token refresh and blocks on it (@supabase/auth-js `__loadSession`),
// and that refresh is retried until its own thirty-second budget runs out. A
// phone whose screen has been off in a dead zone — a truck between houses —
// reaches exactly that state, so the first shutter of the visit would sit
// there LONGER than the eight seconds this work set out to remove, and if the
// token has really expired it hands back a null session anyway: the installer
// waited, and the photo still went out with nobody's name on it.
//
// The app already knows the answer. App.tsx resolves the session once at
// sign-in and stays subscribed to every change after it; it tells this module,
// and the shutter reads a string. No await, no request, no stall, and the last
// known name survives a token that has gone stale offline — which is the only
// state in which a field photo is being taken in the first place.

/** The shape this module needs from a Supabase session. Structural on purpose:
 *  `Session | null` satisfies it, and the tests need no SDK. */
export interface SignedInSession {
  user?: { id?: string | null; email?: string | null } | null;
}

let email: string | null = null;
let userId: string | null = null;
/**
 * Moves on every time the signed-in id changes: a sign-out, another login, the
 * same person signing in again after signing out. See signInMark.
 */
let generation = 0;

/**
 * Remember who is signed in. Called by App's auth plumbing — the boot
 * `getSession()` and every `onAuthStateChange` after it — and by nothing else.
 *
 * A null session clears it, because a null session means signed out: Supabase
 * emits one when a refresh fails in a way it will not retry, and that person is
 * no longer the author of anything.
 */
export function rememberSignedIn(session: SignedInSession | null): void {
  const id = session?.user?.id ?? null;
  const before = userId;
  if (id !== userId) generation++;
  email = session?.user?.email ?? null;
  userId = id;
  if (userId !== before) {
    for (const cb of listeners) {
      try {
        cb();
      } catch {
        /* a listener must never break sign-in */
      }
    }
  }
}

/** Who was signed in when a piece of work began. */
export interface SignInMark {
  readonly userId: string | null;
  readonly generation: number;
}

/**
 * A mark of who is signed in right now. Slow work that could let somebody in —
 * the device lock's check with the server, its offline fingerprint — takes one
 * BEFORE it starts, and asks stillSignedInAs right before it writes anything.
 */
export function signInMark(): SignInMark {
  return { userId, generation };
}

/**
 * The sign-in generation right now. The device lock ties an unlock to it, so
 * an unlock ends with the sign-in it was made in — even when the next sign-in
 * is the same person's.
 */
export function signInGeneration(): number {
  return generation;
}

/**
 * Is `who` still the person signed in, with no sign-out and no other login
 * since `mark` was taken? False after ANY change of who is signed in, even
 * back to the same person. Work begun before that boundary belongs to a
 * sign-in that has ended, and must land nowhere: a yes from the server that
 * arrived after a sign-out used to keep a fresh offline unlock for the person
 * who had just signed out (Codex review of #651, 2026-09-25).
 */
export function stillSignedInAs(mark: SignInMark, who: string): boolean {
  return mark.generation === generation && mark.userId === who && userId === who;
}

const listeners = new Set<() => void>();

/** Told when the signed-in person changes (signed in, out, or somebody else). */
export function subscribeSignedIn(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * The signed-in person's email, or null before sign-in has resolved. Never
 * throws, never blocks, never touches the network — safe to call from inside a
 * shutter press.
 */
export function signedInEmail(): string | null {
  return email;
}

/**
 * The signed-in person's auth id, or null before sign-in has resolved — the
 * REAL login, never a person being previewed. The device lock's saved answer
 * is keyed on this id, because my_pin_status answers for auth.uid(): App hands
 * the same id to PinGate from its session, and the Crew screen's PIN setter
 * reads it here so a PIN change lands on the answer the lock keeps.
 * Same promises as signedInEmail: no await, no request.
 * The outbox stamps it on every write it queues (2026-09-25), so the queue
 * sends a write only as that person — see lib/offline/entryOwner.ts.
 */
export function signedInUserId(): string | null {
  return userId;
}
