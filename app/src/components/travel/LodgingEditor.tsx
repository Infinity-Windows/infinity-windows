import { useState } from "react";
import type { Lodging } from "../../lib/travel/types";
import { upsertLodging } from "../../lib/travel/api";
import { utcToZonedWallTime, zonedWallTimeToUtc } from "../../lib/travel/dates";
import { COMMON_TIMEZONES, guessTimezone } from "../../lib/travel/zones";
import { toastError, toastSuccess } from "../../lib/toast";
import { Sheet } from "./Sheet";
import { AreaField, Field, FieldRow, SelectField, ToggleField } from "./Field";

const ZONE_OPTIONS = COMMON_TIMEZONES.map((z) => ({ value: z.id, label: z.label }));

function intOrNull(v: string): number | null {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}
function floatOrNull(v: string): number | null {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

export function LodgingEditor({
  tripId,
  lodging,
  onClose,
  onSaved,
}: {
  tripId: string;
  lodging: Lodging | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const tz = lodging?.timezone ?? guessTimezone();
  const [zone, setZone] = useState(tz);
  const [washerDryer, setWasherDryer] = useState(Boolean(lodging?.washer_dryer));
  const [kitchen, setKitchen] = useState(Boolean(lodging?.kitchen));
  const [form, setForm] = useState({
    name: lodging?.name ?? "",
    address: lodging?.address ?? "",
    wifi_ssid: lodging?.wifi_ssid ?? "",
    wifi_password: lodging?.wifi_password ?? "",
    door_code: lodging?.door_code ?? "",
    entry_steps: lodging?.entry_steps ?? "",
    backup_entry: lodging?.backup_entry ?? "",
    host_name: lodging?.host_name ?? "",
    host_phone: lodging?.host_phone ?? "",
    check_in_wall: utcToZonedWallTime(lodging?.check_in_at, tz),
    check_out_wall: utcToZonedWallTime(lodging?.check_out_at, tz),
    nights: lodging?.nights != null ? String(lodging.nights) : "",
    bedrooms: lodging?.bedrooms != null ? String(lodging.bedrooms) : "",
    beds: lodging?.beds != null ? String(lodging.beds) : "",
    baths: lodging?.baths != null ? String(lodging.baths) : "",
    parking: lodging?.parking ?? "",
    quiet_hours: lodging?.quiet_hours ?? "",
    checkout_tasks: lodging?.checkout_tasks ?? "",
    notes: lodging?.notes ?? "",
  });
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      await upsertLodging(tripId, {
        id: lodging?.id,
        name: form.name.trim() || null,
        address: form.address.trim() || null,
        timezone: zone,
        wifi_ssid: form.wifi_ssid.trim() || null,
        wifi_password: form.wifi_password || null,
        door_code: form.door_code || null,
        entry_steps: form.entry_steps.trim() || null,
        backup_entry: form.backup_entry.trim() || null,
        host_name: form.host_name.trim() || null,
        host_phone: form.host_phone.trim() || null,
        check_in_at: zonedWallTimeToUtc(form.check_in_wall, zone),
        check_out_at: zonedWallTimeToUtc(form.check_out_wall, zone),
        nights: intOrNull(form.nights),
        bedrooms: intOrNull(form.bedrooms),
        beds: intOrNull(form.beds),
        baths: floatOrNull(form.baths),
        washer_dryer: washerDryer,
        kitchen,
        parking: form.parking.trim() || null,
        quiet_hours: form.quiet_hours.trim() || null,
        checkout_tasks: form.checkout_tasks.trim() || null,
        notes: form.notes.trim() || null,
      });
      toastSuccess(lodging ? "Lodging updated" : "Lodging added");
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
      title={lodging ? "Edit lodging" : "Add lodging"}
      footer={
        <>
          <button className="button-like" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="button-like active-pill" style={{ marginLeft: "auto" }} onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <Field label="Name" value={form.name} onChange={set("name")} placeholder="Cedar House" />
      <Field label="Address" value={form.address} onChange={set("address")} />
      <FieldRow>
        <Field label="Wi-Fi network" value={form.wifi_ssid} onChange={set("wifi_ssid")} />
        <Field label="Wi-Fi password" value={form.wifi_password} onChange={set("wifi_password")} />
      </FieldRow>
      <Field label="Door / lockbox code" value={form.door_code} onChange={set("door_code")} />
      <AreaField label="Getting in (entry steps)" value={form.entry_steps} onChange={set("entry_steps")} />
      <AreaField label="Backup entry" value={form.backup_entry} onChange={set("backup_entry")} rows={2} />
      <FieldRow>
        <Field label="Host name" value={form.host_name} onChange={set("host_name")} />
        <Field label="Host phone" type="tel" value={form.host_phone} onChange={set("host_phone")} />
      </FieldRow>
      <FieldRow>
        <Field label="Check-in (local)" type="datetime-local" value={form.check_in_wall} onChange={set("check_in_wall")} />
        <Field label="Check-out (local)" type="datetime-local" value={form.check_out_wall} onChange={set("check_out_wall")} />
      </FieldRow>
      <SelectField label="Timezone" value={zone} onChange={setZone} options={ZONE_OPTIONS} />
      <FieldRow>
        <Field label="Nights" type="number" value={form.nights} onChange={set("nights")} />
        <Field label="Bedrooms" type="number" value={form.bedrooms} onChange={set("bedrooms")} />
      </FieldRow>
      <FieldRow>
        <Field label="Beds" type="number" value={form.beds} onChange={set("beds")} />
        <Field label="Baths" type="number" value={form.baths} onChange={set("baths")} />
      </FieldRow>
      <div className="travel-toggle-row">
        <ToggleField label="Washer/dryer" value={washerDryer} onChange={setWasherDryer} />
        <ToggleField label="Kitchen" value={kitchen} onChange={setKitchen} />
      </div>
      <Field label="Parking" value={form.parking} onChange={set("parking")} />
      <Field label="Quiet hours" value={form.quiet_hours} onChange={set("quiet_hours")} />
      <AreaField label="Before checkout" value={form.checkout_tasks} onChange={set("checkout_tasks")} />
      <AreaField label="Notes" value={form.notes} onChange={set("notes")} />
    </Sheet>
  );
}
