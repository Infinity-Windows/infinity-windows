import { VoiceInput } from "../../components/voice/VoiceInput";
import { VoiceTextarea } from "../../components/voice/VoiceTextarea";
import { useT } from "../../lib/i18n";
import { useLanguage } from "../../lib/i18n/context";
import { observationFromDraft, type DimensionDraft } from "../../lib/workUnitObservations/model";
import { unitCreationObservation } from "../../lib/workUnitObservations/create";
import { useEffect, useState } from "react";
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
  requiredDimensions = false,
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
  requiredDimensions?: boolean;
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
  const { lang } = useLanguage();
  const c = lang === "es" ? {
    width: "Ancho", height: "Alto", units: "Unidad de medida", source: "Fuente de las medidas", choose: "Elegir fuente",
    measured: "Medido en obra", plans: "Medidas de planos", estimated: "Estimado", reference: "Referencia de la fuente (opcional)",
    in: "Pulgadas", ft: "Pies", mm: "Milímetros", cm: "Centímetros", save: "Guardar unidad",
    help: "Registra ancho, alto, unidad de medida y fuente. Guardar la unidad no inicia un temporizador.",
    estimate: "Esta estimación queda excluida de los promedios confiables hasta que se verifique.",
    identity: "Ingresa un número o nombre único para la unidad y elige su tipo.",
    invalid: "Ingresa ancho y alto positivos y elige la unidad de medida y la fuente.",
  } : {
    width: "Width", height: "Height", units: "Measurement unit", source: "Dimension source", choose: "Choose a source",
    measured: "Measured on site", plans: "Dimensions from plans", estimated: "Estimated", reference: "Source reference (optional)",
    in: "Inches", ft: "Feet", mm: "Millimeters", cm: "Centimeters", save: "Save unit",
    help: "Record width, height, units and source. Saving the unit does not start a timer.",
    estimate: "This estimate is excluded from trusted averages until verified.",
    identity: "Enter a distinct unit number or name and choose its type.",
    invalid: "Enter positive width and height, then choose measurement units and source.",
  };
  const [dimensions, setDimensions] = useState<DimensionDraft>({
    width: String(defaults?.facts.width_in ?? ""), height: String(defaults?.facts.height_in ?? ""), unit: "in",
    source: defaults?.facts.area_source === "From plans" ? "plans" : "", reference: "",
  });
  const [dimensionError, setDimensionError] = useState("");
  const [identityError, setIdentityError] = useState("");
  const [name, setName] = useState(unit?.label ?? label ?? "");
  const [job, setJob] = useState(
    unit ? (unit.project_id ?? "") : (jobId ?? ""),
  );
  // F1 (crew redesign, 2026-09-23): the job arrives AFTER this form is
  // already on screen when the shift resolves late (`shift?.project_id` is
  // asynchronous). The editor used to be remounted for it, which wiped
  // whatever had been typed. Now it stays mounted and the job fills in on
  // its own — but only while the field is still blank, so a job the person
  // chose by hand is never overwritten.
  useEffect(() => {
    if (!unit && jobId && !job) setJob(jobId);
    // `job` is read deliberately without being a dependency: this fills an
    // empty field once per new jobId and must not re-run on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, unit]);
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
  const completeChosen = !requiredDimensions && !recordOnly && facts.installation_complete === "Yes";
  const save = async (start: boolean) => {
    let observation;
    if (requiredDimensions) {
      try { observation = observationFromDraft(dimensions); setDimensionError(""); }
      catch { setDimensionError(c.invalid); return; }
    }
    if (requiredDimensions) {
      if (!name.trim() || !type.trim() || type.trim().toLowerCase() === "unknown" ||
          existingUnits?.some(u => u.project_id === job && u.label.trim().toLowerCase() === name.trim().toLowerCase())) {
        setIdentityError(c.identity); return;
      }
      setIdentityError("");
    }
    const value = {
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
      };
    await onSave(observation ? unitCreationObservation(value, observation) : value, requiredDimensions ? false : start);
  };
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
              disabled={requiredDimensions || recordOnly || !!unit?.opening_id || !!openingId}
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
        {identityError && <p role="alert" className="cw-error">{identityError}</p>}
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
        {requiredDimensions && <>
          <p className="cw-field-hint">{c.help}</p>
          <div className="cw-editor-grid cw-editor-facts">
            <label><span>{c.width}</span><input inputMode="decimal" value={dimensions.width} onChange={e => setDimensions(d => ({ ...d, width: e.target.value }))} /></label>
            <label><span>{c.height}</span><input inputMode="decimal" value={dimensions.height} onChange={e => setDimensions(d => ({ ...d, height: e.target.value }))} /></label>
            <label><span>{c.units}</span><select value={dimensions.unit} onChange={e => setDimensions(d => ({ ...d, unit: e.target.value as DimensionDraft["unit"] }))}>{(["in", "ft", "mm", "cm"] as const).map(u => <option key={u} value={u}>{c[u]}</option>)}</select></label>
            <label><span>{c.source}</span><select value={dimensions.source} onChange={e => setDimensions(d => ({ ...d, source: e.target.value as DimensionDraft["source"] }))}><option value="">{c.choose}</option>{(["measured", "plans", "estimated"] as const).map(source => <option key={source} value={source}>{c[source]}</option>)}</select></label>
            <label><span>{c.reference}</span><input value={dimensions.reference} maxLength={500} onChange={e => setDimensions(d => ({ ...d, reference: e.target.value }))} /></label>
          </div>
          {dimensions.source === "estimated" && <p className="cw-notice">{c.estimate}</p>}
          {dimensionError && <p role="alert" className="cw-error">{dimensionError}</p>}
        </>}
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
          {!requiredDimensions && field("width_in", "Frame width (inches)", undefined, true)}
          {!requiredDimensions && field("height_in", "Frame height (inches)", undefined, true)}
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
            {!requiredDimensions && field("area_source", "Measurement source", [
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
            {requiredDimensions ? c.save : recordOnly
              ? t("crewRecord.continue")
              : unit
                ? t("unitEditor.saveAndStart")
                : t("unitEditor.startThisUnit")}
          </button>
        )}
        {!requiredDimensions && !recordOnly && !completeChosen && <button disabled={busy} onClick={() => void save(false)}>
          Save details
        </button>}
        <button disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
