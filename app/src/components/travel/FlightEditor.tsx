import { useState } from "react";
import type { Flight, TripCrewMember } from "../../lib/travel/types";
import { upsertFlight } from "../../lib/travel/api";
import { utcToZonedWallTime, zonedWallTimeToUtc } from "../../lib/travel/dates";
import { COMMON_TIMEZONES, guessTimezone } from "../../lib/travel/zones";
import { toastError, toastSuccess } from "../../lib/toast";
import { Sheet } from "./Sheet";
import { Field, FieldRow, SelectField, AreaField } from "./Field";

const ZONE_OPTIONS = COMMON_TIMEZONES.map((z) => ({ value: z.id, label: z.label }));

function numOrNull(v: string): number | null {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

export function FlightEditor({
  tripId,
  crew,
  flight,
  onClose,
  onSaved,
}: {
  tripId: string;
  crew: TripCrewMember[];
  flight: Flight | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const dtz = flight?.depart_timezone ?? guessTimezone();
  const atz = flight?.arrive_timezone ?? guessTimezone();
  const [departTz, setDepartTz] = useState(dtz);
  const [arriveTz, setArriveTz] = useState(atz);
  const [form, setForm] = useState({
    profile_id: flight?.profile_id ?? "",
    airline: flight?.airline ?? "",
    flight_number: flight?.flight_number ?? "",
    confirmation_code: flight?.confirmation_code ?? "",
    depart_airport: flight?.depart_airport ?? "",
    arrive_airport: flight?.arrive_airport ?? "",
    depart_wall: utcToZonedWallTime(flight?.depart_at, dtz),
    arrive_wall: utcToZonedWallTime(flight?.arrive_at, atz),
    minutes_before_departure: String(flight?.minutes_before_departure ?? 120),
    drive_minutes_to_airport:
      flight?.drive_minutes_to_airport != null ? String(flight.drive_minutes_to_airport) : "",
    seat: flight?.seat ?? "",
    notes: flight?.notes ?? "",
  });
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      await upsertFlight(tripId, {
        id: flight?.id,
        profile_id: form.profile_id || null,
        airline: form.airline.trim() || null,
        flight_number: form.flight_number.trim() || null,
        confirmation_code: form.confirmation_code.trim() || null,
        depart_airport: form.depart_airport.trim() || null,
        arrive_airport: form.arrive_airport.trim() || null,
        depart_at: zonedWallTimeToUtc(form.depart_wall, departTz),
        arrive_at: zonedWallTimeToUtc(form.arrive_wall, arriveTz),
        depart_timezone: departTz,
        arrive_timezone: arriveTz,
        minutes_before_departure: numOrNull(form.minutes_before_departure) ?? 120,
        drive_minutes_to_airport: numOrNull(form.drive_minutes_to_airport),
        seat: form.seat.trim() || null,
        notes: form.notes.trim() || null,
      });
      toastSuccess(flight ? "Flight updated" : "Flight added");
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
      title={flight ? "Edit flight" : "Add flight"}
      footer={
        <>
          <button className="button-like" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="button-like active-pill" style={{ marginLeft: "auto" }} onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <SelectField
        label="Who is this flight for?"
        value={form.profile_id}
        onChange={set("profile_id")}
        options={[
          { value: "", label: "Whole crew" },
          ...crew.map((m) => ({ value: m.profile_id, label: m.display_name ?? "Crew member" })),
        ]}
      />
      <FieldRow>
        <Field label="Airline" value={form.airline} onChange={set("airline")} placeholder="United" />
        <Field label="Flight #" value={form.flight_number} onChange={set("flight_number")} placeholder="UA123" />
      </FieldRow>
      <Field label="Confirmation code" value={form.confirmation_code} onChange={set("confirmation_code")} />
      <FieldRow>
        <Field label="From (airport)" value={form.depart_airport} onChange={set("depart_airport")} placeholder="DEN" />
        <Field label="To (airport)" value={form.arrive_airport} onChange={set("arrive_airport")} placeholder="SEA" />
      </FieldRow>
      <FieldRow>
        <Field label="Departs (local)" type="datetime-local" value={form.depart_wall} onChange={set("depart_wall")} />
        <SelectField label="Departure zone" value={departTz} onChange={setDepartTz} options={ZONE_OPTIONS} />
      </FieldRow>
      <FieldRow>
        <Field label="Arrives (local)" type="datetime-local" value={form.arrive_wall} onChange={set("arrive_wall")} />
        <SelectField label="Arrival zone" value={arriveTz} onChange={setArriveTz} options={ZONE_OPTIONS} />
      </FieldRow>
      <FieldRow>
        <Field
          label="Be at airport (min before)"
          type="number"
          value={form.minutes_before_departure}
          onChange={set("minutes_before_departure")}
          hint="120 domestic · 180 international"
        />
        <Field
          label="Drive to airport (min)"
          type="number"
          value={form.drive_minutes_to_airport}
          onChange={set("drive_minutes_to_airport")}
          hint="Used for the 'leave by' time"
        />
      </FieldRow>
      <Field label="Seat" value={form.seat} onChange={set("seat")} />
      <AreaField label="Notes" value={form.notes} onChange={set("notes")} />
    </Sheet>
  );
}
