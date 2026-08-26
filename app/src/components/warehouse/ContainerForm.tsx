// New/edit container form. Moved here from the Storage hub when it merged
// into /warehouse (ticket 18) — ContainerDetail.tsx also reuses this for
// editing an existing container, same as before the merge.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { formatApiError } from "../../lib/errors";
import { pushToast } from "../../lib/toast";
import { containerKind, saveContainer, type StorageContainer } from "../../lib/storage";

export function ContainerForm({
  initial,
  onClose,
  onSaved,
}: {
  initial?: StorageContainer | null;
  onClose: () => void;
  onSaved: (c: StorageContainer) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [address, setAddress] = useState(initial?.address ?? "");
  const [accessCode, setAccessCode] = useState(initial?.access_code ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  // Kind is picked once, at creation. Editing keeps whatever the box is —
  // a crate that "becomes" a conex is really a new box (ticket 12).
  const [kind, setKind] = useState(containerKind(initial));
  const [dims, setDims] = useState({
    length: initial?.length_cm != null ? String(initial.length_cm) : "",
    width: initial?.width_cm != null ? String(initial.width_cm) : "",
    height: initial?.height_cm != null ? String(initial.height_cm) : "",
    weight: initial?.weight_kg != null ? String(initial.weight_kg) : "",
  });
  // "120" -> 120, "" -> null, junk -> null. A dimension is a measurement:
  // null is "not measured yet", and the server refuses zero and below.
  const dim = (raw: string): number | null => {
    const n = Number(raw.trim());
    return raw.trim() !== "" && Number.isFinite(n) ? n : null;
  };
  const save = useMutation({
    mutationFn: () =>
      saveContainer({
        id: initial?.id ?? null,
        name,
        address: address || null,
        accessCode: accessCode || null,
        notes: notes || null,
        kind,
        lengthCm: dim(dims.length),
        widthCm: dim(dims.width),
        heightCm: dim(dims.height),
        weightKg: dim(dims.weight),
      }),
    onSuccess: (c) => {
      pushToast(initial ? "Container updated." : `${c.name} added.`);
      onSaved(c);
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <p style={{ margin: 0, fontWeight: 700 }}>
          {initial ? `Edit ${initial.name}` : "New container"}
        </p>
        <label className="field-label">Name</label>
        <input
          placeholder="Conex 7 / Glass crate 12"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <label className="field-label">What kind of box</label>
        {/* Locked after creation — the kind rules every move it has ever made. */}
        <select value={kind} disabled={!!initial} onChange={(e) => setKind(e.target.value)}>
          <option value="conex">Conex</option>
          <option value="crate">Crate</option>
          <option value="truck">Truck</option>
        </select>
        {kind === "crate" && (
          <>
            <p className="muted" style={{ fontSize: 12.5, margin: "6px 0 0" }}>
              Size and weight, so anyone can tell whether it fits in a conex and
              what the forklift is picking up. Centimeters and kilograms; leave
              blank until it's measured.
            </p>
            <div className="row-gap">
              <div style={{ flex: 1 }}>
                <label className="field-label">Length (cm)</label>
                <input inputMode="decimal" value={dims.length}
                  onChange={(e) => setDims({ ...dims, length: e.target.value })} />
              </div>
              <div style={{ flex: 1 }}>
                <label className="field-label">Width (cm)</label>
                <input inputMode="decimal" value={dims.width}
                  onChange={(e) => setDims({ ...dims, width: e.target.value })} />
              </div>
            </div>
            <div className="row-gap">
              <div style={{ flex: 1 }}>
                <label className="field-label">Height (cm)</label>
                <input inputMode="decimal" value={dims.height}
                  onChange={(e) => setDims({ ...dims, height: e.target.value })} />
              </div>
              <div style={{ flex: 1 }}>
                <label className="field-label">Weight (kg)</label>
                <input inputMode="decimal" value={dims.weight}
                  onChange={(e) => setDims({ ...dims, weight: e.target.value })} />
              </div>
            </div>
          </>
        )}
        <label className="field-label">Address</label>
        <input
          placeholder="Where it sits"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        <label className="field-label">Gate / lock code</label>
        <input value={accessCode} onChange={(e) => setAccessCode(e.target.value)} />
        <label className="field-label">Notes</label>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} />
        <div className="row-gap" style={{ marginTop: 10 }}>
          <button
            className="button-like active-pill"
            disabled={!name.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
          <button className="button-like" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
