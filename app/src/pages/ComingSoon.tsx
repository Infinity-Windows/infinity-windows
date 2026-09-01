import { Link, useLocation } from "react-router-dom";
import { Hammer } from "lucide-react";

interface ComingSoonProps {
  /** Human title for the feature (falls back to a prettified path). */
  title?: string;
  blurb?: string;
}

function prettifyPath(pathname: string): string {
  const last = pathname.replace(/\/+$/, "").split("/").pop() ?? "";
  if (!last) return "This feature";
  return last
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Shared placeholder for Horizon-menu entries that don't map to a built feature
 * yet. Keeps the nav item visible (never hidden) while the screen is a stub.
 */
export function ComingSoon({ title, blurb }: ComingSoonProps) {
  const location = useLocation();
  const heading = title ?? prettifyPath(location.pathname);
  return (
    <div className="page coming-soon">
      <div className="coming-soon-card">
        <span className="coming-soon-icon" aria-hidden>
          <Hammer size={28} />
        </span>
        <p className="home-greeting">Coming soon</p>
        <h1>{heading}</h1>
        <p className="muted">
          {blurb ??
            "This part of Forge Windows isn't built yet. It's on the roadmap — check back soon."}
        </p>
        <Link to="/" className="button-like">
          Back to home
        </Link>
      </div>
    </div>
  );
}
