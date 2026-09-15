import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listProjectsAnyStatus } from "../../lib/api";
import { listProfiles } from "../../lib/install/api";
import type { WorkFacts, WorkType, WorkUnit } from "../../lib/customWork/model";

export function UnitEditor({
  unit,
  jobId,
  openingId,
  label,
  defaults,
  existingUnits,
  types,
  busy,
  onSave,
  onCancel,
}: {
  unit?: WorkUnit;
  jobId?: string | null;
  openingId?: string | null;
  label?: string;
  defaults?: { type: string; facts: WorkFacts };
  existingUnits?: WorkUnit[];
  types: WorkType[];
  busy: boolean;
  onSave: (value: Record<string, unknown>, start: boolean) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(unit?.label ?? label ?? "");
  const [job, setJob] = useState(
    unit ? (unit.project_id ?? "") : (jobId ?? ""),
  );
  const [type, setType] = useState(
    unit?.type_label ?? defaults?.type ?? "Unknown",
  );
  const [facts, setFacts] = useState<WorkFacts>(
    unit?.facts ?? defaults?.facts ?? {},
  );
  const [reason, setReason] = useState("");
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: listProjectsAnyStatus,
  });
  const crew = useQuery({
    queryKey: ["customWorkRoster"],
    queryFn: listProfiles,
  });
  const set = (key: keyof WorkFacts, value: string, number = false) =>
    setFacts((old) => {
      const next = { ...old };
      if (value === "") delete next[key];
      else Object.assign(next, { [key]: number ? Number(value) : value });
      return next;
    });
  const field = (
    key: keyof WorkFacts,
    title: string,
    options?: string[],
    number = false,
  ) => (
    <label key={key}>
      {title}
      {options ? (
        <select
          value={facts[key] ?? ""}
          onChange={(e) => set(key, e.target.value)}
        >
          <option value="">Unknown</option>
          {options.map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      ) : (
        <input
          type={number ? "number" : "text"}
          inputMode={number ? "decimal" : undefined}
          min={number ? 0 : undefined}
          step={number ? "any" : undefined}
          value={facts[key] ?? ""}
          onChange={(e) => set(key, e.target.value, number)}
        />
      )}
    </label>
  );
  const save = (start: boolean) =>
    onSave(
      {
        id: unit?.id ?? crypto.randomUUID(),
        revision: unit?.revision ?? 0,
        project_id: job || null,
        opening_id: unit?.opening_id ?? openingId ?? null,
        label:
          name.trim() ||
          `Field unit ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
        type_label: type.trim() || "Unknown",
        facts,
        reason: reason || (!unit ? "Field capture" : ""),
      },
      start,
    );
  return (
    <section className="cw-card" aria-label="Unit details">
      <h2>{unit ? "Edit unit" : "Start a unit"}</h2>
      <p className="muted">
        A number and type are enough. Missing details can be filled in later.
      </p>
      <div className="cw-grid">
        <label>
          Unit number / name
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="16 — or leave for a temporary name"
            maxLength={120}
          />
        </label>
        <label>
          Type
          <input
            list="work-types"
            value={type}
            onChange={(e) => setType(e.target.value)}
            placeholder="Choose or type your own"
            maxLength={100}
          />
          <datalist id="work-types">
            {types
              .filter((t) => !t.archived)
              .map((t) => (
                <option key={t.id} value={t.label} />
              ))}
          </datalist>
        </label>
        <label>
          Job
          <select
            value={job}
            onChange={(e) => setJob(e.target.value)}
            disabled={!!unit?.opening_id || !!openingId}
          >
            <option value="">Assign job later</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {(unit?.project_id ?? null) !== (job || null) && unit && (
        <label>
          Assignment reason
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Correct job / linking field capture"
          />
        </label>
      )}
      {!unit &&
        existingUnits?.some(
          (u) =>
            u.project_id === (job || null) &&
            u.label.toLowerCase() === name.trim().toLowerCase(),
        ) && (
          <p className="cw-notice">
            A unit with this number already exists on this job. If it is the
            same window, cancel and choose Start / Join on its existing record.
            If this is a different window, add its building or floor to the
            name.
          </p>
        )}
      {defaults && !unit && (
        <p className="muted">
          Available type and dimensions came from the selected map unit. Confirm
          or change them here; the office record stays unchanged.
        </p>
      )}
      <details open={!!unit}>
        <summary>Size, location, helpers, and conditions</summary>
        <div className="cw-grid">
          {field("width_in", "Outside-frame width (inches)", undefined, true)}
          {field("height_in", "Outside-frame height (inches)", undefined, true)}
          {field("area_source", "Measurement source", [
            "Measured",
            "From plans",
            "Estimated",
          ])}
          {field(
            "installation_complete",
            "Entire unit installation complete (all visits)",
            ["Yes", "No"],
          )}
          {field("story", "Story / floor (1, 2, 3, basement…)")}
          {field("location", "Building / area / location")}
          {field("material", "Frame material", [
            "Vinyl",
            "Aluminum",
            "Wood",
            "Fiberglass",
            "Steel",
            "Mixed",
            "Other",
          ])}
          {field("weight_lb", "Approximate unit weight (lb)", undefined, true)}
          {field("electrical", "Electrical components", ["Yes", "No"])}
          {field("complexity", "Complexity", ["Simple", "Custom"])}
          {field("access", "Access", ["Easy", "Difficult"])}
          {field("equipment_needed", "Vehicle / equipment needed", [
            "Yes",
            "No",
          ])}
          {field("equipment", "Vehicle / equipment description")}
          {field(
            "equipment_minutes",
            "Equipment use (minutes for this unit)",
            undefined,
            true,
          )}
        </div>
        <label>
          People helping — names
          <input
            list="work-crew"
            value={facts.named_helpers ?? ""}
            onChange={(e) => set("named_helpers", e.target.value)}
            placeholder="Select or type names; separate with commas"
          />
          <datalist id="work-crew">
            {crew.data?.map((p) => (
              <option key={p.id} value={p.display_name ?? ""} />
            ))}
          </datalist>
        </label>
        <p className="muted">
          Names are notes. Each helper taps Join on this unit to record their
          own time.
        </p>
        <label>
          Unit description / access details
          <textarea
            value={facts.note ?? ""}
            onChange={(e) => set("note", e.target.value)}
            placeholder="What makes this window or door different?"
            maxLength={4000}
          />
        </label>
      </details>
      <div className="cw-actions">
        <button
          className="primary"
          disabled={busy}
          onClick={() => void save(true)}
        >
          {unit ? "Save and start" : "Start this unit"}
        </button>
        <button disabled={busy} onClick={() => void save(false)}>
          Save details
        </button>
        <button disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
