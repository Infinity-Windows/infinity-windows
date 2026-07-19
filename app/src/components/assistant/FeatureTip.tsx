import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { Lightbulb, X } from "lucide-react";
import {
  FEATURE_TIPS,
  dismissTip,
  isTipDismissed,
  tipKeyForRoute,
} from "../../lib/featureTips";

/**
 * First-run micro-tip anchored just above the bottom nav. Shows at most one tip
 * per route, only until the user dismisses it ("Skip" for now, or "Don't show
 * again" to persist). Non-blocking and keyboard-operable.
 */
export function FeatureTip() {
  const location = useLocation();
  const key = tipKeyForRoute(location.pathname);
  const [visibleKey, setVisibleKey] = useState<string | null>(null);

  // Decide whether to show a tip when the route settles. A short delay avoids
  // popping the tip during navigation transitions.
  useEffect(() => {
    setVisibleKey(null);
    if (!key || isTipDismissed(key)) return;
    const t = setTimeout(() => setVisibleKey(key), 600);
    return () => clearTimeout(t);
  }, [key]);

  if (!visibleKey) return null;
  const tip = FEATURE_TIPS[visibleKey];
  if (!tip) return null;

  const skip = () => setVisibleKey(null);
  const never = () => {
    dismissTip(tip.key);
    setVisibleKey(null);
  };

  return (
    <div className="feature-tip" role="dialog" aria-label={`Tip: ${tip.title}`}>
      <div className="feature-tip-head">
        <p className="feature-tip-title">
          <Lightbulb size={15} aria-hidden /> {tip.title}
        </p>
        <button type="button" className="feature-tip-x" aria-label="Dismiss tip" onClick={skip}>
          <X size={15} />
        </button>
      </div>
      <ol className="feature-tip-steps">
        {tip.steps.map((step, i) => (
          <li key={i}>
            <span className="feature-tip-num" aria-hidden>
              {i + 1}
            </span>
            {step}
          </li>
        ))}
      </ol>
      <div className="feature-tip-actions">
        <button type="button" className="feature-tip-skip" onClick={skip}>
          Skip
        </button>
        <button type="button" className="feature-tip-never" onClick={never}>
          Don't show again
        </button>
      </div>
    </div>
  );
}
