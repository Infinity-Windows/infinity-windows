import { BackChip } from "../components/BackChip";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { deleteLocations, listLocations, updateLocation } from "../lib/api";
import {
  allIdsSelected,
  pruneSelection,
  toggleAllIds,
  toggleId,
} from "../lib/bulk";
import { downloadPdf, locationLabelsPdf, ZONE_NAMES } from "../lib/labels";
import { formatApiError } from "../lib/errors";
import { toastError, toastSuccess } from "../lib/toast";

export function Labels() {
  const queryClient = useQueryClient();
  const locations = useQuery({ queryKey: ["locations"], queryFn: listLocations });
  const [zone, setZone] = useState<string>("all");
  const [busy, setBusy] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [addressDraft, setAddressDraft] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const filtered = (locations.data ?? []).filter(
    (l) => zone === "all" || l.zone === zone,
  );
  const filteredIds = useMemo(() => filtered.map((l) => l.id), [filtered]);
  const allSelected = allIdsSelected(filteredIds, selected);
  const selectedFiltered = filtered.filter((l) => selected.has(l.id));

  const save = useMutation({
    mutationFn: (id: string) =>
      updateLocation(id, { address: addressDraft, display_name: nameDraft }),
    onSuccess: () => {
      setEditId(null);
      setEditError(null);
      queryClient.invalidateQueries({ queryKey: ["locations"] });
      queryClient.invalidateQueries({ queryKey: ["location"] });
    },
    onError: (e) => setEditError(formatApiError(e)),
  });

  const bulkDelete = useMutation({
    mutationFn: (ids: string[]) => deleteLocations(ids),
    onSuccess: (_data, ids) => {
      toastSuccess(
        `Deleted ${ids.length} slot${ids.length === 1 ? "" : "s"}.`,
      );
      setConfirmingDelete(false);
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ["locations"] });
      queryClient.invalidateQueries({ queryKey: ["location"] });
    },
    onError: (e) => {
      setConfirmingDelete(false);
      toastError(e);
    },
  });

  const printSlots = async (
    slots: typeof filtered,
    filename: string,
  ) => {
    if (slots.length === 0) return;
    setBusy(true);
    try {
      const bytes = await locationLabelsPdf(
        slots.map((l) => ({
          address: l.address,
          zoneName: ZONE_NAMES[l.zone],
          serial: l.serial,
          display_name: l.display_name,
        })),
      );
      downloadPdf(bytes, filename);
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
        <BackChip fallback="/warehouse" label="Warehouse" />
      </header>
      <p className="muted">
        Window labels print from the Receive screen. This prints the rack/slot
        address labels. Each label&apos;s QR encodes a permanent serial, so
        renaming a slot never breaks a printed label.
      </p>
      <label className="field-label">Zone</label>
      <select
        value={zone}
        onChange={(e) => {
          setZone(e.target.value);
          // Selection is scoped to the visible list; drop anything now hidden.
          setSelected((s) =>
            pruneSelection(
              (locations.data ?? [])
                .filter(
                  (l) => e.target.value === "all" || l.zone === e.target.value,
                )
                .map((l) => l.id),
              s,
            ),
          );
          setConfirmingDelete(false);
        }}
      >
        <option value="all">All zones</option>
        <option value="S">Stock</option>
        <option value="J">Job staging</option>
        <option value="R">Receiving</option>
        <option value="D">Damage / hold</option>
      </select>
      <button
        className="primary big"
        onClick={() => printSlots(filtered, `slot-labels-${zone}.pdf`)}
        disabled={busy || filtered.length === 0}
      >
        {busy ? "Generating..." : `Print ${filtered.length} labels`}
      </button>

      {filtered.length > 0 && (
        <label
          style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0" }}
        >
          <input
            type="checkbox"
            checked={allSelected}
            onChange={() => {
              setSelected((s) => toggleAllIds(filteredIds, s));
              setConfirmingDelete(false);
            }}
          />
          Select all ({filtered.length})
        </label>
      )}

      {selectedFiltered.length > 0 && (
        <div className="action-list">
          <button
            className="action-btn"
            disabled={busy}
            onClick={() =>
              printSlots(selectedFiltered, `slot-labels-selected.pdf`)
            }
          >
            Print {selectedFiltered.length} selected
          </button>
          {confirmingDelete ? (
            <div className="sched-conflict-inline is-emphasized" role="alert">
              <div>
                <p style={{ margin: 0 }}>
                  Delete {selectedFiltered.length} slot
                  {selectedFiltered.length === 1 ? "" : "s"}? Printed labels for
                  these slots will stop working. This can’t be undone here.
                </p>
                <div className="action-list" style={{ marginTop: 8 }}>
                  <button
                    className="button-like danger-outline"
                    disabled={bulkDelete.isPending}
                    onClick={() =>
                      bulkDelete.mutate(selectedFiltered.map((l) => l.id))
                    }
                  >
                    {bulkDelete.isPending
                      ? "Deleting…"
                      : `Yes, delete ${selectedFiltered.length}`}
                  </button>
                  <button
                    className="button-like"
                    disabled={bulkDelete.isPending}
                    onClick={() => setConfirmingDelete(false)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <button
              className="action-btn danger-outline"
              onClick={() => setConfirmingDelete(true)}
            >
              Delete {selectedFiltered.length} selected
            </button>
          )}
        </div>
      )}

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
                <input
                  type="checkbox"
                  aria-label={`Select ${l.address}`}
                  checked={selected.has(l.id)}
                  onChange={() => setSelected((s) => toggleId(s, l.id))}
                  style={{ marginRight: 8 }}
                />
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
