import { useEffect, useState } from "react";
import { formatApiError } from "../lib/errors";
import { supabase } from "../lib/supabase";
import { peekCrewInvite, redeemCrewInvite, type InvitePreview } from "../lib/crewAccess";
import {
  formatInviteCode,
  looksLikeInviteCode,
  MIN_PASSWORD_LENGTH,
  normalizeInviteCode,
  ROLE_TITLES,
  validateInvitePassword,
  type CrewRoleName,
} from "../../../supabase/functions/_shared/crewInvites";

/**
 * "You've been added to Forge Windows" — what a new crew member sees.
 *
 * Reached by tapping the link a supervisor texted them, which carries the code
 * as `?join=…` on the app's own root URL, or by typing the code by hand if the
 * link got mangled in a group chat. It renders before the sign-in screen and
 * outside the router, so it cannot depend on the GitHub Pages subpath resolving
 * a deep path.
 *
 * Designed for the actual situation: one thumb, gloves half off, a cracked
 * screen, no patience. Two things happen — we tell them who they are, and they
 * pick a password. There is no email to check (this project sends none), no
 * confirmation link, no waiting for approval. They tap once and they are in.
 */
export function JoinCrew({
  code: initialCode,
  onGiveUp,
}: {
  /** From the link. Null when they arrived here to type one in. */
  code: string | null;
  onGiveUp: () => void;
}) {
  const [code, setCode] = useState(initialCode ?? "");
  const [typed, setTyped] = useState(initialCode ?? "");
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [checking, setChecking] = useState(Boolean(initialCode));
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signedInAs, setSignedInAs] = useState<string | null>(null);

  // A link opened on a phone that is already signed in as somebody else — a
  // shared foreman's handset, or the owner testing the flow. Setting up a second
  // account here would silently replace their session, so say so and let them
  // choose rather than doing it behind their back.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSignedInAs(data.session?.user?.email ?? null);
    });
  }, []);

  // Look the code up as soon as we have one, so a wrong code fails now rather
  // than after they have invented a password.
  useEffect(() => {
    if (!code || !looksLikeInviteCode(code)) return;
    let cancelled = false;
    setChecking(true);
    setError(null);
    peekCrewInvite(code)
      .then((found) => {
        if (!cancelled) setPreview(found);
      })
      .catch((err) => {
        if (!cancelled) setError(formatApiError(err));
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  const submitCode = () => {
    const clean = normalizeInviteCode(typed);
    if (!looksLikeInviteCode(clean)) {
      setError("That code isn't right. It's 10 letters and numbers.");
      return;
    }
    setError(null);
    setCode(clean);
  };

  const finish = async () => {
    const check = validateInvitePassword(password, confirm);
    if (!check.ok) {
      setError(check.error ?? "Check your password.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // On success this signs them in, the session changes, and App swaps this
      // screen for the app itself. There is nothing to navigate to.
      await redeemCrewInvite(code, password);
    } catch (err) {
      setError(formatApiError(err));
      setBusy(false);
    }
  };

  const roleWord = preview
    ? ROLE_TITLES[preview.role as CrewRoleName] ?? preview.role
    : "";
  const firstName = preview?.display_name?.trim().split(/\s+/)[0] ?? "";

  return (
    <div className="signin">
      <div className="signin-brand">
        <h1>FORGE</h1>
        <div className="signin-rule">
          <span>Windows &amp; Doors</span>
        </div>
      </div>

      {signedInAs && (
        <div className="detail-card" style={{ marginBottom: 4 }}>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55 }}>
            This phone is already signed in as <strong>{signedInAs}</strong>.
            Setting up a new person here will sign that account out.
          </p>
          <div className="row-gap" style={{ marginTop: 10 }}>
            <button
              className="button-like"
              onClick={() => {
                void supabase.auth.signOut();
                setSignedInAs(null);
              }}
            >
              Sign that account out
            </button>
            <button className="link" onClick={onGiveUp}>
              Stay signed in
            </button>
          </div>
        </div>
      )}

      {/* --- No code yet: they typed the app in by hand ------------------- */}
      {!code || (!preview && !checking && error) ? (
        <>
          <p className="signin-kicker">Enter your code</p>
          <p className="muted" style={{ margin: 0, lineHeight: 1.55 }}>
            Whoever added you sent you a 10-character code. Type it here —
            capitals, dashes and spaces don't matter.
          </p>
          <input
            placeholder="ABCDE-23456"
            value={typed}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitCode()}
          />
          {error && <p className="error">{error}</p>}
          <button
            className="primary big"
            onClick={submitCode}
            disabled={!typed.trim()}
          >
            Continue
          </button>
          <button className="link" onClick={onGiveUp}>
            I already have a login
          </button>
        </>
      ) : checking ? (
        <p className="muted">Checking your code…</p>
      ) : preview ? (
        <>
          <p className="signin-kicker">
            {firstName ? `Hi ${firstName}` : "You're being set up"}
          </p>
          <p className="muted" style={{ margin: 0, lineHeight: 1.55 }}>
            {preview.existing_account
              ? `Pick a new password for your ${roleWord} login. That's the only step.`
              : `You've been added to Forge Windows as a ${roleWord}. Pick a password and you're in — there's no email to check.`}
          </p>

          <label className="field-label" htmlFor="join-password">
            Pick a password
          </label>
          <input
            id="join-password"
            type={reveal ? "text" : "password"}
            placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
            value={password}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
          />
          <label className="field-label" htmlFor="join-confirm">
            Type it again
          </label>
          <input
            id="join-confirm"
            type={reveal ? "text" : "password"}
            placeholder="Same password"
            value={confirm}
            autoComplete="new-password"
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void finish()}
          />
          {/* Typing a password twice on a cracked screen with gloves on is where
              this flow gets abandoned. Letting them see it is the fix. */}
          <button className="link" onClick={() => setReveal((v) => !v)}>
            {reveal ? "Hide password" : "Show password"}
          </button>

          {error && <p className="error">{error}</p>}
          <button
            className="primary big"
            onClick={() => void finish()}
            disabled={busy || !password || !confirm}
          >
            {busy ? "Setting you up…" : "Start working"}
          </button>
          <p className="signin-footnote">
            Code {formatInviteCode(code)} · works once
          </p>
        </>
      ) : (
        <>
          {error && <p className="error">{error}</p>}
          <button className="link" onClick={onGiveUp}>
            Back to sign in
          </button>
        </>
      )}
    </div>
  );
}
