import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { unitNumberTaken } from "../../lib/installerWorkflow/queuedUnits";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, X } from "lucide-react";
import { Link } from "react-router-dom";
import { useLanguage, useT } from "../../lib/i18n";
import { listMarkSpecs } from "../../lib/install/api";
import { buildFactsKey, getBuildFacts, SET_DEPTH_KEYS, SET_DEPTHS } from "../../lib/install/buildFacts";
import { formatApiError } from "../../lib/install/errors";
import { DimensionFields } from "./DimensionFields";
import { formatInchesMm, MM_PER_INCH } from "../../lib/install/dimensionEntry";
import { indexSpecsByMark, specForOpeningCode } from "../../lib/install/specs";
import type { ProjectOpening } from "../../lib/install/types";
import { isUnitKind, trainingDrawing, UNIT_KINDS, unitFloor, unitKindLabel, unitSourceMark, type UnitDetails as Details, type UnitDetailsWrite } from "../../lib/install/unitDetails";
import { refreshUnitDetails, saveUnitDetails } from "../../lib/install/unitDetailsApi";
import { unitPicture } from "../../lib/install/unitDefinitionDiagram";
import { UnitKindIcon } from "./UnitKindIcon";
import { specInsetOutsetOf } from "../../lib/install/unitFactsCard";
import { catalogByMarkFrom, resolveMarkConfig } from "../../lib/modelstudio/fromProject";
import { listStudioUnits, unitWidthMm } from "../../lib/modelstudio/units";
import type { UnitActivityState } from "../../lib/installerWorkflow/unitState";
import type { LastFinishedActivity } from "../../lib/installerWorkflow/unitProgress";
import { activityLabel } from "../../pages/installerPilot/workdayActivities";
import { supabase } from "../../lib/supabase";
import { isNetworkError } from "../../lib/offline/outbox-core";
import "./unitDetails.css";

const length = (inches: number | null | undefined) => inches == null ? "—" : formatInchesMm(inches * MM_PER_INCH) || "—";
const dimensions = (width: number | null | undefined, height: number | null | undefined) =>
  width != null || height != null ? `${length(width)} × ${length(height)}` : null;

function drawingSize(size: string) {
  return size.replace(/([\d.]+) × ([\d.]+) mm/g, (_, width, height) =>
    dimensions(Number(width) / 25.4, Number(height) / 25.4) ?? "");
}

export function UnitDetailsDialog({ title, subtitle, onClose, children }: {
  title: string;
  /** The activity this unit was opened for, shown under its number. */
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { lang } = useLanguage();
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return <dialog ref={ref} className="ws-agenda-unit-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="ws-agenda-unit-panel">
      <header>
        <div><h2 id={titleId}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
        <button type="button" className="ws-agenda-unit-close"
          aria-label={lang === "es" ? "Cerrar detalles" : "Close unit details"} onClick={onClose}><X size={18} /></button>
      </header>
      {children}
    </div>
  </dialog>;
}

export function UnitCompletion({ complete }: { complete?: boolean }) {
  const { lang } = useLanguage();
  return complete ? <p className="ws-agenda-unit-stamp" role="status"><Check size={14} aria-hidden="true" />
    {lang === "es" ? "Unidad completa" : "Unit complete"}</p> : null;
}

export function UnitActivityStatus({ status, unavailable }: {
  status?: UnitActivityState;
  unavailable?: boolean;
}) {
  const { lang } = useLanguage();
  const es = lang === "es";
  const labels = {
    complete: es ? "Terminado" : "Complete",
    running: es ? "En curso" : "Running",
    blocked: es ? "Bloqueado" : "Blocked",
    rework: es ? "Rehacer" : "Rework",
    "in-progress": es ? "Iniciado" : "In progress",
    "not-started": es ? "Sin iniciar" : "Not started",
  };
  return <span role="status" className="ws-agenda-unit-status" data-status={status}>
    {status ? labels[status] : unavailable ? (es ? "No disponible" : "Unavailable") : (es ? "Cargando…" : "Loading…")}
  </span>;
}

/** The display names of the people on a unit. Pass the ids sorted, so screens asking for the same people share one read. */
export function useProfileNames(ids: readonly string[]) {
  return useQuery({
    queryKey: ["work-agenda-crew", ids],
    enabled: ids.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase.from("profiles").select("id,display_name").in("id", [...ids]);
      if (error) throw error;
      return new Map(data.map(person => [person.id, person.display_name]));
    },
  });
}

/** The activity finished most recently on a unit, as a row of a facts list. */
function UnitLastFinished({ lastDone }: { lastDone?: LastFinishedActivity }) {
  const { lang } = useLanguage();
  const es = lang === "es";
  return lastDone ? <>
    <dt>{es ? "Última terminada" : "Last finished"}</dt>
    <dd>{activityLabel(lastDone.activity, es)} · {new Date(lastDone.at).toLocaleString(es ? "es" : "en",
      { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</dd>
  </> : null;
}

/** For a unit opened on its own, with no activity in hand: just what was
 * finished on it last. Nothing at all until something has been. */
export function UnitLastFinishedFact({ lastDone }: { lastDone?: LastFinishedActivity }) {
  return lastDone ? <dl className="ws-agenda-unit-crew"><UnitLastFinished lastDone={lastDone} /></dl> : null;
}

/**
 * Who is on an activity for one unit and how far along it is: the same three
 * rows wherever a unit is opened. Workday used to put the status above the
 * unit's details and the lead in a sentence of its own.
 */
export function UnitActivityFacts({ status, unavailable, lastDone, leadId, crewIds, profileId, children }: {
  /** undefined while the unit's work is still loading. */
  status?: UnitActivityState;
  unavailable?: boolean;
  /** The activity finished most recently on this unit, whichever it was; left
   * out until something has been finished. */
  lastDone?: LastFinishedActivity;
  leadId?: string;
  crewIds: readonly string[];
  /** The person looking, shown as "You". */
  profileId: string;
  /** An action that belongs with the lead, such as taking it. */
  children?: ReactNode;
}) {
  const { lang } = useLanguage();
  const es = lang === "es";
  const crew = [...new Set(crewIds)].filter(id => id !== leadId);
  const others = [...new Set([...crew, ...(leadId ? [leadId] : [])])].filter(id => id !== profileId).sort();
  const people = useProfileNames(others);
  const name = (id: string, fallback: string) => id === profileId ? (es ? "Tú" : "You") : people.data?.get(id) || fallback;
  return <dl className="ws-agenda-unit-crew">
    <dt>{es ? "Estado de actividad" : "Activity status"}</dt>
    <dd><UnitActivityStatus status={status} unavailable={unavailable} /></dd>
    <UnitLastFinished lastDone={lastDone} />
    <dt>{es ? "A cargo" : "Lead"}</dt>
    <dd className="ws-agenda-unit-lead"><span>{leadId ? name(leadId, es ? "Responsable asignado" : "Assigned lead") : "—"}</span>{children}</dd>
    <dt>{es ? "Equipo" : "Crew"}</dt>
    <dd>{crew.length ? crew.map(id => name(id, es ? "Instalador asignado" : "Assigned installer")).join(", ") : "—"}</dd>
  </dl>;
}

export function UnitDetailsPanel({ projectId, opening, onCreated, createOffline }: {
  projectId: string;
  opening?: ProjectOpening;
  onCreated?: (id: string) => void;
  /** Where a new unit is kept when there is no signal. Workday passes its work
   * queue, so the unit can be clocked on at once; without it, creating a unit
   * still needs a connection. */
  createOffline?: (write: UnitDetailsWrite) => Promise<void>;
}) {
  const { lang } = useLanguage(), t = useT();
  const text = (en: string, es: string) => lang === "es" ? es : en;
  const client = useQueryClient();
  const typeId = useId();
  const numberId = useId();
  const numberInput = useRef<HTMLInputElement>(null);
  const [textKeyboard, setTextKeyboard] = useState(false);
  const [draft, setDraft] = useState<{ code: string; details: Details }>();
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<UnitDetailsWrite>();
  const [refused, setRefused] = useState<string | null>();
  const [retryId] = useState(() => crypto.randomUUID());
  const [base, setBase] = useState<{ code: string; details: Details }>();
  useEffect(() => {
    if (!opening?.id) return;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void import("../../lib/offline/outbox").then(({ listMine, subscribe }) => {
      if (!active) return;
      const refresh = () => { void listMine().then(entries => {
        if (!active) return;
        const mine = entries.filter(row => row.op === "save_unit_details" && row.payload.id === opening.id);
        const entry = mine.find(row => row.status !== "failed");
        setPending(entry?.payload as UnitDetailsWrite | undefined);
        // A refused edit stops being "waiting to sync", so the panel goes back
        // to the saved values. Without a word here that looks like the edit
        // vanished; the person only learned otherwise if they opened /stuck.
        const failed = mine.find(row => row.status === "failed");
        setRefused(failed ? failed.lastError ?? "" : undefined);
      }).catch(() => undefined); };
      unsubscribe = subscribe(refresh);
      refresh();
    }).catch(() => undefined);
    return () => { active = false; unsubscribe?.(); };
  }, [opening?.id]);

  const details = pending?.details ?? opening?.unit_details ?? {};
  const row = opening && { ...opening, unit_details: details };
  const mark = row && unitSourceMark(row);
  const specs = useQuery({ queryKey: ["markSpecs", projectId], queryFn: () => listMarkSpecs(projectId), enabled: !!mark });
  const catalog = useQuery({ queryKey: ["studioUnits"], queryFn: listStudioUnits, enabled: !!mark });
  const buildFacts = useQuery({ queryKey: buildFactsKey(projectId), queryFn: () => getBuildFacts(projectId), enabled: !!opening });
  const index = indexSpecsByMark(specs.data ?? []);
  const spec = mark ? specForOpeningCode(index, mark) : null;
  const resolved = mark ? resolveMarkConfig(mark, index, catalogByMarkFrom(catalog.data ?? [])) : null;
  const config = resolved && (!details.kind || details.kind === resolved.kind) ? resolved : null;
  const diagram = unitPicture(details, resolved, 110, 80);
  const kind = details.kind ?? resolved?.kind;
  const type = kind ? unitKindLabel(kind, lang === "es") : null;
  const typeLabel = details.kind ? type : spec?.style || opening?.window_types?.name || type;
  const drawing = row && trainingDrawing(row);
  const floor = row && unitFloor(row);
  const material = details.material === undefined ? drawing?.material ?? (
    typeof spec?.extra?.material === "string" ? spec.extra.material : null
  ) : details.material;
  const unitInset = details.inset === undefined ? specInsetOutsetOf(spec?.extra) : details.inset;
  const jobDepths = new Set(buildFacts.data?.exterior_lines.map(line => line.set_depth));
  const jobInset = jobDepths.size === 1 ? [...jobDepths][0] : null;
  const inset = unitInset ?? (details.inset === undefined ? jobInset : null);
  const hasSizeEdit = details.width !== undefined || details.height !== undefined;
  const basisLabel = (basis: Details["basis"]) => basis === "unit" ? text("Outside frame", "Exterior del marco")
    : basis === "rough" ? text("Rough opening", "Vano de obra")
    : basis === "drawing" ? text("Drawing size", "Medida del plano") : text("Measurement basis unknown", "Base de medida sin especificar");
  const recordedSize = dimensions(details.width, details.height);
  const rough = dimensions(opening?.ro_width_in, opening?.ro_height_in);
  const catalogSize = dimensions(opening?.window_types?.width_in, opening?.window_types?.height_in);
  const specSize = dimensions(spec?.width_in, spec?.height_in);
  const modelSize = config && dimensions(unitWidthMm(config) / 25.4, config.heightMm / 25.4);
  const sizes = hasSizeEdit
    ? recordedSize ? [`${recordedSize} · ${basisLabel(details.basis)}`] : []
    : drawing ? drawing.sizes.map(size => `${drawingSize(size)} · ${basisLabel("drawing")}`)
    : specSize ? [`${specSize} · ${text("Manufacturer spec", "Ficha del fabricante")}`]
    : catalogSize ? [`${catalogSize} · ${text("Catalog size", "Medida de catálogo")}`]
    : modelSize ? [`${modelSize} · ${text("Studio model", "Modelo de Studio")}`] : [];
  if (rough && (!hasSizeEdit || details.basis !== "rough")) sizes.push(`${rough} · ${basisLabel("rough")}`);
  const number = pending?.code ?? opening?.opening_code ?? "";
  const form = draft ?? (!opening ? { code: "", details: { placeholder: true } as Details } : undefined);
  const update = (patch: Details) => form && setDraft({ ...form, details: { ...form.details, ...patch } });
  const startEdit = () => {
    if (!opening) return;
    setReason("");
    setBase({ code: opening.opening_code, details: opening.unit_details ?? {} });
    setDraft({ code: number, details });
    setError("");
  };
  const save = async () => {
    if (!form || busy) return;
    const code = form.code.trim();
    if (!code) { setError(text("Enter a unit number.", "Ingresa un número de unidad.")); return; }
    const write: UnitDetailsWrite = {
      editId: opening ? crypto.randomUUID() : retryId,
      reason: reason.trim() || undefined,
      id: opening?.id ?? retryId, projectId, create: !opening, code,
      details: { ...form.details, ...(opening && code !== base?.code && mark ? { sourceMark: mark } : {}) },
      previousCode: base?.code ?? null, previousDetails: base?.details ?? {},
    };
    setBusy(true);
    setError("");
    try {
      if (!opening) {
        // Every unit on the job is already on the phone, so a repeated number
        // is caught here, with or without signal.
        const known = client.getQueryData<ProjectOpening[]>(["openings", projectId]) ?? [];
        if (unitNumberTaken(known, code))
          throw new Error(text(`Unit ${code} is already on this job. Find it in the list.`, `La unidad ${code} ya está en esta obra. Búscala en la lista.`));
        if (!navigator.onLine) {
          if (!createOffline) throw new Error(text("Connect to create a placeholder.", "Conéctate para crear una unidad provisional."));
          await createOffline(write);
          setDraft(undefined);
          onCreated?.(write.id);
          return;
        }
      }
      let applied: boolean;
      try {
        if (!navigator.onLine) throw new TypeError("Failed to fetch");
        applied = await saveUnitDetails(write);
      } catch (error) {
        if (write.create || !isNetworkError(error)) throw error;
        const { enqueue } = await import("../../lib/offline/outbox");
        await enqueue({ op: "save_unit_details", payload: write });
        setPending(write);
        setDraft(undefined);
        return;
      }
      await refreshUnitDetails(client, write, applied);
      setDraft(undefined);
      if (write.create) onCreated?.(write.id);
    } catch (error) {
      setError(formatApiError(error));
    } finally { setBusy(false); }
  };
  return <div className="unit-details">
    {opening && <>
      <div className="ws-agenda-unit-overview">
        <div className="ws-agenda-unit-top">
          <span className="ws-agenda-unit-diagram">{diagram
            ? <img alt={text("Unit configuration", "Configuración de unidad")} src={`data:image/svg+xml,${encodeURIComponent(diagram)}`} />
            : <UnitKindIcon kind={kind} size={27} />}</span>
          {/* An icon, not a text link: the link sat between the specs and the
              status rows and read as one of them (Matt, 2026-11-20). */}
          {!form && !pending && <button type="button" className="ws-agenda-unit-edit" aria-label={text("Edit unit", "Editar unidad")}
            title={text("Edit unit", "Editar unidad")} onClick={startEdit}><Pencil size={16} aria-hidden="true" /></button>}
        </div>
        <dl className="ws-agenda-unit-specs">
          <dt>{text("Unit number", "Número de unidad")}</dt><dd>{number}{details.placeholder && ` · ${text("Placeholder", "Provisional")}`}</dd>
          <dt>{text("Type", "Tipo")}</dt><dd>{typeLabel ?? "—"}{drawing && ` · ${drawing.catalog}`}</dd>
          {details.configuration && <><dt>{text("Configuration", "Configuración")}</dt><dd>{details.configuration}</dd></>}
          <dt>{text("Width × height", "Ancho × alto")}</dt><dd>{sizes.length ? sizes.map(size => <div key={size}>{size}</div>) : "—"}</dd>
          <dt>{text("Floor", "Piso")}</dt><dd>{floor?.replace(/^Level /, text("Level ", "Nivel ")) ?? "—"}</dd>
          <dt>{text("Inset/outset", "Retranqueo/saliente")}</dt><dd>{inset ? t(SET_DEPTH_KEYS[inset]) : "—"}
            {inset && !unitInset && ` · ${text("Job default", "Valor del proyecto")}`}</dd>
          {material && <><dt>{text("Material", "Material")}</dt><dd>{material}</dd></>}
        </dl>
      </div>
      {pending && <p role="status">{text("Unit changes waiting to sync", "Cambios pendientes de sincronizar")}</p>}
      {refused !== undefined && !pending && <p role="alert">
        {text("Your last change to this unit was not saved.", "Tu último cambio a esta unidad no se guardó.")}
        {refused && ` ${refused}`}{" "}
        <Link to="/stuck">{text("Review it", "Revísalo")}</Link>
      </p>}
    </>}
    {form && <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={busy}>
        <div className="unit-details-select unit-details-number">
          <label htmlFor={numberId}>{text("Unit number", "Número de unidad")}</label>
          <div className="unit-details-number-entry">
            <input id={numberId} ref={numberInput} required inputMode={textKeyboard ? "text" : "numeric"}
              autoCapitalize="characters" autoComplete="off" spellCheck={false}
              value={form.code} onChange={event => setDraft({ ...form, code: event.target.value })} />
            <button type="button" aria-label={text("Insert dash", "Insertar guion")}
              onMouseDown={event => event.preventDefault()} onClick={() => {
                const input = numberInput.current;
                if (!input) return;
                const start = input.selectionStart ?? form.code.length;
                const end = input.selectionEnd ?? start;
                input.focus();
                setDraft({ ...form, code: form.code.slice(0, start) + "-" + form.code.slice(end) });
                requestAnimationFrame(() => input.setSelectionRange(start + 1, start + 1));
              }}>-</button>
            <button type="button" aria-label={textKeyboard ? text("Use number keyboard", "Usar teclado numérico") : text("Use letter keyboard", "Usar teclado de letras")}
              onClick={() => { setTextKeyboard(!textKeyboard); numberInput.current?.focus(); }}>
              {textKeyboard ? "123" : "ABC"}
            </button>
          </div>
        </div>
        <div className="unit-details-select"><label htmlFor={typeId}>{text("Type", "Tipo")}</label>
        <select id={typeId} required={!opening || details.placeholder} value={form.details.kind ?? ""} onChange={event => {
          const value = event.target.value;
          update({ kind: isUnitKind(value) ? value : null });
        }}>
          <option value="">{opening && !details.placeholder ? text("From unit specs", "Según la ficha") : text("Select type", "Selecciona el tipo")}</option>
          {UNIT_KINDS.map(value => <option key={value} value={value}>{unitKindLabel(value, lang === "es")}</option>)}
        </select></div>
        <label>{text("Floor number", "Número de piso")}<input type="number" step="1" min="-999" max="999"
          placeholder={floor?.replace(/^Level /, "") ?? text("Optional", "Opcional")} value={form.details.floor ?? ""} onChange={event => update({ floor: event.target.value ? String(event.target.valueAsNumber) : null })} /></label>
        <label>{text("Inset/outset", "Retranqueo/saliente")}<select value={form.details.inset ?? ""} onChange={event => {
          const value = SET_DEPTHS.find(depth => depth === event.target.value);
          update({ inset: value ?? null });
        }}><option value="">—</option>{SET_DEPTHS.map(value => <option key={value} value={value}>{t(SET_DEPTH_KEYS[value])}</option>)}</select></label>
        <label>{text("Material", "Material")}<input value={form.details.material ?? ""} placeholder={material ?? undefined} onChange={event => update({ material: event.target.value || null })} /></label>
        {/* No Face field: the drawing import never sets one and nobody reads
            it (Matt, 2026-11-20). A value already stored is left as it is. */}
        {opening && <><DimensionFields width={form.details.width == null ? null : form.details.width * MM_PER_INCH}
          height={form.details.height == null ? null : form.details.height * MM_PER_INCH}
          labels={{ legend: text("Dimensions", "Dimensiones"), width: text("Width", "Ancho"),
            height: text("Height", "Alto"), fraction: text("Fraction", "Fracción"), inches: text("Inches", "Pulgadas") }}
          onChange={(side, mm) => update({ [side]: mm === null ? null : mm / MM_PER_INCH })}/>
        <label>{text("Measurement basis", "Base de medida")}<select value={form.details.basis ?? ""} onChange={event => {
          const value = event.target.value;
          update({ basis: value === "unit" || value === "rough" || value === "drawing" ? value : null });
        }}><option value="">{basisLabel(null)}</option>{(["unit", "rough", "drawing"] as const).map(value =>
          <option key={value} value={value}>{basisLabel(value)}</option>)}</select></label></>}
        {opening && <label className="unit-details-reason">{text("Reason (optional)", "Motivo (opcional)")}
          <input maxLength={500} value={reason} onChange={event => setReason(event.target.value)} />
        </label>}
        <div className="unit-details-actions">
          {opening && <button type="button" onClick={() => { setDraft(undefined); setError(""); }}>{text("Cancel", "Cancelar")}</button>}
          <button type="submit">{busy ? text("Saving…", "Guardando…") : text("Save unit", "Guardar unidad")}</button>
        </div>
      </fieldset>
    </form>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
