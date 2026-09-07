import { Bell } from "lucide-react";
import type { TimelineItem } from "../../lib/travel/timeline";
import { formatTimeWithZone, humanizeCountdown } from "../../lib/travel/dates";
import { TimelineActionButton } from "./TimelineActionButton";
import { useT } from "../../lib/i18n";

/**
 * Above-the-fold "next up" banner: the single most imminent item + its action.
 * Always shown when there's an upcoming item so it works even without
 * notification permission.
 */
export function NextUpBanner({ item, nowMs }: { item: TimelineItem; nowMs: number }) {
  const t = useT();
  const when = formatTimeWithZone(item.at, item.timezone);
  const countdown = humanizeCountdown(item.at, nowMs, t);
  return (
    <div className="travel-nextup" role="status">
      <div className="travel-nextup-icon" aria-hidden>
        <Bell size={18} />
      </div>
      <div className="travel-nextup-main">
        <span className="travel-nextup-kicker">
          {t("travelTimeline.nextUp")}
          {countdown ? ` · ${countdown}` : ""}
        </span>
        <strong className="travel-nextup-title">{item.title}</strong>
        <span className="travel-nextup-sub">
          {when}
          {item.subtitle ? ` · ${item.subtitle}` : ""}
        </span>
      </div>
      <div className="travel-nextup-action">
        <TimelineActionButton action={item.action} />
      </div>
    </div>
  );
}
