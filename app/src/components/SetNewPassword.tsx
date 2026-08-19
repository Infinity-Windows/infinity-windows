// The other half of the password-reset fix (owner report, 2026-08-18): a
// valid reset link used to sign you in silently and never ask for the new
// password. This screen renders when the app boots from a recovery link —
// one job, two fields, then back to the app.

import { useState } from "react";
import { formatApiError } from "../lib/errors";
import { newPasswordProblem } from "../lib/passwordReset";
import { supabase } from "../lib/supabase";

export function SetNewPassword({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    const problem = newPasswordProblem(pw, confirm);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    const { error: saveError } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (saveError) {
      setError(formatApiError(saveError));
      return;
    }
    setSaved(true);
  };

  return (
    <div className="signin">
      <div className="signin-brand">
        <h1>INFINITY</h1>
        <div className="signin-rule">
          <span>Windows &amp; Doors</span>
        </div>
      </div>

      {saved ? (
        <div className="signin-done">
          <div className="signin-done-check">✓</div>
          <p className="ok" style={{ margin: 0, fontWeight: 600, fontSize: 16 }}>
            New password saved
          </p>
          <p className="muted" style={{ margin: "6px 0 0" }}>
            You&rsquo;re signed in. Next time, use the new one.
          </p>
          <button
            className="primary big"
            style={{ marginTop: 12 }}
            onClick={onDone}
          >
            Open the app
          </button>
        </div>
      ) : (
        <div className="signin-form">
          <p style={{ margin: "0 0 4px", fontWeight: 600 }}>Set a new password</p>
          <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
            Your reset link worked — pick the new password now. At least 8
            characters.
          </p>
          <input
            type="password"
            placeholder="New password"
            value={pw}
            autoComplete="new-password"
            onChange={(e) => setPw(e.target.value)}
          />
          <input
            type="password"
            placeholder="Same password again"
            value={confirm}
            autoComplete="new-password"
            onChange={(e) => setConfirm(e.target.value)}
          />
          {error && <p className="error">{error}</p>}
          <button className="primary big" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save new password"}
          </button>
        </div>
      )}
    </div>
  );
}
