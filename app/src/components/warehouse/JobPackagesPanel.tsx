// The job page's window into the package chain (ticket 21).
//
// The unit chain's four panels lived here — pre-issue, reconciliation, the
// load-to-truck tab, unload. Their jobs all moved onto packages, and this
// panel is the short honest summary plus the doors: what of this job's
// material the warehouse holds and where, what is checked out, and the two
// screens that move it.

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  listActivePackages,
  listContainers,
} from "../../lib/storage";
import { listLocations } from "../../lib/api";
import { placeWhere, toLocationsById } from "../../lib/warehouse/containment";

export function JobPackagesPanel({ projectId }: { projectId: string }) {
  const packages = useQuery({ queryKey: ["storagePackages"], queryFn: listActivePackages });
  const containers = useQuery({ queryKey: ["storageContainers"], queryFn: listContainers });
  const locations = useQuery({ queryKey: ["locations"], queryFn: listLocations });

  const mine = (packages.data ?? []).filter((p) => p.project_id === projectId);
  const held = mine.filter((p) => p.status === "received" || p.status === "stored");
  const out = mine.filter((p) => p.status === "checked_out");
  const onTheWay = mine.filter((p) => p.status === "minted");

  const byId = new Map((containers.data ?? []).map((c) => [c.id, c]));
  const locsById = toLocationsById(locations.data ?? []);
  // "Conex 3 ×4 · staged for BLACK22 ×2" — where the held material sits.
  const placeCounts = new Map<string, number>();
  for (const p of held) {
    const w = placeWhere(p, byId, locsById);
    placeCounts.set(w, (placeCounts.get(w) ?? 0) + 1);
  }

  return (
    <section className="detail-card" style={{ marginBottom: 16 }}>
      <h2 style={{ margin: 0 }}>This job&rsquo;s packages</h2>
      <p className="muted" style={{ margin: "6px 0 8px", fontSize: 13.5 }}>
        {held.length} on hand
        {onTheWay.length > 0 ? ` · ${onTheWay.length} on the way` : ""}
        {out.length > 0 ? ` · ${out.length} checked out` : ""}
        {mine.length === 0 ? "Nothing tagged for this job yet." : ""}
      </p>
      {placeCounts.size > 0 && (
        <p className="muted" style={{ margin: "0 0 8px", fontSize: 12.5 }}>
          {[...placeCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([w, n]) => `${w} ×${n}`)
            .join(" · ")}
        </p>
      )}
      <div className="row-gap" style={{ flexWrap: "wrap" }}>
        <Link className="button-like" to="/storage/out">
          Set aside / check out
        </Link>
        <Link className="button-like" to="/storage/arrive">
          Arrival check
        </Link>
      </div>
    </section>
  );
}
