import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Crosshair, MapPin } from "lucide-react";
import { ClientFleetMap, type MapPoint } from "./ClientFleetMap";
import { updateVehicleLocation } from "../../lib/vehicles/api";
import { LOCATION_STATUS_LABELS, isValidLatLng, lastSeenLabel, locationStatus } from "../../lib/vehicles/location";
import { vehicleTitle } from "../../lib/vehicles/display";
import { toastError, toastSuccess } from "../../lib/toast";
import type { VehicleWithMeta } from "../../lib/vehicles/types";

export function LocationSection({ vehicle }: { vehicle: VehicleWithMeta }) {
  const qc = useQueryClient();
  const nowMs = Date.now();
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [locating, setLocating] = useState(false);

  const loc = vehicle.location;
  const status = locationStatus(loc?.recorded_at, nowMs);
  const points: MapPoint[] = loc
    ? [{ id: vehicle.id, lat: loc.lat, lng: loc.lng, title: vehicleTitle(vehicle), status, lastSeen: lastSeenLabel(loc.recorded_at, nowMs) }]
    : [];

  const save = useMutation({
    mutationFn: (input: { lat: number; lng: number; speed_mph?: number | null; heading_deg?: number | null }) =>
      updateVehicleLocation(vehicle.id, input),
    onSuccess: () => {
      toastSuccess("Location updated");
      setLat("");
      setLng("");
      qc.invalidateQueries({ queryKey: ["vehicle", vehicle.id] });
      qc.invalidateQueries({ queryKey: ["vehicles"] });
    },
  });

  function useMyLocation() {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      toastError(null, "This device can't share its location.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        save.mutate({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          speed_mph: pos.coords.speed != null ? pos.coords.speed * 2.2369 : null,
          heading_deg: pos.coords.heading ?? null,
        });
      },
      () => {
        setLocating(false);
        toastError(null, "Couldn't get your location. Enter it manually below.");
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  function saveManual() {
    const la = Number(lat);
    const lo = Number(lng);
    if (!isValidLatLng(la, lo)) {
      toastError(null, "Enter a valid latitude and longitude.");
      return;
    }
    save.mutate({ lat: la, lng: lo });
  }

  return (
    <section className="veh-section">
      <div className="veh-section-head">
        <h2>Location</h2>
        <span className={`veh-loc-chip veh-loc-${status}`}>
          <MapPin size={12} aria-hidden /> {status === "none" ? "No location" : LOCATION_STATUS_LABELS[status]}
        </span>
      </div>

      {loc ? (
        <>
          <ClientFleetMap points={points} height={240} />
          <p className="muted" style={{ marginTop: 8 }}>
            Last seen {lastSeenLabel(loc.recorded_at, nowMs)} · {loc.lat.toFixed(4)}, {loc.lng.toFixed(4)}
            {loc.source ? ` · ${loc.source}` : ""}
          </p>
        </>
      ) : (
        <p className="muted">No location yet. Drop one below.</p>
      )}

      <div className="veh-loc-actions">
        <button className="button-like active-pill" onClick={useMyLocation} disabled={locating || save.isPending}>
          <Crosshair size={15} aria-hidden /> {locating ? "Locating…" : "Use my current location"}
        </button>
      </div>

      <div className="veh-loc-manual">
        <div className="sched-row-2">
          <div>
            <label className="field-label">Latitude</label>
            <input type="number" inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="40.7128" />
          </div>
          <div>
            <label className="field-label">Longitude</label>
            <input type="number" inputMode="decimal" value={lng} onChange={(e) => setLng(e.target.value)} placeholder="-74.0060" />
          </div>
        </div>
        <button className="button-like" onClick={saveManual} disabled={save.isPending || !lat || !lng}>
          {save.isPending ? "Saving…" : "Save manual location"}
        </button>
      </div>
    </section>
  );
}
