interface LandingProps {
  onSignIn: () => void;
  onRequest: () => void;
  onBypass: () => void;
}

export function Landing({ onSignIn, onRequest, onBypass }: LandingProps) {
  return (
    <div className="landing">
      <div className="landing-brand">
        <h1>INFINITY</h1>
        <div className="signin-rule">
          <span>Windows &amp; Doors</span>
        </div>
      </div>
      <p className="landing-tagline">
        Installs, time, supplies, points, and the company brain — one field app
        for the whole crew.
      </p>
      <div className="landing-actions">
        <button className="primary big" onClick={onBypass}>
          Enter without signing in
        </button>
        <button className="secondary" onClick={onSignIn}>
          Sign in
        </button>
        <button className="secondary" onClick={onRequest}>
          Request access
        </button>
      </div>
      <p className="signin-footnote">
        Bypass skips login for local demos. Live data still needs a real sign-in
        + Supabase.
      </p>
    </div>
  );
}
