import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Car, Download, Lock, RefreshCw } from "lucide-react";
import { EmptyState, QueryError, SkeletonList } from "../ui/States";
import { listDriveSessions, recomputeDriveSessionsFromHistory } from "../../lib/vehicles/api";
import {
  availableYears,
  filterSessionsByYear,
} from "../../lib/vehicles/driveDetection";
import { businessTotals, personalTotals } from "../../lib/vehicles/driveClassification";
import { buildDriveLogCsv, type DriveLogRow } from "../../lib/vehicles/driveLog";
import { driverDisplayName } from "../../lib/vehicles/drivers";
import { locationStatus } from "../../lib/vehicles/location";
import { vehicleTitle } from "../../lib/vehicles/display";
import { toastError, toastSuccess } from "../../lib/toast";
import type { VehicleWithMeta } from "../../lib/vehicles/types";

// Movement must have been recent enough (and fast enough) for the truck to
// count as "currently driving" — mirrors the drive detector's thresholds.
const LIVE_DRIVING_MPH = 5;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function localDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function localTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** "1h 05m" / "45m" / "0m" — compact duration for the table. */
function durationLabel(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${pad2(m)}m` : `${m}m`;
}

/** H:MM:SS for the live "currently driving" timer. */
function clockLabel(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${pad2(m)}:${pad2(s % 60)}`;
}

function csvDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 3600)}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}

function downloadText(text: string, filename: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * Owner/supervisor-only driving log (this is tax/financial data — the caller in
 * VehicleDetail mounts it only when `canSeeDriveLog` is true, same faithful
 * preview rule as financials). Shows a live "currently driving" timer, a year
 * total that counts BUSINESS (clocked-in) miles only, a per-drive table tagged
 * business/personal, and a CSV export.
 */
export function DrivingLogSection({ vehicle }: { vehicle: VehicleWithMeta }) {
  const qc = useQueryClient();
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const sessions = useQuery({
    queryKey: ["vehicleDriveSessions", vehicle.id],
    queryFn: () => listDriveSessions(vehicle.id),
  });

  // Best-effort: derive drives from whatever GPS history exists. Harmless when
  // there's no feed yet (empty log) and idempotent, so it just refreshes the
  // moment a tracker starts pushing fixes.
  const recompute = useMutation({
    mutationFn: () => recomputeDriveSessionsFromHistory(vehicle.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vehicleDriveSessions", vehicle.id] });
    },
  });

  useEffect(() => {
    recompute.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicle.id]);

  const all = useMemo(() => sessions.data ?? [], [sessions.data]);
  const years = useMemo(() => {
    const ys = availableYears(all);
    return ys.includes(thisYear) ? ys : [thisYear, ...ys];
  }, [all, thisYear]);

  useEffect(() => {
    if (!years.includes(year)) setYear(years[0] ?? thisYear);
  }, [years, year, thisYear]);

  const yearSessions = useMemo(() => filterSessionsByYear(all, year), [all, year]);
  const business = businessTotals(yearSessions);
  const personal = personalTotals(yearSessions);

  const driverName = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of vehicle.drivers) {
      if (d.profile_id) map.set(d.profile_id, driverDisplayName(d));
    }
    return (id: string | null) => (id ? map.get(id) ?? "Driver" : "Unknown driver");
  }, [vehicle.drivers]);

  const liveDrive = liveDriving(vehicle, nowMs);

  // Tick the "currently driving" timer once a second while a live drive shows.
  const isLiveDriving = liveDrive != null;
  useEffect(() => {
    if (!isLiveDriving) return;
    const t = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [isLiveDriving]);

  function exportCsv() {
    if (yearSessions.length === 0) {
      toastError(null, "No drives to export for this year yet.");
      return;
    }
    const rows: DriveLogRow[] = yearSessions.map((s) => ({
      day: localDay(s.started_at),
      start: localTime(s.started_at),
      end: localTime(s.ended_at),
      duration: csvDuration(s.duration_seconds),
      distance_miles: s.distance_miles,
      duration_seconds: s.duration_seconds,
      business: s.business,
      driver: driverName(s.driver_id),
    }));
    downloadText(
      buildDriveLogCsv({ vehicleLabel: vehicleTitle(vehicle), year, rows }),
      `driving-log-${year}.csv`,
      "text/csv;charset=utf-8",
    );
    toastSuccess("Driving log exported");
  }

  return (
    <section className="veh-section veh-drivelog">
      <div className="veh-section-head">
        <h2>Driving log</h2>
        <span className="veh-owner-lock">
          <Lock size={12} aria-hidden /> Owner / supervisor
        </span>
      </div>

      <p className="muted veh-drivelog-intro">
        Automatic mileage from the truck's GPS. A drive counts toward the year-end
        write-off only when the driver was clocked in — everything else is tagged
        personal and left out of the total.
      </p>

      {liveDrive && (
        <div className="veh-drivelog-live" role="status">
          <span className="veh-drivelog-live-dot" aria-hidden />
          <span>Currently driving</span>
          <strong className="veh-drivelog-live-clock">{clockLabel(liveDrive)}</strong>
        </div>
      )}

      <div className="veh-drivelog-controls">
        <label className="field-label" htmlFor="drivelog-year">Year</label>
        <select
          id="drivelog-year"
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
        >
          {years.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
        <button
          className="button-like"
          onClick={() => recompute.mutate()}
          disabled={recompute.isPending}
          aria-label="Update log from GPS"
        >
          <RefreshCw size={14} aria-hidden /> {recompute.isPending ? "Updating…" : "Update"}
        </button>
        <button
          className="button-like active-pill"
          style={{ marginLeft: "auto" }}
          onClick={exportCsv}
        >
          <Download size={14} aria-hidden /> Export CSV
        </button>
      </div>

      <div className="veh-drivelog-totals">
        <div className="veh-drivelog-total is-writeoff">
          <span className="veh-drivelog-total-label">Business write-off · {year}</span>
          <span className="veh-drivelog-total-value">
            {business.miles.toLocaleString(undefined, { maximumFractionDigits: 1 })} mi
          </span>
          <span className="muted">{business.hours.toLocaleString(undefined, { maximumFractionDigits: 1 })} hrs driving</span>
        </div>
        <div className="veh-drivelog-total">
          <span className="veh-drivelog-total-label">Personal (not counted)</span>
          <span className="veh-drivelog-total-value">
            {personal.miles.toLocaleString(undefined, { maximumFractionDigits: 1 })} mi
          </span>
          <span className="muted">{personal.hours.toLocaleString(undefined, { maximumFractionDigits: 1 })} hrs</span>
        </div>
      </div>

      {sessions.isError ? (
        <QueryError error={sessions.error} onRetry={() => void sessions.refetch()} label="Couldn't load the driving log" />
      ) : sessions.isLoading ? (
        <SkeletonList rows={3} />
      ) : yearSessions.length === 0 ? (
        <EmptyState
          icon={<Car size={20} />}
          title="No drives logged yet"
          message="Drives appear here automatically once a GPS tracker is connected and the truck starts moving."
        />
      ) : (
        <table className="veh-drivelog-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Time</th>
              <th className="veh-drivelog-num">Duration</th>
              <th className="veh-drivelog-num">Miles</th>
              <th>Type</th>
            </tr>
          </thead>
          <tbody>
            {yearSessions.map((s) => (
              <tr key={s.id}>
                <td>{localDay(s.started_at)}</td>
                <td className="muted">{localTime(s.started_at)}–{localTime(s.ended_at)}</td>
                <td className="veh-drivelog-num">{durationLabel(s.duration_seconds)}</td>
                <td className="veh-drivelog-num">{s.distance_miles.toLocaleString(undefined, { maximumFractionDigits: 1 })}</td>
                <td>
                  <span className={`veh-drivelog-tag ${s.business ? "is-business" : "is-personal"}`}>
                    {s.business ? "Business" : "Personal"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * Seconds the truck has been "currently driving", or null when it isn't. Uses
 * the latest location: live (recent) + a reported speed over the moving
 * threshold. Counts up from when that fix was recorded. Stays null under the
 * GPS stub (no live feed), which is the graceful default.
 */
function liveDriving(vehicle: VehicleWithMeta, nowMs: number): number | null {
  const loc = vehicle.location;
  if (!loc) return null;
  if (locationStatus(loc.recorded_at, nowMs) !== "live") return null;
  if (loc.speed_mph == null || loc.speed_mph < LIVE_DRIVING_MPH) return null;
  const started = Date.parse(loc.recorded_at);
  if (!Number.isFinite(started)) return null;
  return Math.max(0, Math.floor((nowMs - started) / 1000));
}
