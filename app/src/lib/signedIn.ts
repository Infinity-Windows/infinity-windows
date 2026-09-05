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
  user?: { email?: string | null } | null;
}

let email: string | null = null;

/**
 * Remember who is signed in. Called by App's auth plumbing — the boot
 * `getSession()` and every `onAuthStateChange` after it — and by nothing else.
 *
 * A null session clears it, because a null session means signed out: Supabase
 * emits one when a refresh fails in a way it will not retry, and that person is
 * no longer the author of anything.
 */
export function rememberSignedIn(session: SignedInSession | null): void {
  email = session?.user?.email ?? null;
}

/**
 * The signed-in person's email, or null before sign-in has resolved. Never
 * throws, never blocks, never touches the network — safe to call from inside a
 * shutter press.
 */
export function signedInEmail(): string | null {
  return email;
}
