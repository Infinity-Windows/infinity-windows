import { VoiceInput } from "../../components/voice/VoiceInput";
import { VoiceTextarea } from "../../components/voice/VoiceTextarea";
import { useT } from "../../lib/i18n";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listProjectsAnyStatus } from "../../lib/api";
import { listProfiles } from "../../lib/install/api";
import { FACT_LABELS, factText, type WorkFacts, type WorkType, type WorkUnit } from "../../lib/customWork/model";

type ScalarFact = Exclude<keyof WorkFacts, "components" | "unknown_fields">;
/** Captured facts this editor has no input for; shown so they are not invisible. */
const CAPTURED_ONLY = ["components", "opening_direction", "direction_viewpoint", "measurement_source", "unknown_fields"] as const;

export function UnitEditor({
  unit,
  recordOnly = false,
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
  recordOnly?: boolean;
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
  const t = useT();
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
  // Every other fact (components, direction, spoken size, "said unknown") rides
  // along untouched in `facts`, so saving here never drops what Forge AI captured.
  const set = (key: ScalarFact, value: string, number = false) =>
    setFacts((old) => {
      const next = { ...old };
      if (value === "") delete next[key];
      else Object.assign(next, { [key]: number ? Number(value) : value });
      // Answering a question the worker had marked unknown clears that mark.
      if (value !== "" && next.unknown_fields?.includes(key)) {
        const rest = next.unknown_fields.filter((k) => k !== key);
        if (rest.length) next.unknown_fields = rest;
        else delete next.unknown_fields;
      }
      return next;
    });
  const field = (
    key: ScalarFact,
    title: string,
    options?: string[],
    number = false,
  ) => (
    <label key={key}>
      <span>{title}</span>
      {options ? (
        <select
          value={facts[key] ?? ""}
          onChange={(e) => set(key, e.target.value)}
        >
          <option value="">
            {facts.unknown_fields?.includes(key) ? "Unknown (said unknown)" : "Unknown"}
          </option>
          {options.map((x) => (
            <option key={x}>{x}</option>
          ))}
          {/* A value outside the list (e.g. a material said to Forge AI) stays
              visible and selected instead of silently reading as Unknown. */}
          {facts[key] !== undefined &&
            facts[key] !== "" &&
            !options.includes(String(facts[key])) && (
              <option value={String(facts[key])}>{String(facts[key])}</option>
            )}
        </select>
      ) : (
        <VoiceInput
          voiceDisabled={key !== "equipment"}
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
  // "Save and start" after choosing Yes used to save the Yes and then start a
  // new visit, and a new visit reopens completion (custom_work_command
  // 'start') — so no unit ever stayed complete (2026-09-24). With Yes chosen
  // the only save is a plain one.
  const completeChosen = !recordOnly && facts.installation_complete === "Yes";
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
    <section className="cw-card cw-editor" aria-label="Unit details">
      <header className="cw-editor-heading">
        <h2>{recordOnly ? t("crewRecord.unitDetails") : unit ? "Edit unit" : "Start a unit"}</h2>
        <p className="muted">Capture what you know. You can fill in more later.</p>
      </header>
      <section className="cw-editor-section" aria-label="Necessary information">
        <div className="cw-section-heading">
          <span className="cw-section-number" aria-hidden="true">
            1
          </span>
          <h3>Necessary information</h3>
        </div>
        <div className="cw-editor-grid cw-editor-identity">
          <label>
            <span>Unit number / name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. 16"
              maxLength={120}
            />
          </label>
          <label>
            <span>Type</span>
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
            <span>Job</span>
            <select
              value={job}
              onChange={(e) => setJob(e.target.value)}
              disabled={recordOnly || !!unit?.opening_id || !!openingId}
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
            <VoiceInput
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
        {!recordOnly && (
          <div className="cw-editor-complete">
            {field("installation_complete", t("unitEditor.installComplete"), ["Yes", "No"])}
            <p className="cw-field-hint">{t("unitEditor.completeHint")}</p>
          </div>
        )}
        {defaults && !unit && (
          <p className="muted">
            Available type and dimensions came from the selected map unit. Confirm
            or change them here; the office record stays unchanged.
          </p>
        )}
        <div className="cw-editor-grid cw-editor-facts">
          {field("material", "Frame material", [
            "Vinyl",
            "Aluminum",
            "Wood",
            "Fiberglass",
            "Steel",
            "Mixed",
            "Other",
          ])}
          {field("story", "Floor / story")}
          {field("width_in", "Frame width (inches)", undefined, true)}
          {field("height_in", "Frame height (inches)", undefined, true)}
          {field("electrical", "Electrical components", ["Yes", "No"])}
          {field("equipment_needed", "Machinery needed", ["Yes", "No"])}
          {field("access", "Access", ["Easy", "Difficult"])}
          {field("complexity", "Complexity", ["Simple", "Custom"])}
        </div>
        <p className="cw-field-hint">
          Measure the outside of the frame. Ground floor is story 1.
        </p>
        {CAPTURED_ONLY.some((k) => facts[k] !== undefined) && (
          <dl className="cw-facts" aria-label="Also recorded">
            {CAPTURED_ONLY.filter((k) => facts[k] !== undefined).map((k) => (
              <div key={k}>
                <dt>{FACT_LABELS[k]}</dt>
                <dd>{factText(k, facts[k])}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
      <details className="cw-editor-helpful">
        <summary>
          <span className="cw-section-number" aria-hidden="true">
            2
          </span>
          <span className="cw-helpful-title">
            <span>Helpful information</span>
            <span className="cw-field-hint">
              Optional · location, helpers, machinery time & notes
            </span>
          </span>
          <span className="cw-section-chevron" aria-hidden="true" />
        </summary>
        <div className="cw-helpful-body">
          <div className="cw-editor-grid">
            {field("location", "Building / area / location")}
            {field("weight_lb", "Approximate weight (lb)", undefined, true)}
            {field("area_source", "Measurement source", [
              "Measured",
              "From plans",
              "Estimated",
            ])}
            {field("equipment", "Machinery / vehicle description")}
            {field(
              "equipment_minutes",
              "Machinery use (minutes)",
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
          <p className="cw-field-hint">
            Each helper taps Join on this unit to record their own time.
          </p>
          <label>
            Unit description / access details
            <VoiceTextarea
              value={facts.note ?? ""}
              onChange={(e) => set("note", e.target.value)}
              placeholder="What makes this window or door different?"
              maxLength={4000}
            />
          </label>
        </div>
      </details>
      <div className="cw-actions cw-editor-actions">
        {completeChosen ? (
          <button className="primary" disabled={busy} onClick={() => void save(false)}>
            {t("unitEditor.saveComplete")}
          </button>
        ) : (
          <button
            className="primary"
            disabled={busy || (recordOnly && !name.trim())}
            onClick={() => void save(!recordOnly)}
          >
            {recordOnly ? t("crewRecord.continue") : unit ? "Save and start" : "Start this unit"}
          </button>
        )}
        {!recordOnly && !completeChosen && <button disabled={busy} onClick={() => void save(false)}>
          Save details
        </button>}
        <button disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
