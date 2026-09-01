import { Link, useLocation } from "react-router-dom";
import { Sparkles } from "lucide-react";

/**
 * Always-on entry point to the Infinity AI assistant (`/ask`). Rendered once in
 * the app shell so it floats over every route for every role — `/ask` is open
 * to the installer floor, so no role can be sent to a blocked page. Hidden only
 * on the Ask page itself so it never covers its own chat input.
 */
export function GlobalAskFab() {
  const { pathname } = useLocation();
  if (pathname === "/ask") return null;

  return (
    <Link to="/ask" className="ask-fab" aria-label="Ask Forge AI">
      <Sparkles size={18} className="ask-fab-icon" aria-hidden="true" />
      <span className="ask-fab-label">Ask</span>
    </Link>
  );
}
