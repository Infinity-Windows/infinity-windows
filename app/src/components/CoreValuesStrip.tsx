// The company's core values, rotating across the top of the app (owner ask,
// 2026-08-27: "the exact same core values that rotate through" — the eight
// value lines below are Horizon's, word for word, at the owner's explicit
// order; only the roof-flavored tagline was left behind). Horizon's own
// version is a static landing-page grid — the ROTATION is what the owner
// remembers wanting, so that is what this builds: one slim line, a new
// value every eight seconds, crossfade unless the phone asks for reduced
// motion (then an instant swap — it still rotates, it just doesn't animate).
import { useEffect, useRef, useState } from "react";

const CORE_VALUES: { name: string; line: string }[] = [
  { name: "Full send", line: "Show up ready. Finish the day strong." },
  { name: "Ownership", line: "Your job, your call — see it through." },
  { name: "Integrity", line: "Do it right when nobody's watching." },
  { name: "Sincerity", line: "Straight talk. Real respect on site." },
  { name: "Tribe", line: "We win together — crew first, always." },
  { name: "Growth", line: "Learn the trade. Level up every project." },
  { name: "Strategic", line: "Plan the work. Work the plan." },
  { name: "Safety", line: "Every person home safe, every day." },
];

const ROTATE_MS = 8000;

/** The three landing screens — the morning doors. Deep work screens (the
 * map above all) keep every vertical pixel: the strip's 22px pushed the
 * 390px job map enough that the pin-precision suite failed a tap, which is
 * exactly the layout-shift class those tests guard. Values live where the
 * day starts, not on top of a tape measure. */
const LANDING_PATHS = new Set(["/", "/my-work", "/heartbeat"]);

export function CoreValuesStrip({ pathname }: { pathname: string }) {
  if (!LANDING_PATHS.has(pathname)) return null;
  return <CoreValuesStripInner />;
}

function CoreValuesStripInner() {
  const [i, setI] = useState(() => {
    // Start on a different value each day so the same one doesn't own every
    // morning meeting — day-of-year modulo keeps it deterministic per day.
    const now = new Date();
    const day = Math.floor(
      (now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86_400_000,
    );
    return day % CORE_VALUES.length;
  });
  const [faded, setFaded] = useState(false);
  const reduced = useRef(
    typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    const tick = setInterval(() => {
      if (reduced.current) {
        setI((v) => (v + 1) % CORE_VALUES.length);
        return;
      }
      setFaded(true);
      setTimeout(() => {
        setI((v) => (v + 1) % CORE_VALUES.length);
        setFaded(false);
      }, 300);
    }, ROTATE_MS);
    return () => clearInterval(tick);
  }, []);

  const v = CORE_VALUES[i];
  return (
    <div className="core-values-strip" aria-label="Company core values">
      <span className={`core-values-inner${faded ? " core-values-faded" : ""}`}>
        <strong>{v.name}</strong>
        <span className="core-values-line"> — {v.line}</span>
      </span>
    </div>
  );
}
