interface LandingProps {
  onSignIn: () => void;
  onRequest: () => void;
}

export function Landing({ onSignIn, onRequest }: LandingProps) {
  return (
    <div className="landing">
      <div className="landing-brand">
        <h1>FORGE</h1>
        <div className="signin-rule">
          <span>Windows &amp; Doors</span>
        </div>
      </div>
      <p className="landing-tagline">
        Installs, time, supplies, points, and the company brain — one field app
        for the whole crew.
      </p>
      <div className="landing-actions">
        <button className="primary big" onClick={onSignIn}>
          Sign in
        </button>
        <button className="secondary" onClick={onRequest}>
          Request access
        </button>
      </div>
      <p className="signin-footnote">
        New crew members need admin approval before their first sign-in.
      </p>
    </div>
  );
}
