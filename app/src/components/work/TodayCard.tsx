// Today / Next up on Work (crew redesign K1.2 item 2, 2026-09-23) — the
// classic CrewStartBar upgraded for the new design: the job, its start,
// address with Directions, who is with you, the truck, when the entry was
// last updated and a Changed tag when it moved after publishing. The classic
// bar itself is untouched (K-X2: old screens frozen); this reads the same
// rows through lib/work/today.ts so the two cannot disagree.
//
// It never says "no work" when the phone simply cannot reach Forge: with a
// saved copy it shows the copy and says how old it is; with nothing saved it
// says it cannot reach Forge (K1.6's rule, shared with the Schedule tab).

import { Link } from "react-router-dom";
import { CalendarDays, MapPin, Truck, Users } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useT } from "../../lib/i18n";
import "../../lib/i18n/workCatalog";
import { savedCopyReason } from "../../lib/offline/useSavedCopy";
import { useConnection } from "../../lib/offline/useWeakSignal";
import { agendaDayLabel, formatScheduleTime } from "../../lib/schedule/dates";
import type { ScheduleAssignment } from "../../lib/schedule/types";
import { listVehicleLinksForAssignments } from "../../lib/vehicles/api";
import { vehicleTitle } from "../../lib/vehicles/display";
import { assignmentChanged, crewmateNamesOn, formatUpdatedAt, type TodayPick } from "../../lib/work/today";
import { DirectionsButton } from "../maps/DirectionsButton";

export interface TodayCardProps {
  meId: string;
  todayISO: string;
  pick: TodayPick;
  /** The schedule query's state, for the saved-copy line. */
  query: { data: unknown; isError: boolean; isPending: boolean; fetchStatus: "fetching" | "paused" | "idle"; dataUpdatedAt: number };
  now: number;
}

export function TodayCard({ meId, todayISO, pick, query, now }: TodayCardProps) {
  const t = useT();
  const { online, weak } = useConnection();
  const reason = savedCopyReason(query, online, weak);
  const ids = pick.entries.map((a) => a.id);
  const vehicles = useQuery({
    queryKey: ["myScheduleVehicles", ids],
    queryFn: () => listVehicleLinksForAssignments(ids),
    enabled: ids.length > 0,
  });
  const truckFor = (a: ScheduleAssignment) => {
    const link = (vehicles.data ?? []).find((l) => l.assignment_id === a.id && l.vehicle);
    return link?.vehicle ? vehicleTitle(link.vehicle) : null;
  };

  const heading =
    pick.day === null
      ? t("work.today.heading")
      : pick.day === todayISO
        ? t("work.today.heading")
        : t("work.today.nextUp", { day: agendaDayLabel(pick.day) });

  return (
    <section className="ws-card ws-today" aria-label={t("work.today.heading")} data-testid="ws-today">
      <div className="ws-row-between">
        <h2 className="ws-h2">
          <CalendarDays size={18} aria-hidden /> {heading}
        </h2>
        {pick.entries[0] && (
          <span className="ws-meta ws-updated">
            {t("work.today.updated", { time: formatUpdatedAt(pick.entries[0].updated_at, now) })}
          </span>
        )}
      </div>

      {reason && query.data != null && (
        <p className="ws-saved" role="status">
          {t("work.today.savedFrom", { time: formatUpdatedAt(new Date(query.dataUpdatedAt).toISOString(), now) })}
        </p>
      )}

      {query.data == null && (query.isError || (!online && query.isPending)) ? (
        <p className="ws-meta" role="status">{t("work.today.unreachable")}</p>
      ) : query.isPending && query.data == null ? (
        <p className="ws-meta">{t("crewStart.loading")}</p>
      ) : pick.entries.length === 0 ? (
        <p className="ws-meta">{t("work.today.none")}</p>
      ) : (
        pick.entries.map((a) => {
          const mates = crewmateNamesOn(a, meId);
          const truck = truckFor(a);
          const changed = assignmentChanged(a, now);
          const title =
            a.kind === "delivery"
              ? t("work.today.meetTruck", { label: a.delivery?.label ?? t("work.today.delivery") })
              : `${a.project?.job_code ? `${a.project.job_code} · ` : ""}${a.project?.name ?? t("mywork.jobToday")}`;
          return (
            <div key={a.id} className="ws-today-entry">
              <div className="ws-row-between">
                <Link
                  to={a.kind === "delivery" ? `/storage/d/${a.delivery_id}` : `/projects/${a.project_id}`}
                  className="ws-today-title"
                >
                  {title}
                </Link>
                {changed && <span className="ws-tag ws-tag--changed">{t("work.today.changed")}</span>}
              </div>
              {/* One dense line: start · crew · truck · updated. The 667px
                  screen has room for three cards only if each says its
                  facts in as few rows as it can. */}
              <p className="ws-meta ws-facts">
                <strong className="ws-today-start">
                  {a.start_time
                    ? t("work.today.starts", { time: formatScheduleTime(a.start_time, a.end_time) ?? "" })
                    : t("work.today.noTime")}
                </strong>
                {mates.length > 0 && (
                  <span className="ws-inline">
                    <Users size={16} aria-hidden /> {t("work.today.with", { names: mates.join(", ") })}
                  </span>
                )}
                {truck && (
                  <span className="ws-inline">
                    <Truck size={16} aria-hidden /> {t("work.today.truck", { truck })}
                  </span>
                )}
                {/* A second entry on the same day carries its own Updated;
                    the first's sits beside the heading. */}
                {a.id !== pick.entries[0]?.id && (
                  <span className="ws-inline ws-updated">{t("work.today.updated", { time: formatUpdatedAt(a.updated_at, now) })}</span>
                )}
              </p>
              {a.project?.address && (
                <div className="ws-row-between ws-address">
                  <span className="ws-meta ws-inline">
                    <MapPin size={16} aria-hidden /> {a.project.address}
                  </span>
                  <DirectionsButton address={a.project?.address} label={t("work.today.directions")} className="ws-btn ws-btn--ghost ws-btn--inline" />
                </div>
              )}
            </div>
          );
        })
      )}
    </section>
  );
}
