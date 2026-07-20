import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { listLocations, updateLocation } from "../lib/api";
import { downloadPdf, locationLabelsPdf, ZONE_NAMES } from "../lib/labels";

export function Labels() {
  const queryClient = useQueryClient();
  const locations = useQuery({ queryKey: ["locations"], queryFn: listLocations });
  const [zone, setZone] = useState<string>("all");
  const [busy, setBusy] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [addressDraft, setAddressDraft] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  const filtered = (locations.data ?? []).filter(
    (l) => zone === "all" || l.zone === zone,
  );

  const save = useMutation({
    mutationFn: (id: string) =>
      updateLocation(id, { address: addressDraft, display_name: nameDraft }),
    onSuccess: () => {
      setEditId(null);
      setEditError(null);
      queryClient.invalidateQueries({ queryKey: ["locations"] });
      queryClient.invalidateQueries({ queryKey: ["location"] });
    },
    onError: (e) => setEditError(String(e)),
  });

  const print = async () => {
    setBusy(true);
    try {
      const bytes = await locationLabelsPdf(
        filtered.map((l) => ({
          address: l.address,
          zoneName: ZONE_NAMES[l.zone],
          serial: l.serial,
          display_name: l.display_name,
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
        <div>
          <p className="home-greeting">Warehouse</p>
          <h1>Slot labels</h1>
        </div>
        <Link to="/" className="back-chip" aria-label="Home">
          ‹
        </Link>
      </header>
      <p className="muted">
        Window labels print from the Receive screen. This prints the rack/slot
        address labels. Each label&apos;s QR encodes a permanent serial, so
        renaming a slot never breaks a printed label.
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
          <li key={l.id} className="find-row">
            {editId === l.id ? (
              <div style={{ width: "100%" }}>
                <label className="field-label">Address (ZONE-RACK-SLOT)</label>
                <input
                  value={addressDraft}
                  onChange={(e) => setAddressDraft(e.target.value)}
                  autoCapitalize="characters"
                  aria-label="Slot address"
                />
                <label className="field-label">Friendly name (optional)</label>
                <input
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  placeholder="e.g. Front bay, top shelf"
                  aria-label="Slot display name"
                />
                {l.serial && (
                  <p className="muted" style={{ margin: "6px 0 0" }}>
                    Serial <strong>{l.serial}</strong> (permanent)
                  </p>
                )}
                {editError && <p className="error">{editError}</p>}
                <div className="action-list" style={{ marginTop: 8 }}>
                  <button
                    className="action-btn primary"
                    disabled={save.isPending}
                    onClick={() => save.mutate(l.id)}
                  >
                    {save.isPending ? "Saving…" : "Save"}
                  </button>
                  <button className="link" onClick={() => setEditId(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", width: "100%" }}>
                <div>
                  <strong>{l.address}</strong>{" "}
                  <span className="muted">{ZONE_NAMES[l.zone]}</span>
                  {l.display_name && (
                    <div className="muted" style={{ fontSize: 13 }}>
                      {l.display_name}
                    </div>
                  )}
                  {l.serial && (
                    <div className="muted" style={{ fontSize: 12 }}>
                      {l.serial}
                    </div>
                  )}
                </div>
                <button
                  className="link"
                  style={{ marginLeft: "auto" }}
                  onClick={() => {
                    setEditId(l.id);
                    setAddressDraft(l.address);
                    setNameDraft(l.display_name ?? "");
                    setEditError(null);
                  }}
                >
                  Edit
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
