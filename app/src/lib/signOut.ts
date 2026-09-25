// Signing out because the person asked to (2026-09-24).
//
// When the SERVER ends a phone's sign-in — the login removed, the password
// changed, signed out everywhere — the sign-in screen says so, or a crew
// member just finds themselves there with no idea why. A sign-out they tapped
// needs no such sentence. supabase-js reports both the same way (SIGNED_OUT),
// so every Sign out button goes through here and marks the one it started.

import { supabase } from "./supabase";

let requested = false;

/** Sign this phone out because the person asked to. */
export async function signOutOnRequest(): Promise<void> {
  requested = true;
  try {
    // SIGNED_OUT reaches App's listener before this call returns, so the mark
    // is up for exactly as long as it needs to be.
    await supabase.auth.signOut();
  } finally {
    requested = false;
  }
}

/** Is the sign-out happening right now one the person asked for? */
export function signOutWasRequested(): boolean {
  return requested;
}
