import type { ComponentType } from "react";
import { Bed, Car, Clock, PlaneLanding, PlaneTakeoff } from "lucide-react";
import type { TimelineItem, TimelineKind } from "../../lib/travel/timeline";
import { formatDayInZone, formatTimeWithZone } from "../../lib/travel/dates";
import { TimelineActionButton } from "./TimelineActionButton";

type IconComponent = ComponentType<{ className?: string; size?: number }>;

const ICONS: Record<TimelineKind, IconComponent> = {
  leave_by: Clock,
  airport_by: Clock,
  flight_depart: PlaneTakeoff,
  flight_arrive: PlaneLanding,
  ground_pickup: Car,
  ground_dropoff: Car,
  lodging_checkin: Bed,
  lodging_checkout: Bed,
};

/** The scannable chronological timeline (default trip view). */
export function TripTimeline({
  items,
  nextUpId,
}: {
  items: TimelineItem[];
  nextUpId?: string | null;
}) {
  if (items.length === 0) {
    return <p className="muted travel-empty-note">No scheduled times yet.</p>;
  }
  return (
    <ol className="travel-timeline">
      {items.map((item) => {
        const Icon = ICONS[item.kind];
        const isNext = item.id === nextUpId;
        return (
          <li key={item.id} className={`travel-tl-item${isNext ? " is-next" : ""}`}>
            <span className="travel-tl-dot" aria-hidden>
              <Icon size={15} />
            </span>
            <div className="travel-tl-body">
              <div className="travel-tl-line">
                <strong className="travel-tl-title">{item.title}</strong>
                <span className="travel-tl-time">{formatTimeWithZone(item.at, item.timezone)}</span>
              </div>
              <span className="travel-tl-sub muted">
                {formatDayInZone(item.at, item.timezone)}
                {item.subtitle ? ` · ${item.subtitle}` : ""}
              </span>
            </div>
            <div className="travel-tl-action">
              <TimelineActionButton action={item.action} />
            </div>
          </li>
        );
      })}
    </ol>
  );
}
