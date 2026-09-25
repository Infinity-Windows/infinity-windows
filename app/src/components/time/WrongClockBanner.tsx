import { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import {
  clockSkewDismissedToday,
  clockSkewMs,
  dismissClockSkewToday,
  fetchServerNowMs,
  isClockSkewed,
  recordClockCheck,
} from "../../lib/clockSkew";
import { punchDay } from "../../lib/timeclock";
import { useT } from "../../lib/i18n";

/**
 * A device clock more than a few minutes off cannot corrupt a recorded time
 * — since Release 0 (K0.5) a punch's tap time is used for pay ONLY when this
 * device was checked against the server within a day and found within two
 * minutes; a phone this far off is paid from the time its punches reach Forge
 * and those punches are marked for review, which is what the banner now says.
 * The check it makes on mount is also the check the server judges the next
 * punch by (recordClockCheck), so opening the clock is itself what earns the
 * tap time its trust. Checked once per mount, dismissible, and re-warns the
 * next calendar day even if dismissed today — same reasoning as
 * ToolboxTalkNagBanner: non-blocking, easy to see, easy to put away.
 */
export function WrongClockBanner() {
  const t = useT();
  const [skewMs, setSkewMs] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const today = punchDay(new Date().toISOString());

  useEffect(() => {
    let cancelled = false;
    fetchServerNowMs()
      .then((serverMs) => {
        const deviceMs = Date.now();
        // Remembered whether or not the banner ends up showing: a good check is
        // exactly what the next punch needs on its record.
        recordClockCheck(deviceMs, serverMs);
        if (!cancelled) setSkewMs(clockSkewMs(deviceMs, serverMs));
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

  return (
    <div className="toolbox-nag" role="alert">
      <span className="toolbox-nag-icon" aria-hidden>
        <AlertTriangle size={18} />
      </span>
      <span className="toolbox-nag-text">
        <strong>{t("wrongclock.title")}</strong>
        <span>
          {t("wrongclock.body", {
            minutes,
            unit: t(minutes === 1 ? "wrongclock.minute" : "wrongclock.minutes"),
            direction: t(skewMs > 0 ? "wrongclock.ahead" : "wrongclock.behind"),
          })}
        </span>
      </span>
      <button
        type="button"
        className="toolbox-nag-chevron"
        aria-label={t("wrongclock.dismiss")}
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
