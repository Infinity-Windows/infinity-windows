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

/** How long the Reset button rests after a SUCCESSFUL send. The mailer
 * enforces its own gap between emails anyway — a sooner tap only burns
 * quota and bounces (owner hit the cap after two tries, 2026-08-18). */
export const RESET_EMAIL_COOLDOWN_SEC = 60;

export interface EmailRefusal {
  /** The plain sentence to show instead of the server's error. */
  line: string;
  /** How long the button rests before another try is worth making. */
  waitSec: number;
}

/**
 * Was this send refused for pace rather than being wrong? Two flavors:
 * the per-address gap ("only request this once every N seconds") gets a
 * short rest; the service-wide cap ("rate limit exceeded") gets the full
 * five minutes the owner asked for. Anything else returns null and the
 * caller shows the error as-is.
 *
 * The CAP itself is Supabase dashboard config: on the built-in mail
 * service it is fixed at a couple of emails an hour and cannot be raised —
 * custom SMTP (go-live wizard stage) is what unlocks the real limit.
 */
export function resetEmailRefusal(message: string): EmailRefusal | null {
  if (/once every \d+ seconds/i.test(message)) {
    return {
      line: "One reset email at a time — give it a minute, then tap again.",
      waitSec: 60,
    };
  }
  if (/rate limit|too many/i.test(message)) {
    return {
      line:
        "The mail service hit its sending cap — not your fault. Wait 5 minutes, then try once more.",
      waitSec: 300,
    };
  }
  return null;
}

/** "5:00" / "1:30" / "45s" — the countdown on the resting Reset button. */
export function cooldownLabel(sec: number): string {
  if (sec >= 60) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  return `${sec}s`;
}
