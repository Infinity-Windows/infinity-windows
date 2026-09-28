// The one-time "Try the new Forge" invitation on the classic landings
// (crew redesign K-X2, the owner's rollout: everybody gets the option).
//
// It renders on the three classic "/" landings and nowhere else, only while
// the owner's master switch is on and this person has not switched. "Try it"
// flips their own choice (the same write Settings makes); "Not now" hides the
// card on this device and leaves Settings as the door. Nothing here is a
// setting of its own.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Sparkles } from "lucide-react";
import { useDesign } from "../../lib/design/context";
import { dismissTryCard, showTryCard, tryCardDismissed } from "../../lib/design/design";
import { useT } from "../../lib/i18n";
import { getRealProfile } from "../../lib/install/api";

export function TryNewDesignCard() {
  const t = useT();
  const { choice, masterOn, setChoice } = useDesign();
  // The real person: the dismissal is theirs, not the previewed role's.
  const me = useQuery({ queryKey: ["myRealProfile"], queryFn: getRealProfile });
  const uid = me.data?.id ?? null;
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  const wasDismissed = dismissed ?? (uid ? tryCardDismissed(uid) : true);

  if (!uid || choice === null) return null;
  if (!showTryCard({ masterOn, personChoice: choice, dismissed: wasDismissed })) return null;

  return (
    <section className="try-design-card" aria-label={t("design.try.title")}>
      <p className="try-design-title">
        <Sparkles size={18} aria-hidden /> {t("design.try.title")}
      </p>
      <p className="try-design-body">{t("design.try.body")}</p>
      <div className="try-design-actions">
        <button
          type="button"
          className="try-design-btn try-design-btn--primary"
          onClick={() => {
            dismissTryCard(uid);
            setDismissed(true);
            setChoice("new");
          }}
        >
          {t("design.try.yes")}
        </button>
        <button
          type="button"
          className="try-design-btn"
          onClick={() => {
            dismissTryCard(uid);
            setDismissed(true);
          }}
        >
          {t("design.try.no")}
        </button>
      </div>
    </section>
  );
}
