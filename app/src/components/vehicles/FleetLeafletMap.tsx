import { useEffect } from "react";
import { MapContainer, Marker, Popup, TileLayer, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { LocationStatus } from "../../lib/vehicles/location";

// This module is loaded ONLY in the browser (via a lazy import guarded by a
// mounted flag in FleetMap / the detail Location section), so Leaflet — which
// touches `window`/`document` at import time — never runs during build or the
// react-query dehydration pass. We avoid Leaflet's default marker-image asset
// path entirely by rendering a themed `divIcon` pulsing dot.

export interface MapPoint {
  id: string;
  lat: number;
  lng: number;
  title: string;
  status: LocationStatus;
  lastSeen: string;
}

const US_CENTER: [number, number] = [39.5, -98.35];

function dotIcon(status: LocationStatus): L.DivIcon {
  return L.divIcon({
    className: "veh-map-marker",
    html: `<span class="veh-map-dot veh-map-dot-${status}"></span>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    popupAnchor: [0, -10],
  });
}

/** Fit the map to all points once they're known (single point → gentle zoom). */
function FitToPoints({ points }: { points: MapPoint[] }) {
  const map = useMap();
  useEffect(() => {
    if (points.length === 0) {
      map.setView(US_CENTER, 4);
      return;
    }
    if (points.length === 1) {
      map.setView([points[0].lat, points[0].lng], 13);
      return;
    }
    const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number]));
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 13 });
  }, [map, points]);
  return null;
}

export default function FleetLeafletMap({ points, height = 420 }: { points: MapPoint[]; height?: number }) {
  return (
    <MapContainer
      center={US_CENTER}
      zoom={4}
      scrollWheelZoom
      style={{ height, width: "100%", borderRadius: 14 }}
      className="veh-map"
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <FitToPoints points={points} />
      {points.map((p) => (
        <Marker key={p.id} position={[p.lat, p.lng]} icon={dotIcon(p.status)}>
          <Popup>
            <strong>{p.title}</strong>
            <br />
            <span>{p.lastSeen}</span>
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}
