// The password-reset landing, in three pure pieces (owner report, 2026-08-18:
// "the email arrives, the link loads an error page").
//
// The bug had two halves. First, the emailed link was told to come back to
// window.location.origin — the DOMAIN ROOT — but on GitHub Pages the app
// lives under a base path (/infinity-windows/), and the domain root is a 404
// page. Second, even landing on the app, nothing handled the recovery: no
// "set a new password" screen existed, so a valid link would just sign you
// in silently. These helpers pin both halves down where tests can hold them.

/**
 * Where the reset email should send the person back to: the app's real URL,
 * origin PLUS base path. `base` is import.meta.env.BASE_URL — "/" in dev,
 * "/infinity-windows/" on Pages. Passing bare origin was the 404.
 */
export function passwordResetRedirectUrl(origin: string, base: string): string {
  const cleanOrigin = origin.replace(/\/+$/, "");
  const cleanBase = base || "/";
  return cleanOrigin + (cleanBase.startsWith("/") ? cleanBase : `/${cleanBase}`);
}

/**
 * Did this page load come from a recovery link? Supabase's implicit-flow
 * redirect lands with `#access_token=…&type=recovery`. Read the hash BEFORE
 * the supabase client strips it (a module-scope snapshot — the client's URL
 * detection is async, so import-time reads always win).
 */
export function isRecoveryLanding(hash: string): boolean {
  return /(^|[#&])type=recovery(&|$)/.test(hash);
}

/**
 * An expired or already-used link lands with `#error=access_denied&
 * error_code=otp_expired&error_description=…` and NO session. Turn that into
 * one plain sentence for the sign-in screen, or null when the hash carries
 * no auth error.
 */
export function authErrorFromHash(hash: string): string | null {
  if (!/(^|[#&])error(_code|_description)?=/.test(hash)) return null;
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  if (params.get("error_code") === "otp_expired") {
    return "That reset link has expired — send yourself a fresh one below.";
  }
  const desc = params.get("error_description");
  if (desc) return desc.replace(/\+/g, " ");
  return "That link didn't work — send yourself a fresh one below.";
}

/**
 * Client-side check before we ask the server to save the new password.
 * Returns the plain-language problem, or null when the pair is good to send.
 */
export function newPasswordProblem(pw: string, confirm: string): string | null {
  if (pw.length < 8) return "Use at least 8 characters.";
  if (pw !== confirm) return "The two passwords don't match.";
  return null;
}
