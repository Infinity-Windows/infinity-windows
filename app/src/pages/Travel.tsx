import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { CalendarDays, MapPin, Plane, Plus, Users } from "lucide-react";
import { getMyProfile } from "../lib/install/api";
import { isSupervisorPlus } from "../lib/install/types";
import { effectiveRole, useViewAsRole } from "../lib/viewAsRoleContext";
import { EmptyState, QueryError, SkeletonList } from "../components/ui/States";
import { listTrips } from "../lib/travel/api";
import { sortTripsForList, visibleTrips } from "../lib/travel/visibility";
import { phaseLabel, tripPhase } from "../lib/travel/status";
import { TripEditor } from "../components/travel/TripEditor";

function todayLocalISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dateRangeLabel(from: string, to: string): string {
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: "UTC" };
  const f = new Date(`${from}T00:00:00Z`).toLocaleDateString(undefined, opts);
  const t = new Date(`${to}T00:00:00Z`).toLocaleDateString(undefined, {
    ...opts,
    year: "numeric",
  });
  return `${f} – ${t}`;
}

function syncedLabel(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins <= 0) return "Synced just now";
  if (mins < 60) return `Last synced ${mins} min ago`;
  const hrs = Math.round(mins / 60);
  return `Last synced ${hrs} hr ago`;
}

export function Travel() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const today = todayLocalISO();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const view = useViewAsRole();
  const role = effectiveRole(me.data?.role, view);
  const isSupervisor = isSupervisorPlus(role);

  const trips = useQuery({ queryKey: ["trips"], queryFn: listTrips });
  const [editing, setEditing] = useState(false);

  const list = useMemo(() => {
    const all = trips.data ?? [];
    const visible = visibleTrips(all, { profileId: me.data?.id, isSupervisor });
    return sortTripsForList(visible, today);
  }, [trips.data, me.data?.id, isSupervisor, today]);

  return (
    <div className="page travel-page">
      <header className="page-header">
        <div>
          <h1>Travel Info</h1>
          <p className="muted" style={{ margin: 0 }}>
            {isSupervisor ? "Trips for the crew — flights, lodging, and more." : "Your trips — flights, lodging, and more."}
          </p>
        </div>
        <Link to="/" className="back-chip" aria-label="Home" />
      </header>

      <div className="travel-toolbar">
        {trips.data && (
          <span className="muted travel-synced" aria-live="polite">
            {syncedLabel(trips.dataUpdatedAt)}
            {!navigator.onLine ? " · offline" : ""}
          </span>
        )}
        {isSupervisor && (
          <button className="button-like active-pill travel-new" onClick={() => setEditing(true)}>
            <Plus size={16} aria-hidden /> New trip
          </button>
        )}
      </div>

      {trips.isError && (
        <QueryError error={trips.error} onRetry={() => void trips.refetch()} label="Couldn't load trips" />
      )}
      {trips.isLoading ? (
        <SkeletonList rows={3} />
      ) : list.length === 0 ? (
        <EmptyState
          icon={<Plane size={22} />}
          title="No trips yet"
          message={isSupervisor ? "Tap “New trip” to plan crew travel." : "When you're assigned to a trip, it shows up here."}
        />
      ) : (
        <div className="travel-list">
          {list.map((t) => {
            const phase = tripPhase(t.start_date, t.end_date, today);
            return (
              <button
                key={t.id}
                className="travel-list-card"
                onClick={() => navigate(`/travel/${t.id}`)}
              >
                <div className="travel-list-main">
                  <div className="travel-list-titlerow">
                    <strong>{t.destination || t.name}</strong>
                    <span className={`travel-chip travel-chip-${phase}`}>{phaseLabel(phase)}</span>
                    {isSupervisor && t.status === "draft" && (
                      <span className="travel-chip travel-chip-draft">Draft</span>
                    )}
                  </div>
                  {t.destination && t.name !== t.destination && (
                    <span className="muted travel-list-sub">{t.name}</span>
                  )}
                  <span className="travel-list-meta">
                    <CalendarDays size={13} aria-hidden /> {dateRangeLabel(t.start_date, t.end_date)}
                  </span>
                  <span className="travel-list-meta">
                    <Users size={13} aria-hidden /> {t.crew.length} crew
                    {t.project?.job_code && (
                      <>
                        {" · "}
                        <MapPin size={13} aria-hidden /> {t.project.job_code}
                      </>
                    )}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {editing && (
        <TripEditor
          trip={null}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setEditing(false);
            qc.invalidateQueries({ queryKey: ["trips"] });
            navigate(`/travel/${saved.id}`);
          }}
          onDeleted={() => setEditing(false)}
        />
      )}
    </div>
  );
}
