import { TriangleAlert } from "lucide-react";
import { projectWarning } from "../lib/supabaseProject";

/**
 * Loud, app-wide warning when the app is talking to a Supabase project other
 * than the one shared project. Two people once worked against two different
 * databases for weeks without noticing, so this is deliberately hard to miss
 * and deliberately not dismissable — but it is only a warning: the app keeps
 * working so a self-hosted or experimental setup is never blocked.
 *
 * Uses the same fixed banner shell as the PWA install/update banners, with a
 * danger tint. Renders nothing in the normal case.
 */
export function WrongProjectBanner() {
  const warning = projectWarning(
    import.meta.env.VITE_SUPABASE_URL as string | undefined,
  );
  if (!warning) return null;

  return (
    <div
      className="pwa-banner pwa-banner-wrong-project"
      role="alert"
      aria-live="assertive"
    >
      <span className="pwa-banner-icon" aria-hidden>
        <TriangleAlert size={18} />
      </span>
      <div className="pwa-banner-text">
        <strong>Wrong database</strong>
        <span>
          Connected to <code>{warning.connected}</code>, expected{" "}
          <code>{warning.expected}</code>. Your changes will not appear for
          anyone else. Copy <code>app/.env.example</code> to{" "}
          <code>app/.env</code> and restart the dev server.
        </span>
      </div>
    </div>
  );
}
