import { useMemo, useRef, useState } from "react";
import { Trash2, X } from "lucide-react";
import type { Profile } from "../../lib/install/types";
import { useFocusTrap } from "../../lib/useFocusTrap";
import { DriverPicker } from "./DriverPicker";
import type {
  TrailerSubtype,
  VehicleDriver,
  VehicleInput,
  VehicleKind,
  VehicleStatus,
  VehicleWithMeta,
} from "../../lib/vehicles/types";
import {
  TRAILER_SUBTYPE_LABELS,
  VEHICLE_KIND_LABELS,
  VEHICLE_STATUS_LABELS,
} from "../../lib/vehicles/types";

interface Props {
  vehicle: VehicleWithMeta | null;
  profiles: Profile[];
  saving?: boolean;
  onSave: (input: VehicleInput) => void;
  onDelete?: () => void;
  onClose: () => void;
}

const KINDS: VehicleKind[] = ["pickup", "car", "heavy_machinery", "trailer"];
const SUBTYPES: TrailerSubtype[] = ["flatbed", "tiltdeck", "box", "gooseneck"];
const STATUSES: VehicleStatus[] = ["active", "in_shop", "out_of_service", "sold"];

function numOrNull(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function VehicleEditor({ vehicle, profiles, saving, onSave, onDelete, onClose }: Props) {
  const [kind, setKind] = useState<VehicleKind>(vehicle?.kind ?? "pickup");
  const [subtype, setSubtype] = useState<TrailerSubtype | "">(vehicle?.trailer_subtype ?? "");
  const [year, setYear] = useState(vehicle?.year != null ? String(vehicle.year) : "");
  const [make, setMake] = useState(vehicle?.make ?? "");
  const [model, setModel] = useState(vehicle?.model ?? "");
  const [color, setColor] = useState(vehicle?.color ?? "");
  const [vin, setVin] = useState(vehicle?.vin ?? "");
  const [plate, setPlate] = useState(vehicle?.plate ?? "");
  const [odometer, setOdometer] = useState(vehicle?.odometer != null ? String(vehicle.odometer) : "");
  const [engineHours, setEngineHours] = useState(
    vehicle?.engine_hours != null ? String(vehicle.engine_hours) : "",
  );
  const [status, setStatus] = useState<VehicleStatus>(vehicle?.status ?? "active");
  const [lastService, setLastService] = useState(vehicle?.last_service_date ?? "");
  const [nextService, setNextService] = useState(vehicle?.next_service_date ?? "");
  const [notes, setNotes] = useState(vehicle?.notes ?? "");
  const [drivers, setDrivers] = useState<VehicleDriver[]>(vehicle?.drivers?.map((d) => ({ ...d })) ?? []);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const confirmRef = useRef<HTMLDivElement>(null);
  useFocusTrap(confirmRef, confirmingDelete, () => setConfirmingDelete(false));

  const isTrailer = kind === "trailer";
  const isMachinery = kind === "heavy_machinery";
  const canSave = useMemo(
    () => Boolean(make.trim() || model.trim() || year.trim()),
    [make, model, year],
  );

  function submit() {
    if (!canSave) return;
    onSave({
      kind,
      trailer_subtype: isTrailer && subtype ? subtype : null,
      year: numOrNull(year),
      make: make.trim() || null,
      model: model.trim() || null,
      color: color.trim() || null,
      vin: vin.trim() || null,
      plate: plate.trim() || null,
      odometer: isTrailer ? null : numOrNull(odometer),
      engine_hours: isMachinery ? numOrNull(engineHours) : null,
      last_service_date: lastService || null,
      next_service_date: nextService || null,
      status,
      notes: notes.trim() || null,
      drivers,
    });
  }

  return (
    <div className="sched-sheet-backdrop" role="dialog" aria-modal="true">
      <div className="sched-sheet veh-sheet">
        <div className="sched-sheet-head">
          <h2 style={{ margin: 0 }}>{vehicle ? "Edit vehicle" : "Add vehicle"}</h2>
          <button className="icon-button sched-sheet-close" onClick={onClose} aria-label="Close">
            <X size={20} strokeWidth={2.5} />
          </button>
        </div>

        <label className="field-label">Type</label>
        <div className="sched-chips">
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              className={`sched-chip${kind === k ? " is-picked" : ""}`}
              onClick={() => setKind(k)}
            >
              {VEHICLE_KIND_LABELS[k]}
            </button>
          ))}
        </div>

        {isTrailer && (
          <>
            <label className="field-label">Trailer subtype</label>
            <div className="sched-chips">
              {SUBTYPES.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`sched-chip${subtype === s ? " is-picked" : ""}`}
                  onClick={() => setSubtype(subtype === s ? "" : s)}
                >
                  {TRAILER_SUBTYPE_LABELS[s]}
                </button>
              ))}
            </div>
          </>
        )}

        <div className="sched-row-2">
          <div>
            <label className="field-label">Year</label>
            <input type="number" inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value)} placeholder="2021" />
          </div>
          <div>
            <label className="field-label">Color</label>
            <input type="text" value={color} onChange={(e) => setColor(e.target.value)} placeholder="White" />
          </div>
        </div>

        <div className="sched-row-2">
          <div>
            <label className="field-label">Make</label>
            <input type="text" value={make} onChange={(e) => setMake(e.target.value)} placeholder="Ford" />
          </div>
          <div>
            <label className="field-label">Model</label>
            <input type="text" value={model} onChange={(e) => setModel(e.target.value)} placeholder="F-150" />
          </div>
        </div>

        <div className="sched-row-2">
          <div>
            <label className="field-label">Plate</label>
            <input type="text" value={plate} onChange={(e) => setPlate(e.target.value)} placeholder="ABC-1234" />
          </div>
          <div>
            <label className="field-label">VIN</label>
            <input type="text" value={vin} onChange={(e) => setVin(e.target.value)} placeholder="1FT…" />
          </div>
        </div>

        {!isTrailer && (
          <div className="sched-row-2">
            {isMachinery ? (
              <div>
                <label className="field-label">Engine hours</label>
                <input
                  type="number"
                  inputMode="decimal"
                  value={engineHours}
                  onChange={(e) => setEngineHours(e.target.value)}
                  placeholder="1200"
                />
              </div>
            ) : (
              <div>
                <label className="field-label">Odometer (mi)</label>
                <input
                  type="number"
                  inputMode="numeric"
                  value={odometer}
                  onChange={(e) => setOdometer(e.target.value)}
                  placeholder="84000"
                />
              </div>
            )}
            <div>
              <label className="field-label">Status</label>
              <select value={status} onChange={(e) => setStatus(e.target.value as VehicleStatus)}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {VEHICLE_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
        {isTrailer && (
          <>
            <label className="field-label">Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value as VehicleStatus)}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {VEHICLE_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </>
        )}

        <div className="sched-row-2">
          <div>
            <label className="field-label">Last service</label>
            <input type="date" value={lastService} onChange={(e) => setLastService(e.target.value)} />
          </div>
          <div>
            <label className="field-label">Next service</label>
            <input type="date" value={nextService} onChange={(e) => setNextService(e.target.value)} />
          </div>
        </div>

        <DriverPicker profiles={profiles} value={drivers} onChange={setDrivers} />

        <label className="field-label">Notes (optional)</label>
        <textarea
          className="sched-note-input"
          rows={2}
          value={notes}
          placeholder="e.g. spare key in the office lockbox"
          onChange={(e) => setNotes(e.target.value)}
        />

        <div className="sched-sheet-actions">
          {vehicle && onDelete && (
            <button
              className="button-like danger-outline"
              onClick={() => setConfirmingDelete(true)}
              disabled={saving}
            >
              <Trash2 size={15} aria-hidden /> Remove
            </button>
          )}
          <button
            className="button-like active-pill"
            style={{ marginLeft: "auto" }}
            onClick={submit}
            disabled={!canSave || saving}
          >
            {saving ? "Saving…" : vehicle ? "Save changes" : "Add vehicle"}
          </button>
        </div>
        {!canSave && (
          <p className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
            Add at least a make, model, or year.
          </p>
        )}
      </div>

      {vehicle && onDelete && confirmingDelete && (
        <div className="sched-sheet-backdrop" role="dialog" aria-modal="true" aria-labelledby="veh-remove-title">
          <div className="sched-sheet" ref={confirmRef}>
            <div className="sched-sheet-head">
              <h2 id="veh-remove-title" style={{ margin: 0 }}>Remove this vehicle?</h2>
            </div>
            <p className="muted">
              This removes the vehicle and its drivers, location, service history and job link. This
              can't be undone.
            </p>
            <div className="sched-sheet-actions">
              <button className="button-like" onClick={() => setConfirmingDelete(false)} disabled={saving}>
                Cancel
              </button>
              <button
                className="button-like danger-outline"
                style={{ marginLeft: "auto" }}
                onClick={onDelete}
                disabled={saving}
              >
                <Trash2 size={15} aria-hidden /> {saving ? "Removing…" : "Remove vehicle"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
