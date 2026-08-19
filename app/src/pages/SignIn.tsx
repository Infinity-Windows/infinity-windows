import { useState } from "react";
import { formatApiError } from "../lib/errors";
import { passwordResetRedirectUrl } from "../lib/passwordReset";
import { supabase, supabaseConfigured } from "../lib/supabase";
import { submitAccessRequest } from "../lib/install/api";

/**
 * There is no "create your own account" here any more.
 *
 * Anyone with an email address used to be able to sign themselves up, which
 * put them straight into the crew directory and the twenty-odd screens an
 * installer can reach. Self-signup is now switched off in the project's auth
 * settings, so the only way in is: request access, a supervisor or the owner
 * approves it on the Admin screen, and that approval creates the login and
 * hands them a one-time password. Leaving the old button here would just show
 * everyone "Signups not allowed for this instance".
 */
type Mode = "signin" | "request";

export function SignIn({
  initialMode = "signin",
  initialNotice = null,
  onHaveInviteCode,
}: {
  initialMode?: Mode;
  /** A plain sentence about how they landed here — e.g. an expired reset link. */
  initialNotice?: string | null;
  /**
   * For someone a supervisor added on the Crew access screen. They were texted a
   * link, but chat apps mangle links, so they can type the code instead. This is
   * not self-signup: without a valid code it goes nowhere.
   */
  onHaveInviteCode?: () => void;
}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(initialNotice);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Access request fields
  const [reqName, setReqName] = useState("");
  const [reqEmail, setReqEmail] = useState("");
  const [reqPhone, setReqPhone] = useState("");
  const [reqRole, setReqRole] = useState("installer");
  const [requested, setRequested] = useState(false);

  const signIn = async () => {
    setBusy(true);
    setError(null);
    setInfo(null);
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) setError(error.message);
    setBusy(false);
  };

  const resetPassword = async () => {
    setBusy(true);
    setError(null);
    setInfo(null);
    if (!email.trim()) {
      setError("Enter your email first, then reset password.");
      setBusy(false);
      return;
    }
    // The app lives under a base path on GitHub Pages — bare origin was a 404
    // page, which is where every reset email used to land (owner report,
    // 2026-08-18). The helper joins origin + BASE_URL; App.tsx handles the
    // recovery landing with the Set-new-password screen.
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(
      email.trim(),
      {
        redirectTo: passwordResetRedirectUrl(
          window.location.origin,
          import.meta.env.BASE_URL,
        ),
      },
    );
    if (resetError) setError(resetError.message);
    else setInfo("Password reset email sent — check your inbox, then Sign in.");
    setBusy(false);
  };

  const submitRequest = async () => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await submitAccessRequest({
        name: reqName,
        email: reqEmail || undefined,
        phone: reqPhone || undefined,
        requested_role: reqRole,
      });
      setRequested(true);
    } catch (e) {
      setError(formatApiError(e));
    }
    setBusy(false);
  };

  return (
    <div className="signin">
      <div className="signin-brand">
        <h1>INFINITY</h1>
        <div className="signin-rule">
          <span>Windows &amp; Doors</span>
        </div>
      </div>

      {!supabaseConfigured && (
        <p className="error">
          Supabase is not configured. Set VITE_SUPABASE_URL and
          VITE_SUPABASE_ANON_KEY.
        </p>
      )}

      {mode === "request" ? (
        requested ? (
          <div className="signin-done">
            <div className="signin-done-check">✓</div>
            <p
              className="ok"
              style={{ margin: 0, fontWeight: 600, fontSize: 16 }}
            >
              Request submitted
            </p>
            <p
              className="muted"
              style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}
            >
              You're in the approval queue. An admin will review it — you'll be
              able to sign in once you're approved.
            </p>
            <button
              className="secondary"
              onClick={() => {
                setMode("signin");
                setRequested(false);
              }}
            >
              Back to start
            </button>
          </div>
        ) : (
          <>
            <p className="muted" style={{ margin: 0, lineHeight: 1.55 }}>
              Submit your info — an admin approves new accounts before you can
              sign in.
            </p>
            <input
              placeholder="Full name"
              value={reqName}
              onChange={(e) => setReqName(e.target.value)}
            />
            {/* Required, not optional: the email IS the login. Approving a
                request with no email cannot create an account, which is how
                approvals used to end in nothing happening. */}
            <input
              type="email"
              placeholder="Email"
              value={reqEmail}
              onChange={(e) => setReqEmail(e.target.value)}
            />
            <input
              placeholder="Cell phone (optional)"
              value={reqPhone}
              onChange={(e) => setReqPhone(e.target.value)}
            />
            <label className="field-label">Role you're joining as</label>
            <select
              value={reqRole}
              onChange={(e) => setReqRole(e.target.value)}
            >
              <option value="installer">Installer</option>
              <option value="foreman">Foreman</option>
              <option value="supervisor">Supervisor</option>
            </select>
            {error && <p className="error">{error}</p>}
            <button
              className="primary big"
              onClick={submitRequest}
              disabled={busy || !reqName.trim() || !reqEmail.trim()}
            >
              {busy ? "Submitting..." : "Submit request"}
            </button>
            <button
              className="link"
              onClick={() => {
                setMode("signin");
                setError(null);
              }}
            >
              Back to sign in
            </button>
          </>
        )
      ) : (
        <>
          <p className="signin-kicker">Sign in to your portal</p>
          <input
            type="email"
            placeholder="Email"
            value={email}
            autoComplete="email"
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && signIn()}
          />
          {error && <p className="error">{error}</p>}
          {info && <p className="muted">{info}</p>}
          <button className="primary big" onClick={signIn} disabled={busy}>
            {busy ? "Signing in..." : "Sign in"}
          </button>
          {onHaveInviteCode && (
            <button className="link" onClick={onHaveInviteCode}>
              I was given a code
            </button>
          )}
          <button className="link" onClick={resetPassword} disabled={busy}>
            Reset password
          </button>
          <button
            className="link"
            onClick={() => {
              setMode("request");
              setError(null);
              setInfo(null);
            }}
          >
            Request access
          </button>
          <p className="signin-footnote">
            New crew members need admin approval before their first sign-in.
          </p>
        </>
      )}
    </div>
  );
}
