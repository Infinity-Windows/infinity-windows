import { BackChip } from "../components/BackChip";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Radio } from "lucide-react";
import { QueryError, SkeletonCard } from "../components/ui/States";
import { ClientFleetMap, type MapPoint } from "../components/vehicles/ClientFleetMap";
import { listVehicles } from "../lib/vehicles/api";
import { lastSeenLabel, locationStatus } from "../lib/vehicles/location";
import { vehicleTitle } from "../lib/vehicles/display";

export function FleetMap() {
  const nowMs = Date.now();
  const vehicles = useQuery({ queryKey: ["vehicles"], queryFn: listVehicles });

  const points = useMemo<MapPoint[]>(() => {
    return (vehicles.data ?? [])
      .filter((v) => v.location)
      .map((v) => ({
        id: v.id,
        lat: v.location!.lat,
        lng: v.location!.lng,
        title: vehicleTitle(v),
        status: locationStatus(v.location!.recorded_at, nowMs),
        lastSeen: lastSeenLabel(v.location!.recorded_at, nowMs),
      }));
  }, [vehicles.data, nowMs]);

  const withoutLocation = (vehicles.data ?? []).length - points.length;

  return (
    <div className="page veh-page veh-map-page">
      <header className="page-header">
        <div>
          <h1>Fleet map</h1>
          <p className="muted" style={{ margin: 0 }}>
            Where each vehicle was last seen.
          </p>
        </div>
        <BackChip fallback="/vehicles" label="Back" />
      </header>

      {vehicles.isError ? (
        <QueryError error={vehicles.error} onRetry={() => void vehicles.refetch()} label="Couldn't load the map" />
      ) : vehicles.isLoading ? (
        <SkeletonCard height={420} />
      ) : (
        <>
          <ClientFleetMap points={points} />

          <div className="veh-map-legend" aria-label="Map legend">
            <span className="veh-legend-item"><span className="veh-map-dot veh-map-dot-live" /> Live (&lt;2 min)</span>
            <span className="veh-legend-item"><span className="veh-map-dot veh-map-dot-recent" /> Recent (&lt;30 min)</span>
            <span className="veh-legend-item"><span className="veh-map-dot veh-map-dot-stale" /> Offline</span>
          </div>

          {points.length === 0 && (
            <p className="muted" style={{ marginTop: 10 }}>
              No vehicle locations yet. Open a vehicle and use “Update location” to drop it on the
              map.
            </p>
          )}
          {withoutLocation > 0 && points.length > 0 && (
            <p className="muted" style={{ marginTop: 10 }}>
              {withoutLocation} vehicle{withoutLocation === 1 ? "" : "s"} without a location yet.
            </p>
          )}

          <div className="veh-tracker-note">
            <Radio size={16} aria-hidden />
            <div>
              <strong>Connect a tracker — coming soon</strong>
              <p className="muted" style={{ margin: "2px 0 0" }}>
                Live GPS from Bouncie, Samsara or LandAirSea can plug in here. It needs your tracker
                account and API keys, so it's not wired up yet — for now, locations are updated
                manually from each vehicle.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
