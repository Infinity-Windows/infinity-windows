import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { getLocationByAddress, getUnitsAtLocation } from "../lib/api";
import { ZONE_NAMES } from "../lib/labels";
import { STATUS_LABELS } from "../lib/types";

export function LocationDetail() {
  const { address = "" } = useParams();

  const location = useQuery({
    queryKey: ["location", address],
    queryFn: () => getLocationByAddress(address),
  });

  const units = useQuery({
    queryKey: ["locationUnits", location.data?.id],
    queryFn: () => getUnitsAtLocation(location.data!.id),
    enabled: Boolean(location.data?.id),
  });

  if (location.isLoading) return <div className="page">Loading...</div>;
  if (!location.data) {
    return (
      <div className="page">
        <p className="error">No slot with address {address}.</p>
      </div>
    );
  }

  const loc = location.data;
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">{ZONE_NAMES[loc.zone]}</p>
          <h1>{loc.address}</h1>
        </div>
        <Link to="/warehouse" className="back-chip" aria-label="Back">
          ‹
        </Link>
      </header>
      <p className="muted">Capacity {loc.capacity}</p>

      <h2>
        In this slot ({units.data?.length ?? 0}/{loc.capacity})
      </h2>
      <ul className="unit-list">
        {(units.data ?? []).map((u) => (
          <li key={u.id}>
            <Link to={`/w/${encodeURIComponent(u.window_id)}`}>
              <strong>{u.window_id}</strong>
            </Link>{" "}
            <span className="muted">
              {u.window_types?.name} — {STATUS_LABELS[u.status]}
            </span>
          </li>
        ))}
        {units.data?.length === 0 && <p className="muted">Empty.</p>}
      </ul>
      <Link to={`/count?address=${encodeURIComponent(loc.address)}`} className="action-btn">
        Cycle count this slot
      </Link>
    </div>
  );
}
