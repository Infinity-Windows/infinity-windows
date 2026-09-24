// The Schedule tab (crew redesign K1.6, the owner's own design, 2026-09-23):
// "make sure people can see their schedule as far out as needed, but only a
// week is needed upon opening."
//
// Opens on today + 7 days — the same window and the same query the Work
// screen's Today card reads, so the two never disagree and one cached copy
// serves both with no signal. "Show more" keeps loading further out, two
// weeks at a time, with no limit: as far as anything is published. Today's
// entry has Start work; every entry shows when it was last updated and a
// Changed tag when it moved after publishing.
//
// Offline it says "Showing your schedule from <time> — can't reach Forge"
// over the saved copy, and with no copy at all it says it cannot reach Forge.
// It NEVER says "no work" for a phone that simply has no signal. Foremen and
// above get a view-only Crew switch; editing stays in Scheduling.
//
// The classic My Schedule page is untouched apart from F2 (K-X2: old screens
// frozen, fixes only); this is the new design's own tab.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { CalendarClock, Clock, MapPin, Truck, Users } from "lucide-react";
import { useT } from "../../lib/i18n";
import "../../lib/i18n/workCatalog";
import { getMyProfile } from "../../lib/install/api";
import { isForemanPlus } from "../../lib/install/types";
import { savedCopyReason } from "../../lib/offline/useSavedCopy";
import { useConnection } from "../../lib/offline/useWeakSignal";
import { listAssignments, listMyPublished } from "../../lib/schedule/api";
import { addDaysISO, agendaDayLabel, formatScheduleTime } from "../../lib/schedule/dates";
import { buildAgenda } from "../../lib/schedule/grouping";
import type { ScheduleAssignment } from "../../lib/schedule/types";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { listVehicleLinksForAssignments } from "../../lib/vehicles/api";
import { vehicleTitle } from "../../lib/vehicles/display";
import { assignmentChanged, crewmateNamesOn, formatUpdatedAt } from "../../lib/work/today";
import { DirectionsButton } from "../../components/maps/DirectionsButton";
import { SCHEDULE_WINDOW_DAYS } from "./WorkScreen";
import "./work.css";

function todayLocalISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** How much further each "Show more" reaches. */
export const SHOW_MORE_DAYS = 14;

export function Schedule() {
  const t = useT();
  const today = todayLocalISO();
  const [days, setDays] = useState(SCHEDULE_WINDOW_DAYS);
  const to = addDaysISO(today, days);
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const myId = me.data?.id ?? null;
  const { effectiveRole } = useEffectiveRole();
  const lead = isForemanPlus(effectiveRole);
  const [view, setView] = useState<"mine" | "crew">("mine");
  const { online, weak } = useConnection();
  const now = Date.now();

  // The first window is the very key the Work screen's Today card holds, so
  // opening this tab off the Work screen costs no request and works offline.
  const mine = useQuery({
    queryKey: ["workSchedule", myId, today, to],
    queryFn: () => listMyPublished(myId!, today, to),
    enabled: Boolean(myId),
    refetchInterval: 60_000,
    refetchOnReconnect: "always",
  });
  const crew = useQuery({
    queryKey: ["scheduleAssignments", "published", today, to],
    queryFn: async () => (await listAssignments(today, to)).filter((a) => a.status === "published"),
    enabled: lead && view === "crew",
  });
  const active = view === "crew" ? crew : mine;
  // Memoised, not `?? []` inline: a fresh empty array every render would make
  // every memo below recompute on the one-second clock.
  const rows = useMemo<ScheduleAssignment[]>(() => active.data ?? [], [active.data]);
  const agenda = useMemo(() => buildAgenda(rows, today, to), [rows, today, to]);
  const ids = useMemo(() => rows.map((a) => a.id), [rows]);
  const vehicles = useQuery({
    queryKey: ["myScheduleVehicles", ids],
    queryFn: () => listVehicleLinksForAssignments(ids),
    enabled: ids.length > 0,
  });
  const truckFor = (a: ScheduleAssignment) => {
    const link = (vehicles.data ?? []).find((l) => l.assignment_id === a.id && l.vehicle);
    return link?.vehicle ? vehicleTitle(link.vehicle) : null;
  };

  const reason = savedCopyReason(active, online, weak);
  const noData = active.data == null;
  const unreachable = noData && (active.isError || (!online && active.isPending));

  return (
    <div className="page work-screen" data-testid="schedule-screen">
      <p className="ws-top">
        <strong>{t("nav.schedule")}</strong>
        {lead && (
          <span className="ws-chip-row" role="group" aria-label={t("work.lead.crew")}>
            <button
              type="button"
              className={`ws-chip${view === "mine" ? " ws-chip--on" : ""}`}
              aria-pressed={view === "mine"}
              onClick={() => setView("mine")}
            >
              {t("mySchedule.title")}
            </button>
            <button
              type="button"
              className={`ws-chip${view === "crew" ? " ws-chip--on" : ""}`}
              aria-pressed={view === "crew"}
              onClick={() => setView("crew")}
              data-testid="schedule-crew"
            >
              {t("work.lead.crew")}
            </button>
          </span>
        )}
      </p>
      {view === "crew" && (
        <p className="ws-meta">
          <Link to="/scheduling" className="ws-link" style={{ padding: 0 }}>
            {t("work.schedule.editInScheduling")} ›
          </Link>
        </p>
      )}

      {reason && !noData && (
        <p className="ws-saved" role="status" data-testid="schedule-saved">
          {t("work.today.savedFrom", { time: formatUpdatedAt(new Date(active.dataUpdatedAt).toISOString(), now) })}
        </p>
      )}

      {unreachable ? (
        <section className="ws-card">
          <p className="ws-meta" role="status" data-testid="schedule-unreachable">{t("work.today.unreachable")}</p>
        </section>
      ) : noData && active.isPending ? (
        <section className="ws-card">
          <p className="ws-meta">{t("crewStart.loading")}</p>
        </section>
      ) : agenda.length === 0 ? (
        <section className="ws-card">
          <p className="ws-meta" data-testid="schedule-empty">
            {t("work.schedule.nothingThrough", { day: agendaDayLabel(to) })}
          </p>
        </section>
      ) : (
        agenda.map((day) => (
          <section key={day.day} className={`ws-card${day.day === today ? " ws-today" : ""}`} aria-label={agendaDayLabel(day.day)}>
            <h2 className="ws-h2">
              <CalendarClock size={18} aria-hidden />
              {day.day === today ? `${t("mySchedule.todayPrefix")}` : ""}
              {agendaDayLabel(day.day)}
            </h2>
            {day.entries.map((entry) => {
              const a = entry.assignment;
              const mates = myId ? crewmateNamesOn(a, myId) : [];
              const names = view === "crew" ? a.members.map((m) => m.display_name).filter(Boolean) : mates;
              const truck = truckFor(a);
              const changed = assignmentChanged(a, now);
              const title =
                a.kind === "delivery"
                  ? t("work.today.meetTruck", { label: a.delivery?.label ?? t("work.today.delivery") })
                  : `${a.project?.job_code ? `${a.project.job_code} · ` : ""}${a.project?.name ?? t("mywork.jobToday")}`;
              return (
                <div key={`${a.id}-${entry.day}`} className="ws-today-entry" data-testid="schedule-entry">
                  <div className="ws-row-between">
                    <Link
                      to={a.kind === "delivery" ? `/storage/d/${a.delivery_id}` : `/projects/${a.project_id}`}
                      className="ws-today-title"
                    >
                      {title}
                    </Link>
                    {changed && <span className="ws-tag ws-tag--changed">{t("work.today.changed")}</span>}
                  </div>
                  <p className="ws-today-start">
                    <Clock size={16} aria-hidden />{" "}
                    {a.start_time
                      ? t("work.today.starts", { time: formatScheduleTime(a.start_time, a.end_time) ?? "" })
                      : t("work.today.noTime")}
                    {!entry.isFirstDay ? ` · ${t("mySchedule.cont")}` : ""}
                  </p>
                  {a.project?.address && (
                    <p className="ws-meta ws-inline">
                      <MapPin size={16} aria-hidden /> {a.project.address}
                    </p>
                  )}
                  {(names.length > 0 || truck) && (
                    <p className="ws-meta ws-inline">
                      {names.length > 0 && (
                        <span className="ws-inline">
                          <Users size={16} aria-hidden /> {t("work.today.with", { names: names.join(", ") })}
                        </span>
                      )}
                      {truck && (
                        <span className="ws-inline">
                          <Truck size={16} aria-hidden /> {t("work.today.truck", { truck })}
                        </span>
                      )}
                    </p>
                  )}
                  <div className="ws-row-between">
                    <DirectionsButton address={a.project?.address} label={t("work.today.directions")} className="ws-btn ws-btn--ghost ws-btn--inline" />
                    <span className="ws-meta ws-updated">{t("work.today.updated", { time: formatUpdatedAt(a.updated_at, now) })}</span>
                  </div>
                  {view === "mine" && day.day === today && entry.isFirstDay && (
                    <Link to="/" className="ws-btn ws-btn--primary" data-testid="schedule-start-work">
                      {t("mySchedule.startWork")}
                    </Link>
                  )}
                </div>
              );
            })}
          </section>
        ))
      )}

      {!unreachable && (
        <button
          type="button"
          className="ws-btn"
          onClick={() => setDays((d) => d + SHOW_MORE_DAYS)}
          data-testid="schedule-more"
        >
          {t("work.schedule.showMore", { day: agendaDayLabel(addDaysISO(today, days + SHOW_MORE_DAYS)) })}
        </button>
      )}
    </div>
  );
}
