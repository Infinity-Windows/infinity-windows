import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import type { NewTripInput, Trip } from "../../lib/travel/types";
import { createTrip, deleteTrip, updateTrip } from "../../lib/travel/api";
import { listProfiles } from "../../lib/install/api";
import { listProjects } from "../../lib/api";
import { COMMON_TIMEZONES, guessTimezone } from "../../lib/travel/zones";
import { splitName } from "../../lib/travel/crewName";
import { toastError, toastSuccess } from "../../lib/toast";
import { useT } from "../../lib/i18n";
import { Sheet } from "./Sheet";
import { Field, FieldRow, SelectField, AreaField, CheckBox } from "./Field";

const ZONE_OPTIONS = COMMON_TIMEZONES.map((z) => ({ value: z.id, label: z.label }));

export function TripEditor({
  trip,
  defaults,
  onClose,
  onSaved,
  onDeleted,
}: {
  trip: Trip | null;
  /** Prefill for a brand-new trip (e.g. from a scheduled crew block). */
  defaults?: Partial<NewTripInput>;
  onClose: () => void;
  onSaved: (trip: Trip) => void;
  onDeleted: () => void;
}) {
  const t = useT();
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: listProfiles });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });

  const [zone, setZone] = useState(trip?.timezone ?? defaults?.timezone ?? guessTimezone());
  const [projectId, setProjectId] = useState(trip?.project_id ?? defaults?.project_id ?? "");
  const [crew, setCrew] = useState<Set<string>>(
    () => new Set((trip?.crew ?? defaults?.crew ?? []).map((m) => m.profile_id)),
  );
  const [form, setForm] = useState({
    name: trip?.name ?? defaults?.name ?? "",
    destination: trip?.destination ?? defaults?.destination ?? "",
    start_date: trip?.start_date ?? defaults?.start_date ?? "",
    end_date: trip?.end_date ?? defaults?.end_date ?? "",
    notes: trip?.notes ?? defaults?.notes ?? "",
  });
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  const roster = useMemo(
    () =>
      (profiles.data ?? [])
        .filter((p) => p.active)
        // listProfiles() hands back role first (owners, then supervisors, then
        // installers, then foreman — `order("role", desc)`) and only then name.
        // That is right for the roster screen, where the rank is printed beside
        // every row. Here there is no rank on screen at all, just a grid of
        // names, and a supervisor picking Antonio out of thirty people hunts
        // alphabetically. Sorted HERE, not in the api module: every other picker
        // that reads listProfiles() keeps the order it already has.
        .sort((a, b) => a.display_name.localeCompare(b.display_name)),
    [profiles.data],
  );

  const toggleCrew = (id: string) =>
    setCrew((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const save = async () => {
    if (!form.name.trim()) return toastError(null, "Give the trip a name");
    if (!form.start_date || !form.end_date) return toastError(null, "Pick start and end dates");
    if (form.end_date < form.start_date) return toastError(null, "End date can't be before start");
    setSaving(true);
    try {
      const members = [...crew].map((id) => {
        const p = roster.find((r) => r.id === id);
        return { profile_id: id, role: p?.role ?? "crew" };
      });
      const payload = {
        name: form.name.trim(),
        destination: form.destination.trim() || null,
        start_date: form.start_date,
        end_date: form.end_date,
        timezone: zone,
        notes: form.notes.trim() || null,
        project_id: projectId || null,
        crew: members,
      };
      const saved = trip ? await updateTrip(trip.id, payload) : await createTrip(payload);
      toastSuccess(trip ? "Trip updated" : "Trip created");
      onSaved(saved);
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!trip) return;
    if (!confirm("Delete this trip and everything in it?")) return;
    setSaving(true);
    try {
      await deleteTrip(trip.id);
      toastSuccess("Trip deleted");
      onDeleted();
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
      title={trip ? "Edit trip" : "New trip"}
      footer={
        <>
          {trip && (
            <button className="button-like travel-danger" onClick={remove} disabled={saving}>
              <Trash2 size={15} aria-hidden /> Delete
            </button>
          )}
          <button className="button-like" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="button-like active-pill" style={{ marginLeft: "auto" }} onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <Field label="Trip name" value={form.name} onChange={set("name")} placeholder="Seattle install" />
      <Field label="Destination" value={form.destination} onChange={set("destination")} placeholder="Seattle, WA" />
      <FieldRow>
        <Field label="Start date" type="date" value={form.start_date} onChange={set("start_date")} />
        <Field label="End date" type="date" value={form.end_date} onChange={set("end_date")} />
      </FieldRow>
      <SelectField label="Home timezone" value={zone} onChange={setZone} options={ZONE_OPTIONS} />
      <SelectField
        label="Linked job (optional)"
        value={projectId}
        onChange={setProjectId}
        options={[
          { value: "", label: "None" },
          ...(projects.data ?? []).map((p) => ({
            value: p.id,
            label: p.job_code ? `${p.job_code} — ${p.name}` : p.name,
          })),
        ]}
      />

      <div className="travel-field">
        <span className="travel-field-label" data-testid="travel-crew-label">
          {crew.size === 0
            ? t("travel.crew.label")
            : crew.size === 1
              ? t("travel.crew.labelCount.one", { n: 1 })
              : t("travel.crew.labelCount.many", { n: crew.size })}
        </span>
        <div className="travel-crew-picker" data-testid="travel-crew-picker">
          {roster.length === 0 ? (
            <span className="muted travel-crew-empty">{t("travel.crew.empty")}</span>
          ) : (
            roster.map((p) => {
              const { first, rest } = splitName(p.display_name);
              return (
                <label
                  key={p.id}
                  className={`travel-crew-chip${crew.has(p.id) ? " is-on" : ""}`}
                  data-testid="travel-crew-chip"
                >
                  <input type="checkbox" checked={crew.has(p.id)} onChange={() => toggleCrew(p.id)} />
                  <CheckBox />
                  {/* title, because two lines is the most a chip shows and a
                      long name is clipped rather than allowed to resize it. */}
                  <span className="travel-crew-name" title={p.display_name}>
                    <span className="travel-crew-first">{first}</span>
                    {rest ? ` ${rest}` : ""}
                  </span>
                </label>
              );
            })
          )}
        </div>
      </div>

      <AreaField label="Notes" value={form.notes} onChange={set("notes")} />
    </Sheet>
  );
}
