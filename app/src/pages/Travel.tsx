import { BackChip } from "../components/BackChip";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { CalendarDays, MapPin, Plane, Plus, Users } from "lucide-react";
import { getMyProfile } from "../lib/install/api";
import { isSupervisorPlus } from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import { EmptyState, QueryError, SkeletonList } from "../components/ui/States";
import { listTrips } from "../lib/travel/api";
import { sortTripsForList, visibleTrips } from "../lib/travel/visibility";
import { phaseLabel, tripPhase } from "../lib/travel/status";
import { TripEditor } from "../components/travel/TripEditor";
import { useT, type TFn } from "../lib/i18n";

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

function syncedLabel(ms: number, t: TFn): string {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins <= 0) return t("travel.syncedJustNow");
  if (mins < 60) return t("travel.syncedMinAgo", { mins });
  const hrs = Math.round(mins / 60);
  return t("travel.syncedHrAgo", { hrs });
}

export function Travel() {
  const t = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const today = todayLocalISO();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const { effectiveRole: role } = useEffectiveRole();
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
          <h1>{t("travel.title")}</h1>
          <p className="muted" style={{ margin: 0 }}>
            {isSupervisor ? t("travel.subtitleCrew") : t("travel.subtitleMine")}
          </p>
        </div>
        <BackChip fallback="/" label={t("travel.home")} />
      </header>

      <div className="travel-toolbar">
        {trips.data && (
          <span className="muted travel-synced" aria-live="polite">
            {syncedLabel(trips.dataUpdatedAt, t)}
            {!navigator.onLine ? t("travel.offlineSuffix") : ""}
          </span>
        )}
        {isSupervisor && (
          <button className="button-like active-pill travel-new" onClick={() => setEditing(true)}>
            <Plus size={16} aria-hidden /> {t("travel.newTrip")}
          </button>
        )}
      </div>

      {trips.isError && (
        <QueryError error={trips.error} onRetry={() => void trips.refetch()} label={t("travel.loadError")} />
      )}
      {trips.isLoading ? (
        <SkeletonList rows={3} />
      ) : list.length === 0 ? (
        <EmptyState
          icon={<Plane size={22} />}
          title={t("travel.emptyTitle")}
          message={isSupervisor ? t("travel.emptyMessageSup") : t("travel.emptyMessageMine")}
        />
      ) : (
        <div className="travel-list">
          {list.map((trip) => {
            const phase = tripPhase(trip.start_date, trip.end_date, today);
            return (
              <button
                key={trip.id}
                className="travel-list-card"
                onClick={() => navigate(`/travel/${trip.id}`)}
              >
                <div className="travel-list-main">
                  <div className="travel-list-titlerow">
                    <strong>{trip.destination || trip.name}</strong>
                    <span className={`travel-chip travel-chip-${phase}`}>{phaseLabel(phase, t)}</span>
                    {isSupervisor && trip.status === "draft" && (
                      <span className="travel-chip travel-chip-draft">{t("travel.draft")}</span>
                    )}
                  </div>
                  {trip.destination && trip.name !== trip.destination && (
                    <span className="muted travel-list-sub">{trip.name}</span>
                  )}
                  <span className="travel-list-meta">
                    <CalendarDays size={13} aria-hidden /> {dateRangeLabel(trip.start_date, trip.end_date)}
                  </span>
                  <span className="travel-list-meta">
                    <Users size={13} aria-hidden /> {t("travel.crewCount", { n: trip.crew.length })}
                    {trip.project?.job_code && (
                      <>
                        {" · "}
                        <MapPin size={13} aria-hidden /> {trip.project.job_code}
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
