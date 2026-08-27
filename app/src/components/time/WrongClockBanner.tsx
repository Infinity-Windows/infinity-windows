import { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import {
  clockSkewDismissedToday,
  clockSkewMs,
  dismissClockSkewToday,
  fetchServerNowMs,
  isClockSkewed,
} from "../../lib/clockSkew";
import { punchDay } from "../../lib/timeclock";

/**
 * A device clock more than a few minutes off cannot corrupt a recorded
 * time (every write in this app stamps the SERVER's clock, never the
 * device's), but it can make the live timer on screen lie to whoever is
 * reading it. Checked once per mount, dismissible, and re-warns the next
 * calendar day even if dismissed today — same reasoning as
 * ToolboxTalkNagBanner: non-blocking, easy to see, easy to put away.
 */
export function WrongClockBanner() {
  const [skewMs, setSkewMs] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const today = punchDay(new Date().toISOString());

  useEffect(() => {
    let cancelled = false;
    fetchServerNowMs()
      .then((serverMs) => {
        if (!cancelled) setSkewMs(clockSkewMs(Date.now(), serverMs));
      })
      .catch(() => {
        // Can't reach the server to check — say nothing rather than warn
        // about a network hiccup as though it were a wrong clock.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (skewMs == null || !isClockSkewed(skewMs)) return null;
  if (dismissed || clockSkewDismissedToday(today)) return null;

  const minutes = Math.round(Math.abs(skewMs) / 60_000);
  const direction = skewMs > 0 ? "ahead of" : "behind";

  return (
    <div className="toolbox-nag" role="alert">
      <span className="toolbox-nag-icon" aria-hidden>
        <AlertTriangle size={18} />
      </span>
      <span className="toolbox-nag-text">
        <strong>This device's clock looks wrong</strong>
        <span>
          About {minutes} minute{minutes === 1 ? "" : "s"} {direction} the
          server. Punches still record the real time, but the timer here may
          not match reality until this is fixed.
        </span>
      </span>
      <button
        type="button"
        className="toolbox-nag-chevron"
        aria-label="Dismiss for today"
        style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
        onClick={() => {
          dismissClockSkewToday(today);
          setDismissed(true);
        }}
      >
        <X size={18} aria-hidden />
      </button>
    </div>
  );
}
