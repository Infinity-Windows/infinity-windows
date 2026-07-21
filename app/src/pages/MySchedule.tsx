import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { CalendarClock, Clock, MapPin, Users } from "lucide-react";
import { getMyProfile } from "../lib/install/api";
import { EmptyState, QueryError, SkeletonList } from "../components/ui/States";
import { addDaysISO, agendaDayLabel, formatStartTime } from "../lib/schedule/dates";
import { buildAgenda, crewmateNames } from "../lib/schedule/grouping";
import { assignmentColor } from "../lib/schedule/color";
import { listMyPublished } from "../lib/schedule/api";

function todayLocalISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function MySchedule() {
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

  return (
    <div className="page sched-mine">
      <header className="page-header">
        <div>
          <h1>My Schedule</h1>
          <p className="muted" style={{ margin: 0 }}>
            Your published jobs, day by day.
          </p>
        </div>
        <Link to="/" className="back-chip" aria-label="Home" />
      </header>

      {schedule.isError && (
        <QueryError
          error={schedule.error}
          onRetry={() => void schedule.refetch()}
          label="Couldn't load your schedule"
        />
      )}
      {schedule.isLoading || me.isLoading ? (
        <SkeletonList rows={4} />
      ) : agenda.length === 0 ? (
        <EmptyState
          icon={<CalendarClock size={22} />}
          title="Nothing scheduled yet"
          message="When your crew lead publishes a schedule, your jobs show up here."
        />
      ) : (
        <div className="sched-agenda">
          {agenda.map((day) => (
            <section key={day.day} className={`sched-agenda-day${day.day === today ? " is-today" : ""}`}>
              <h2 className="sched-agenda-date">
                {day.day === today ? "Today · " : ""}
                {agendaDayLabel(day.day)}
              </h2>
              {day.entries.map((entry) => {
                const a = entry.assignment;
                const mates = myId ? crewmateNames(a, myId) : [];
                return (
                  <Link
                    key={`${a.id}-${entry.day}`}
                    to={`/projects/${a.project_id}?tab=map`}
                    className="sched-agenda-card"
                    style={{ borderLeftColor: assignmentColor(a) }}
                  >
                    <div className="sched-agenda-main">
                      <strong>{a.project?.name ?? a.project?.job_code ?? "Job"}</strong>
                      {a.project?.address && (
                        <span className="sched-agenda-addr">
                          <MapPin size={13} aria-hidden /> {a.project.address}
                        </span>
                      )}
                      {mates.length > 0 && (
                        <span className="sched-agenda-crew">
                          <Users size={13} aria-hidden /> with {mates.join(", ")}
                        </span>
                      )}
                    </div>
                    <div className="sched-agenda-meta">
                      {a.start_time && (
                        <span className="sched-agenda-time">
                          <Clock size={13} aria-hidden /> {formatStartTime(a.start_time)}
                        </span>
                      )}
                      {!entry.isFirstDay && <span className="muted" style={{ fontSize: 11 }}>cont.</span>}
                    </div>
                  </Link>
                );
              })}
            </section>
          ))}
          <button className="button-like" style={{ marginTop: 12 }} onClick={() => setWeeks((w) => w + 6)}>
            Show more
          </button>
        </div>
      )}
    </div>
  );
}
