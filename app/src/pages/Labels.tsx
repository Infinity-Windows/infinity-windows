import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { listLocations } from "../lib/api";
import { downloadPdf, locationLabelsPdf, ZONE_NAMES } from "../lib/labels";

export function Labels() {
  const locations = useQuery({ queryKey: ["locations"], queryFn: listLocations });
  const [zone, setZone] = useState<string>("all");
  const [busy, setBusy] = useState(false);

  const filtered = (locations.data ?? []).filter(
    (l) => zone === "all" || l.zone === zone,
  );

  const print = async () => {
    setBusy(true);
    try {
      const bytes = await locationLabelsPdf(
        filtered.map((l) => ({
          address: l.address,
          zoneName: ZONE_NAMES[l.zone],
        })),
      );
      downloadPdf(bytes, `slot-labels-${zone}.pdf`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>Slot labels</h1>
      </header>
      <p className="muted">
        Window labels print from the Receive screen. This prints the rack/slot
        address labels.
      </p>
      <label className="field-label">Zone</label>
      <select value={zone} onChange={(e) => setZone(e.target.value)}>
        <option value="all">All zones</option>
        <option value="S">Stock</option>
        <option value="J">Job staging</option>
        <option value="R">Receiving</option>
        <option value="D">Damage / hold</option>
      </select>
      <button className="primary big" onClick={print} disabled={busy || filtered.length === 0}>
        {busy ? "Generating..." : `Print ${filtered.length} labels`}
      </button>
      <ul className="unit-list">
        {filtered.map((l) => (
          <li key={l.id}>
            <strong>{l.address}</strong>{" "}
            <span className="muted">{ZONE_NAMES[l.zone]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
