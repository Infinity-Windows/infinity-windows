import { Link } from "react-router-dom";
import { MapPin, User } from "lucide-react";
import type { VehicleWithMeta } from "../../lib/vehicles/types";
import { vehicleSubtitle, vehicleTitle, usageLabel } from "../../lib/vehicles/display";
import { driverSummary } from "../../lib/vehicles/drivers";
import { serviceBadge } from "../../lib/vehicles/service";
import { LOCATION_STATUS_LABELS, lastSeenLabel, locationStatus } from "../../lib/vehicles/location";
import { KindIcon } from "./KindIcon";

/** CSS color for a named vehicle color; falls back to a neutral swatch. */
function colorSwatch(color: string | null): string | undefined {
  if (!color) return undefined;
  const c = color.trim().toLowerCase();
  const known: Record<string, string> = {
    white: "#e8e8ea",
    black: "#1c1c1e",
    silver: "#c7c9cc",
    grey: "#8b8d91",
    gray: "#8b8d91",
    red: "#d64545",
    blue: "#3b6fd6",
    green: "#3aa35a",
    orange: "#f15b00",
    yellow: "#e0b400",
  };
  return known[c] ?? (CSS.supports?.("color", c) ? c : undefined);
}

export function VehicleCard({ vehicle, todayISO, nowMs }: { vehicle: VehicleWithMeta; todayISO: string; nowMs: number }) {
  const badge = serviceBadge({
    todayISO,
    nextServiceDate: vehicle.next_service_date,
    odometer: vehicle.odometer,
  });
  const usage = usageLabel(vehicle);
  const swatch = colorSwatch(vehicle.color);
  const status = locationStatus(vehicle.location?.recorded_at, nowMs);

  return (
    <Link to={`/vehicles/${vehicle.id}`} className="veh-card">
      <div className="veh-card-top">
        <span className="veh-card-icon">
          <KindIcon kind={vehicle.kind} />
        </span>
        <div className="veh-card-heading">
          <div className="veh-card-title-row">
            {swatch && <span className="veh-color-dot" style={{ background: swatch }} aria-hidden />}
            <span className="veh-card-title">{vehicleTitle(vehicle)}</span>
          </div>
          <span className="veh-card-subtitle muted">{vehicleSubtitle(vehicle)}</span>
        </div>
        {badge && <span className={`veh-badge veh-badge-${badge.tone}`}>{badge.label}</span>}
      </div>

      <div className="veh-card-meta">
        <span className="veh-meta-item">
          <User size={13} aria-hidden /> {driverSummary(vehicle.drivers)}
        </span>
        {usage && <span className="veh-meta-item">{usage}</span>}
        <span className={`veh-loc-chip veh-loc-${status}`} title={lastSeenLabel(vehicle.location?.recorded_at, nowMs)}>
          <MapPin size={12} aria-hidden />
          {status === "none" ? "No location" : `${LOCATION_STATUS_LABELS[status]} · ${lastSeenLabel(vehicle.location?.recorded_at, nowMs)}`}
        </span>
      </div>
    </Link>
  );
}
