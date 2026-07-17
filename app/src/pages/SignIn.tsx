import { useState } from "react";
import { supabase, supabaseConfigured } from "../lib/supabase";
import { submitAccessRequest } from "../lib/install/api";

export function SignIn() {
  const [mode, setMode] = useState<"signin" | "request">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
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
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setError(error.message);
    setBusy(false);
  };

  const submitRequest = async () => {
    setBusy(true);
    setError(null);
    try {
      await submitAccessRequest({
        name: reqName,
        email: reqEmail || undefined,
        phone: reqPhone || undefined,
        requested_role: reqRole,
      });
      setRequested(true);
    } catch (e) {
      setError(String(e));
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

      {mode === "signin" ? (
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
          <button className="primary big" onClick={signIn} disabled={busy}>
            {busy ? "Signing in..." : "Sign in"}
          </button>
          <button
            className="secondary"
            onClick={() => {
              setMode("request");
              setError(null);
            }}
          >
            Request access
          </button>
          <p className="signin-footnote">
            New crew members need admin approval before their first sign-in.
          </p>
        </>
      ) : requested ? (
        <div className="signin-done">
          <div className="signin-done-check">✓</div>
          <p className="ok" style={{ margin: 0, fontWeight: 600, fontSize: 16 }}>
            Request submitted
          </p>
          <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>
            You're in the approval queue. An admin will review it — you'll be able
            to sign in once you're approved.
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
            Submit your info — an admin approves new accounts before you can sign
            in.
          </p>
          <input
            placeholder="Full name"
            value={reqName}
            onChange={(e) => setReqName(e.target.value)}
          />
          <input
            placeholder="Cell phone (optional)"
            value={reqPhone}
            onChange={(e) => setReqPhone(e.target.value)}
          />
          <input
            type="email"
            placeholder="Email (optional)"
            value={reqEmail}
            onChange={(e) => setReqEmail(e.target.value)}
          />
          <label className="field-label">Role you're joining as</label>
          <select value={reqRole} onChange={(e) => setReqRole(e.target.value)}>
            <option value="installer">Installer</option>
            <option value="foreman">Foreman</option>
            <option value="admin">Admin</option>
          </select>
          {error && <p className="error">{error}</p>}
          <button
            className="primary big"
            onClick={submitRequest}
            disabled={busy || !reqName.trim()}
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
      )}
    </div>
  );
}
