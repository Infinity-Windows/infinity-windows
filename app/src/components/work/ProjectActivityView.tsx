import { useEffect, useRef, useState, type ReactNode } from "react";
import "./ProjectActivityView.css";
import { ActivityAnswerFields } from "./ActivityAnswerFields";
import { cloneJson, typedFields, type TypedField } from "../../lib/workConfiguration/model";
import { validateActivityAnswers, type AnswerDraft, type AnswerIssue, type AnswerValue } from "../../lib/workConfiguration/answers";
import type { UnitCommandBasis } from "../../lib/workActivity/protocol";

export type ActivityScope = "general" | "specific";
export type WorkLocale = "en" | "es";
export type MachineKind = "forklift" | "tele_handler" | "scissor_lift" | "spider_suction";

export interface ActivityChoice {
  selectionId: string;
  selectionRevision: number;
  menuVersionId: string;
  definitionVersionId: string;
  definitionId?: string;
  scope: ActivityScope;
  label: { en: string; es: string };
  kind: "activity" | "machinery";
  fields: readonly TypedField[];
  /** Verified personal accumulated seconds, or null when no trustworthy total is available. */
  personalSeconds: number | null;
  /** Verified total for this activity in its job or selected unit, including live time only if reconciled upstream. */
  scopeTotalSeconds: number | null;
  /** Source-provided eligibility; this component never derives authorization from a role. */
  eligible: boolean;
  unavailableReason?: { en: string; es: string };
}

export interface WorkUnitChoice {
  id: string;
  label: string;
  detail?: string;
}

export type FrozenUnitBasis = UnitCommandBasis;

export interface ActivityIntent {
  projectId: string;
  selectionId: string;
  selectionRevision: number;
  unit: FrozenUnitBasis | null;
  scope: ActivityScope;
  menuVersionId: string;
  definitionVersionId: string;
  machineKind: MachineKind | null;
  values: Readonly<Record<string, Exclude<AnswerValue, string[]> | readonly string[]>>;
}

export interface RunningActivity {
  projectId: string;
  definitionVersionId: string;
  unitId: string | null;
  label: { en: string; es: string };
  scope: ActivityScope;
  unitLabel?: string;
  machine?: MachineKind | null;
  /** Server or reconciled state; never infer a confirmed running segment from a tap. */
  status: "confirmed" | "pending";
}

export interface ProjectActivityViewProps {
  locale: WorkLocale;
  project: { id: string; name: string; code?: string };
  tab: ActivityScope;
  onTabChange: (tab: ActivityScope) => void;
  /** Paid shift time and personal scope totals are supplied by the parent, never calculated here. */
  paidSeconds: number | null;
  scopeSeconds: { general: number | null; specific: number | null };
  running: RunningActivity | null;
  catalog: { status: "loading" | "ready" | "error" | "unavailable"; capturable: boolean; blockReason?: string; general: readonly ActivityChoice[]; specific: readonly ActivityChoice[] };
  units: readonly WorkUnitChoice[];
  selectedUnitId: string | null;
  selectedUnitState: "ready" | "needs_dimensions" | "unavailable";
  selectedUnitBasis: FrozenUnitBasis | null;
  selectedUnitBlockReason?: string;
  onSelectUnit: (unitId: string) => void;
  onAddUnit: () => void;
  /** Parent-owned dimension controls and unit actions, displayed only in the Specific pane. */
  dimensionsSlot?: ReactNode;
  unitActionsSlot?: ReactNode;
  /** An unresolved command or transport attempt locks further starts, including after remount. */
  activityPending: boolean;
  activityStatus?: { kind: "pending" | "error" | "info"; message: string } | null;
  onStartActivity: (intent: ActivityIntent) => Promise<void>;
  onOpenClock: () => void;
  onBreak: () => void;
  onClockOut: () => void;
  onSchedule: () => void;
  onAsk: () => void;
}

const machines: Record<ActivityScope, readonly MachineKind[]> = {
  general: ["forklift", "tele_handler"],
  specific: ["scissor_lift", "forklift", "tele_handler", "spider_suction"],
};

const words = {
  en: {
    work: "Work", paid: "Paid clock", unavailable: "Unavailable", yourClock: "Your clock", break: "Break",
    clockOut: "Clock out", schedule: "Schedule", ask: "Ask", general: "General", specific: "Specific",
    active: "Current activity", noActive: "No confirmed activity available", pending: "Pending confirmation",
    generalTotal: "Your General time", specificTotal: "Your selected-unit time", personal: "Your time",
    jobTotal: "Job total", unitTotal: "Unit total", runningTile: "Running",
    chooseUnit: "Choose a unit", addUnit: "Add unit", unitUnavailable: "Unit details are unavailable.",
    needDimensions: "Add positive width, height, and a measurement source before starting new Specific work.",
    noUnits: "No units are available to choose.", loading: "Loading published activities…",
    readError: "Published activities are unavailable. Try again from the Work screen.",
    empty: "No published activities are available for this scope.", selectMachine: "Choose machinery",
    machineHelp: "Your current activity keeps running until you choose a machine.",
    cancel: "Cancel", details: "Activity details", confirm: "Start activity", detailsHelp: "Your current activity keeps running until you confirm.", detailsUnavailable: "Activity details are unavailable. Choose the activity again.",
    forklift: "Forklift", tele_handler: "Tele-Handler", scissor_lift: "Scissor Lift",
    spider_suction: "Spider suction cup machine",
  },
  es: {
    work: "Trabajo", paid: "Reloj pagado", unavailable: "No disponible", yourClock: "Tu reloj", break: "Descanso",
    clockOut: "Marcar salida", schedule: "Horario", ask: "Preguntar", general: "General", specific: "Específico",
    active: "Actividad actual", noActive: "No hay actividad confirmada disponible", pending: "Pendiente de confirmación",
    generalTotal: "Tu tiempo general", specificTotal: "Tu tiempo de la unidad elegida", personal: "Tu tiempo",
    jobTotal: "Total del trabajo", unitTotal: "Total de la unidad", runningTile: "En curso",
    chooseUnit: "Elige una unidad", addUnit: "Agregar unidad", unitUnavailable: "Los datos de la unidad no están disponibles.",
    needDimensions: "Agrega ancho y alto positivos y el origen de la medida antes de iniciar trabajo específico.",
    noUnits: "No hay unidades disponibles para elegir.", loading: "Cargando actividades publicadas…",
    readError: "Las actividades publicadas no están disponibles. Inténtalo de nuevo desde Trabajo.",
    empty: "No hay actividades publicadas para este grupo.", selectMachine: "Elige maquinaria",
    machineHelp: "Tu actividad actual continúa hasta que elijas una máquina.",
    cancel: "Cancelar", details: "Detalles de la actividad", confirm: "Iniciar actividad", detailsHelp: "Tu actividad actual continúa hasta que confirmes.", detailsUnavailable: "Los detalles de la actividad no están disponibles. Elige la actividad otra vez.",
    forklift: "Montacargas", tele_handler: "Manipulador telescópico", scissor_lift: "Plataforma de tijera",
    spider_suction: "Máquina de ventosas Spider",
  },
} as const;

function duration(seconds: number | null, unavailable: string): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return unavailable;
  const minutes = Math.floor(seconds / 60);
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function sameUnitBasis(a: FrozenUnitBasis | null, b: FrozenUnitBasis | null): boolean {
  return a === b || (!!a && !!b && a.id === b.id && a.operationalRevision === b.operationalRevision &&
    a.factId === b.factId && a.factRevision === b.factRevision &&
    a.incarnationEpoch === b.incarnationEpoch && a.bindingEpoch === b.bindingEpoch &&
    a.projectEpoch === b.projectEpoch && a.openingEpoch === b.openingEpoch &&
    a.originProjectEpoch === b.originProjectEpoch && a.originOpeningEpoch === b.originOpeningEpoch);
}

function schemaSignature(fields: readonly TypedField[]): string | null {
  try { return JSON.stringify(typedFields(cloneJson(fields))); } catch { return null; }
}

export function ProjectActivityView(props: ProjectActivityViewProps) {
  const { locale, project, tab, catalog, selectedUnitId, selectedUnitState } = props;
  const t = words[locale];
  const [machineChoice, setMachineChoice] = useState<{ choice: ActivityChoice; unit: FrozenUnitBasis | null; machine: MachineKind | null } | null>(null);
  const [draft, setDraft] = useState<AnswerDraft>({});
  const [answerErrors, setAnswerErrors] = useState<Record<string, AnswerIssue>>({});
  const [detailsUnavailable, setDetailsUnavailable] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const chosenUnit = props.units.find((unit) => unit.id === selectedUnitId) ?? null;
  const choices = tab === "general" ? catalog.general : catalog.specific;
  const canStart = !props.activityPending && !submitting && catalog.status === "ready" && catalog.capturable;
  const scopeReady = tab === "general" || (chosenUnit !== null && selectedUnitState === "ready" && props.selectedUnitBasis?.id === selectedUnitId);

  const unitBasis = props.selectedUnitBasis;
  const basisSignature = unitBasis ? JSON.stringify([
    unitBasis.id, unitBasis.operationalRevision, unitBasis.factId, unitBasis.factRevision,
    unitBasis.incarnationEpoch, unitBasis.bindingEpoch, unitBasis.projectEpoch, unitBasis.openingEpoch,
    unitBasis.originProjectEpoch, unitBasis.originOpeningEpoch,
  ]) : "";
  useEffect(() => { setMachineChoice(null); }, [project.id, tab, selectedUnitId, basisSignature]);
  useEffect(() => {
    if (!machineChoice) return;
    const liveChoices = machineChoice.choice.scope === "general" ? catalog.general : catalog.specific;
    if (catalog.status !== "ready" || !liveChoices.some((choice) =>
      choice.selectionId === machineChoice.choice.selectionId &&
      choice.selectionRevision === machineChoice.choice.selectionRevision &&
      choice.menuVersionId === machineChoice.choice.menuVersionId &&
      choice.definitionVersionId === machineChoice.choice.definitionVersionId &&
      choice.eligible && choice.kind === machineChoice.choice.kind &&
      schemaSignature(choice.fields) !== null && schemaSignature(choice.fields) === schemaSignature(machineChoice.choice.fields)
    )) setMachineChoice(null);
  }, [catalog, machineChoice]);

  async function start(choice: ActivityChoice, machine: MachineKind | null, unit: FrozenUnitBasis | null, answers: AnswerDraft = {}) {
    if (inFlight.current || !canStart || !scopeReady || !choice.eligible || choice.scope !== tab) return;
    if (choice.kind === "machinery" && (!machine || !machines[tab].includes(machine))) return;
    if (choice.kind === "activity" && machine !== null) return;
    if (tab === "specific" && (!unit || unit.id !== selectedUnitId || !sameUnitBasis(unit, props.selectedUnitBasis))) return;
    if (tab === "general" && unit !== null) return;
    const liveChoices = tab === "general" ? catalog.general : catalog.specific;
    if (!liveChoices.some((item) =>
      item.selectionId === choice.selectionId && item.selectionRevision === choice.selectionRevision &&
      item.menuVersionId === choice.menuVersionId && item.definitionVersionId === choice.definitionVersionId &&
      item.kind === choice.kind && item.eligible && schemaSignature(item.fields) !== null && schemaSignature(item.fields) === schemaSignature(choice.fields)
    )) return;
    const validated = validateActivityAnswers(choice.fields, answers);
    if (!validated.ok) { setAnswerErrors(validated.errors); return; }
    const values = Object.freeze(Object.fromEntries(Object.entries(validated.values).map(([id, value]) =>
      [id, Array.isArray(value) ? Object.freeze([...value]) : value])));
    const intent: ActivityIntent = Object.freeze({
      projectId: project.id, unit: unit ? Object.freeze({ ...unit }) : null, scope: tab,
      selectionId: choice.selectionId, selectionRevision: choice.selectionRevision,
      menuVersionId: choice.menuVersionId, definitionVersionId: choice.definitionVersionId, machineKind: machine, values,
    });
    inFlight.current = true;
    setSubmitting(true);
    setMachineChoice(null);
    try {
      await props.onStartActivity(intent);
    } catch {
      // The parent owns uncertain/refused command status and preserves the frozen intent.
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  function choose(choice: ActivityChoice) {
    if (!canStart || !scopeReady || !choice.eligible) return;
    setDetailsUnavailable(false);
    const unit = tab === "specific" && props.selectedUnitBasis ? Object.freeze({ ...props.selectedUnitBasis }) : null;
    let frozenChoice: ActivityChoice;
    try { frozenChoice = { ...choice, label: { ...choice.label }, fields: typedFields(cloneJson(choice.fields)) }; }
    catch { setDetailsUnavailable(true); return; }
    if (choice.kind === "machinery" || frozenChoice.fields.length > 0) {
      setDraft({}); setAnswerErrors({}); setMachineChoice({ choice: frozenChoice, unit, machine: null });
    } else void start(frozenChoice, null, unit);
  }

  return (
    <section className="pav" aria-label={t.work} data-testid="project-activity-view">
      <header className="pav-header">
        <div className="pav-project">
          <span className="pav-eyebrow">{t.work}</span>
          <h1 title={project.code ? `${project.code} · ${project.name}` : project.name}>{project.code ? `${project.code} · ${project.name}` : project.name}</h1>
          <p>{t.paid}: <strong>{duration(props.paidSeconds, t.unavailable)}</strong></p>
        </div>
        <button type="button" className="pav-clock" onClick={props.onOpenClock} aria-label={t.yourClock}>
          <span aria-hidden>◷</span><strong>{duration(props.paidSeconds, t.unavailable)}</strong>
        </button>
      </header>

      <nav className="pav-actions" aria-label={t.work}>
        <button type="button" onClick={props.onBreak}>{t.break}</button>
        <button type="button" onClick={props.onClockOut}>{t.clockOut}</button>
        <button type="button" onClick={props.onSchedule}>{t.schedule}</button>
        <button type="button" onClick={props.onAsk}>{t.ask}</button>
      </nav>

      <div className="pav-running" role="status">
        <span className="pav-eyebrow">{t.active}</span>
        {props.running ? (
          <strong>{props.running.label[locale]}{props.running.unitLabel ? ` · ${props.running.unitLabel}` : ""}
            {props.running.machine ? ` · ${t[props.running.machine]}` : ""}
            {props.running.status === "pending" ? ` · ${t.pending}` : ""}</strong>
        ) : <strong>{t.noActive}</strong>}
      </div>

      <div className="pav-tabs" role="tablist" aria-label={t.work}>
        <button type="button" role="tab" aria-selected={tab === "general"} onClick={() => props.onTabChange("general")}>{t.general}</button>
        <button type="button" role="tab" aria-selected={tab === "specific"} onClick={() => props.onTabChange("specific")}>{t.specific}</button>
      </div>

      <div className="pav-pane" role="tabpanel" aria-label={tab === "general" ? t.general : t.specific}>
        {tab === "specific" && (
          <div className="pav-unit">
            <div className="pav-unit-picker">
              <label htmlFor="pav-unit-select">{t.chooseUnit}</label>
              <select id="pav-unit-select" value={chosenUnit?.id ?? ""} onChange={(event) => { if (event.target.value) props.onSelectUnit(event.target.value); }}>
                <option value="">{t.chooseUnit}</option>
                {props.units.map((unit) => <option key={unit.id} value={unit.id}>{unit.label}{unit.detail ? ` · ${unit.detail}` : ""}</option>)}
              </select>
              <button type="button" onClick={props.onAddUnit}>{t.addUnit}</button>
            </div>
            {props.units.length === 0 && <p className="pav-note">{t.noUnits}</p>}
            {props.units.length > 0 && !chosenUnit && <p className="pav-note">{t.chooseUnit}</p>}
            {chosenUnit && selectedUnitState !== "ready" && <p className="pav-note" role="status">{selectedUnitState === "needs_dimensions" ? t.needDimensions : t.unitUnavailable}</p>}
            {chosenUnit && !scopeReady && props.selectedUnitBlockReason && <p className="pav-note" role="status">{props.selectedUnitBlockReason}</p>}
            {chosenUnit && props.dimensionsSlot}
            {chosenUnit && props.unitActionsSlot}
          </div>
        )}
        <div className="pav-scope-total">
          <h2>{tab === "general" ? t.general : t.specific}</h2>
          <span>{tab === "general" ? t.generalTotal : t.specificTotal}: <strong>{duration(props.scopeSeconds[tab], t.unavailable)}</strong></span>
        </div>
        {detailsUnavailable && <p className="pav-note" role="alert">{t.detailsUnavailable}</p>}
        {props.activityStatus && <p className="pav-note" role={props.activityStatus.kind === "error" ? "alert" : "status"}>{props.activityStatus.message}</p>}
        {catalog.status === "ready" && !catalog.capturable && <p className="pav-note" role="status">{catalog.blockReason ?? t.readError}</p>}
        {catalog.status !== "ready" ? <p className="pav-note" role="status">{catalog.status === "loading" ? t.loading : t.readError}</p>
          : choices.length === 0 ? <p className="pav-note" role="status">{t.empty}</p>
          : <div className="pav-tiles">
            {choices.filter((choice) => choice.scope === tab).map((choice) => {
              const isRunning = props.running?.status === "confirmed" && props.running.projectId === project.id &&
                props.running.scope === tab && props.running.definitionVersionId === choice.definitionVersionId &&
                props.running.unitId === (tab === "specific" ? selectedUnitId : null);
              return <button key={`${choice.selectionId}:${choice.menuVersionId}:${choice.definitionVersionId}`} type="button"
                className={`pav-tile${isRunning ? " pav-tile-running" : ""}`} aria-pressed={isRunning}
                disabled={!canStart || !scopeReady || !choice.eligible} onClick={() => choose(choice)}
                aria-label={choice.label[locale]} title={choice.unavailableReason?.[locale]}>
                <span className="pav-tile-label">{choice.label[locale]}{isRunning && <span className="pav-running-mark">{t.runningTile}</span>}</span>
                <span className="pav-tile-times">
                  <span>{t.personal}: {duration(choice.personalSeconds, t.unavailable)}</span>
                  <span>{tab === "general" ? t.jobTotal : t.unitTotal}: {duration(choice.scopeTotalSeconds, t.unavailable)}</span>
                </span>
              </button>})}
          </div>}
      </div>

      {machineChoice && <div className="pav-machine-backdrop">
        <div className="pav-machine-dialog" role="dialog" aria-modal="true" aria-label={machineChoice.choice.kind === "machinery" ? t.selectMachine : t.details}>
          <h2>{machineChoice.choice.kind === "machinery" ? t.selectMachine : t.details}</h2>
          <p>{machineChoice.choice.kind === "machinery" ? t.machineHelp : t.detailsHelp}</p>
          {machineChoice.choice.kind === "machinery" && <div className="pav-machine-options">
            {machines[tab].map((machine) => <button key={machine} type="button" aria-pressed={machineChoice.machine === machine}
              disabled={!canStart || !scopeReady} onClick={() => {
                if (machineChoice.choice.fields.length === 0) void start(machineChoice.choice, machine, machineChoice.unit);
                else setMachineChoice({ ...machineChoice, machine });
              }}>{t[machine]}</button>)}
          </div>}
          {machineChoice.choice.fields.length > 0 && <>
            <ActivityAnswerFields fields={machineChoice.choice.fields} value={draft} onChange={(next) => { setDraft(next); setAnswerErrors({}); }}
              locale={locale} disabled={!canStart || !scopeReady} invalid={answerErrors} />
            <button type="button" className="pav-confirm" disabled={!canStart || !scopeReady || (machineChoice.choice.kind === "machinery" && !machineChoice.machine)}
              onClick={() => void start(machineChoice.choice, machineChoice.machine, machineChoice.unit, draft)}>{t.confirm}</button>
          </>}
          <button type="button" className="pav-cancel" onClick={() => setMachineChoice(null)}>{t.cancel}</button>
        </div>
      </div>}
    </section>
  );
}
