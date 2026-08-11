import { useNavigate } from "react-router-dom";

/**
 * The app's back arrow. Goes to the page the user was ACTUALLY on before —
 * real history — never a guessed parent route. The `fallback` only fires on
 * the first in-app page (deep link, fresh PWA launch, pull-to-refresh),
 * where history-back would leave the app entirely.
 *
 * React Router's BrowserRouter stamps every in-app entry with an `idx` in
 * history.state; idx 0 (or none) means "nowhere in-app to go back to".
 */
export function BackChip({
  fallback = "/",
  label = "Back",
}: {
  /** Where to land when there is no in-app history to return to. */
  fallback?: string;
  label?: string;
}) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className="back-chip"
      aria-label={label}
      onClick={() => {
        const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
        if (idx > 0) navigate(-1);
        else navigate(fallback, { replace: true });
      }}
    >
      ‹
    </button>
  );
}
