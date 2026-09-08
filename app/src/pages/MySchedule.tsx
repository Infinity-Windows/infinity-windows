import { myPlanTripLinks } from "../lib/workflow/api";
import { BackChip } from "../components/BackChip";
import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { CalendarClock, Clock, MapPin, Plane, Truck, Users } from "lucide-react";
import { getMyProfile } from "../lib/install/api";
import { EmptyState, QueryError, SkeletonList } from "../components/ui/States";
import { addDaysISO, agendaDayLabel, formatScheduleTime } from "../lib/schedule/dates";
import { buildAgenda, crewmateNames } from "../lib/schedule/grouping";
import { assignmentColor } from "../lib/schedule/color";
import { listMyPublished } from "../lib/schedule/api";
import { listVehicleLinksForAssignments } from "../lib/vehicles/api";
import { vehicleTitle } from "../lib/vehicles/display";
import { listTrips } from "../lib/travel/api";
import { visibleTrips } from "../lib/travel/visibility";
import { isSupervisorPlus } from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import { DirectionsButton } from "../components/maps/DirectionsButton";
import { useT } from "../lib/i18n";

function todayLocalISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function MySchedule() {
  const t = useT();
  const today = todayLocalISO();
  const [weeks, setWeeks] = useState(6);
  const to = addDaysISO(today, weeks * 7);

  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const myId = me.data?.id;

  const schedule = useQuery({
    queryKey: ["mySchedule", myId, today, to],
    queryFn: () => listMyPublished(myId!, today, to),
    enabled: Boolean(myId),
  });

  const agenda = useMemo(
    () => (schedule.data ? buildAgenda(schedule.data, today, to) : []),
    [schedule.data, today, to],
  );

  const assignmentIds = useMemo(
    () => (schedule.data ?? []).map((a) => a.id),
    [schedule.data],
  );
  const vehicleLinks = useQuery({
    queryKey: ["myScheduleVehicles", assignmentIds],
    queryFn: () => listVehicleLinksForAssignments(assignmentIds),
    enabled: assignmentIds.length > 0,
  });
  const connectedTrips = useQuery({ queryKey: ["workflowMyTrips", myId], queryFn: myPlanTripLinks, enabled: Boolean(myId) });
  const trips = useQuery({ queryKey: ["trips"], queryFn: listTrips });
  const { effectiveRole } = useEffectiveRole();
  const viewer = useMemo(
    () => ({ profileId: me.data?.id ?? null, isSupervisor: isSupervisorPlus(effectiveRole) }),
    [me.data?.id, effectiveRole],
  );

  const vehicleByAssignment = useMemo(() => {
    const map = new Map<string, string>();
    for (const l of vehicleLinks.data ?? []) {
      if (l.assignment_id && l.vehicle) map.set(l.assignment_id, vehicleTitle(l.vehicle));
    }
    return map;
  }, [vehicleLinks.data]);

  const tripByProject = useMemo(() => {
    const map = new Map<string, { id: string; label: string }>();
    // Published only, for crew: the Travel tab already hides drafts, and a
    // schedule badge naming an unannounced destination leaks the same thing
    // one line at a time.
    for (const t of visibleTrips(trips.data ?? [], viewer)) {
      if (t.project_id) map.set(t.project_id, { id: t.id, label: t.destination || t.name });
    }
    return map;
  }, [trips.data, viewer]);

  return (
    <div className="page sched-mine">
      <header className="page-header">
        <div>
          <h1>{t("mySchedule.title")}</h1>
          <p className="muted" style={{ margin: 0 }}>
            {t("mySchedule.subtitle")}
          </p>
        </div>
        <BackChip fallback="/" label={t("mySchedule.home")} />
      </header>

      {connectedTrips.error && <QueryError error={connectedTrips.error} onRetry={() => void connectedTrips.refetch()} label={t("workflow.tripLinksError")} />}
      {schedule.isError && (
        <QueryError
          error={schedule.error}
          onRetry={() => void schedule.refetch()}
          label={t("mySchedule.loadError")}
        />
      )}
      {schedule.isLoading || me.isLoading ? (
        <SkeletonList rows={4} />
      ) : agenda.length === 0 ? (
        <EmptyState
          icon={<CalendarClock size={22} />}
          title={t("mySchedule.emptyTitle")}
          message={t("mySchedule.emptyMessage")}
        />
      ) : (
        <div className="sched-agenda">
          {agenda.map((day) => (
            <section key={day.day} className={`sched-agenda-day${day.day === today ? " is-today" : ""}`}>
              <h2 className="sched-agenda-date">
                {day.day === today ? t("mySchedule.todayPrefix") : ""}
                {agendaDayLabel(day.day)}
              </h2>
              {day.entries.map((entry) => {
                const a = entry.assignment;
                const mates = myId ? crewmateNames(a, myId) : [];
                const isToday = day.day === today && entry.isFirstDay;
                return (
                  <Fragment key={`${a.id}-${entry.day}`}>
                  <Link
                    to={
                      a.kind === "delivery"
                        ? `/storage/d/${a.delivery_id}`
                        : `/projects/${a.project_id}?tab=map`
                    }
                    className="sched-agenda-card"
                    style={{ borderLeftColor: assignmentColor(a) }}
                  >
                    <div className="sched-agenda-main">
                      <strong>
                        {a.kind === "delivery"
                          ? t("mySchedule.meetTruck", { label: a.delivery?.label ?? t("mySchedule.deliveryFallback") })
                          : (a.project?.name ?? a.project?.job_code ?? t("mySchedule.jobFallback"))}
                      </strong>
                      {a.project?.address && (
                        <span className="sched-agenda-addr">
                          <MapPin size={13} aria-hidden /> {a.project.address}
                        </span>
                      )}
                      {/* The whole card is a Link to the job page, so an installer who
                          only wants directions had to open the job first to find them.
                          DirectionsButton already swallows its click (preventDefault +
                          stopPropagation) so tapping it here can't also trigger the
                          card's navigation. */}
                      <DirectionsButton address={a.project?.address} />
                      {mates.length > 0 && (
                        <span className="sched-agenda-crew">
                          <Users size={13} aria-hidden /> {t("mySchedule.withCrew", { names: mates.join(", ") })}
                        </span>
                      )}
                      {vehicleByAssignment.get(a.id) && (
                        <span className="sched-agenda-crew">
                          <Truck size={13} aria-hidden /> {vehicleByAssignment.get(a.id)}
                        </span>
                      )}
                      {!connectedTrips.data?.some(l => l.assignment_id === a.id) && a.project_id && tripByProject.get(a.project_id) && (
                        <span className="sched-agenda-crew">
                          <Plane size={13} aria-hidden />{" "}
                          {t("mySchedule.travelLabel", { label: tripByProject.get(a.project_id)!.label })}
                        </span>
                      )}
                    </div>
                    <div className="sched-agenda-meta">
                      {a.start_time && (
                        <span className="sched-agenda-time">
                          <Clock size={13} aria-hidden /> {formatScheduleTime(a.start_time, a.end_time)}
                        </span>
                      )}
                      {!entry.isFirstDay && (
                        <span className="muted" style={{ fontSize: 11 }}>
                          {t("mySchedule.cont")}
                        </span>
                      )}
                    </div>
                  </Link>
                  {(connectedTrips.data ?? []).filter(l => l.assignment_id === a.id).map(l => <Link key={l.trip_id} to={`/travel/${l.trip_id}`} className="button-like workflow-trip-link"><Plane size={16} aria-hidden />{l.name} · {l.start_date} – {l.end_date}</Link>)}
                  {isToday && (
                    <Link to="/" className="button-like sched-start-work">
                      {t("mySchedule.startWork")}
                    </Link>
                  )}
                  </Fragment>
                );
              })}
            </section>
          ))}
          <button className="button-like" style={{ marginTop: 12 }} onClick={() => setWeeks((w) => w + 6)}>
            {t("mySchedule.showMore")}
          </button>
        </div>
      )}
    </div>
  );
}
