// One shelf, and what actually sits on it (rebuilt for packages, ticket 21).
//
// The unit-chain version listed WIN- units and offered a cycle count; both
// retired. What a slot honestly holds now is packages — in practice a job's
// staging bay, since Set aside is the one thing that puts a package on a
// shelf (CONTEXT: a shelf is staging, not storage).

import { BackChip } from "../components/BackChip";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { getLocationByAddress } from "../lib/api";
import { ZONE_NAMES } from "../lib/labels";
import { listActivePackages, type StoragePackage } from "../lib/storage";
import { partLabel } from "../lib/storage";

export function LocationDetail() {
  const { address = "" } = useParams();

  const location = useQuery({
    queryKey: ["location", address],
    queryFn: () => getLocationByAddress(address),
  });
  const packages = useQuery({ queryKey: ["storagePackages"], queryFn: listActivePackages });

  if (location.isLoading) return <div className="page">Loading...</div>;
  if (!location.data) {
    return (
      <div className="page">
        <p className="error">No slot with address {address}.</p>
      </div>
    );
  }

  const loc = location.data;
  const here: StoragePackage[] = (packages.data ?? []).filter(
    (p) => p.location_id === loc.id && p.status !== "checked_out",
  );

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">{ZONE_NAMES[loc.zone]}</p>
          <h1>{loc.address}</h1>
        </div>
        <BackChip fallback="/warehouse" label="Back" />
      </header>
      <p className="muted">Capacity {loc.capacity}</p>

      <h2>On this shelf ({here.length})</h2>
      <ul className="unit-list">
        {here.map((p) => (
          <li key={p.id} className="find-row">
            <Link to={`/pkg/${p.serial}`} style={{ minWidth: 0 }}>
              <strong>{p.short_code ?? p.serial}</strong>
            </Link>{" "}
            <span className="muted" style={{ fontSize: 12 }}>
              {(p.package_marks ?? []).map((m) => `W${m.mark_code}`).join(", ")}
              {partLabel(p) ? ` · ${partLabel(p)}` : ""}
            </span>
          </li>
        ))}
        {here.length === 0 && <p className="muted">Empty.</p>}
      </ul>
    </div>
  );
}
