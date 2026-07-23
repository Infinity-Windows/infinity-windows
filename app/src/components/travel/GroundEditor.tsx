import { useState } from "react";
import type { GroundTransport } from "../../lib/travel/types";
import { upsertGround } from "../../lib/travel/api";
import { utcToZonedWallTime, zonedWallTimeToUtc } from "../../lib/travel/dates";
import { COMMON_TIMEZONES, guessTimezone } from "../../lib/travel/zones";
import { toastError, toastSuccess } from "../../lib/toast";
import { Sheet } from "./Sheet";
import { AreaField, Field, FieldRow, SelectField } from "./Field";

const ZONE_OPTIONS = COMMON_TIMEZONES.map((z) => ({ value: z.id, label: z.label }));

export function GroundEditor({
  tripId,
  ground,
  onClose,
  onSaved,
}: {
  tripId: string;
  ground: GroundTransport | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const ptz = ground?.pickup_timezone ?? guessTimezone();
  const dtz = ground?.dropoff_timezone ?? guessTimezone();
  const [pickupTz, setPickupTz] = useState(ptz);
  const [dropoffTz, setDropoffTz] = useState(dtz);
  const [form, setForm] = useState({
    type: ground?.type ?? "",
    provider: ground?.provider ?? "",
    confirmation_code: ground?.confirmation_code ?? "",
    pickup_location: ground?.pickup_location ?? "",
    pickup_wall: utcToZonedWallTime(ground?.pickup_at, ptz),
    dropoff_location: ground?.dropoff_location ?? "",
    dropoff_wall: utcToZonedWallTime(ground?.dropoff_at, dtz),
    notes: ground?.notes ?? "",
  });
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      await upsertGround(tripId, {
        id: ground?.id,
        type: form.type.trim() || null,
        provider: form.provider.trim() || null,
        confirmation_code: form.confirmation_code.trim() || null,
        pickup_location: form.pickup_location.trim() || null,
        pickup_at: zonedWallTimeToUtc(form.pickup_wall, pickupTz),
        pickup_timezone: pickupTz,
        dropoff_location: form.dropoff_location.trim() || null,
        dropoff_at: zonedWallTimeToUtc(form.dropoff_wall, dropoffTz),
        dropoff_timezone: dropoffTz,
        notes: form.notes.trim() || null,
      });
      toastSuccess(ground ? "Transport updated" : "Transport added");
      onSaved();
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={ground ? "Edit transport" : "Add transport"}
      footer={
        <>
          <button className="button-like" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="button-like active-pill" style={{ marginLeft: "auto" }} onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <FieldRow>
        <Field label="Type" value={form.type} onChange={set("type")} placeholder="Rental car" />
        <Field label="Provider" value={form.provider} onChange={set("provider")} placeholder="Hertz" />
      </FieldRow>
      <Field label="Confirmation code" value={form.confirmation_code} onChange={set("confirmation_code")} />
      <Field label="Pickup location" value={form.pickup_location} onChange={set("pickup_location")} />
      <FieldRow>
        <Field label="Pickup (local)" type="datetime-local" value={form.pickup_wall} onChange={set("pickup_wall")} />
        <SelectField label="Pickup zone" value={pickupTz} onChange={setPickupTz} options={ZONE_OPTIONS} />
      </FieldRow>
      <Field label="Drop-off location" value={form.dropoff_location} onChange={set("dropoff_location")} />
      <FieldRow>
        <Field label="Drop-off (local)" type="datetime-local" value={form.dropoff_wall} onChange={set("dropoff_wall")} />
        <SelectField label="Drop-off zone" value={dropoffTz} onChange={setDropoffTz} options={ZONE_OPTIONS} />
      </FieldRow>
      <AreaField label="Notes" value={form.notes} onChange={set("notes")} />
    </Sheet>
  );
}
