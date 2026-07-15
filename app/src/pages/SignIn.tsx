import { useState } from "react";
import { supabase, supabaseConfigured } from "../lib/supabase";

export function SignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const signIn = async () => {
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) setError(error.message);
    setBusy(false);
  };

  return (
    <div className="signin">
      <h1>Window Ops</h1>
      <p className="muted">Warehouse inventory</p>
      {!supabaseConfigured && (
        <p className="error">
          Supabase is not configured. Set VITE_SUPABASE_URL and
          VITE_SUPABASE_ANON_KEY.
        </p>
      )}
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
      <button className="primary" onClick={signIn} disabled={busy}>
        {busy ? "Signing in..." : "Sign in"}
      </button>
    </div>
  );
}
