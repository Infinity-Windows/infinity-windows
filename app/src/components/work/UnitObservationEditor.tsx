import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { WorkUnit } from "../../lib/customWork/model";
import { useLanguage } from "../../lib/i18n";
import { signedInUserId, signInGeneration, signInMark, stillSignedInAs, subscribeSignedIn } from "../../lib/signedIn";
import { unitObservationEdit } from "../../lib/workUnitObservations/edit";
import { observationFromDraft, type DimensionDraft, type UnitFactSnapshot } from "../../lib/workUnitObservations/model";
import { DimensionObservationFields } from "./DimensionObservationFields";
import "./UnitObservationEditor.css";

export interface UnitObservationEditorProps {
  projectId: string;
  unit: WorkUnit | null;
  currentFactSnapshot: UnitFactSnapshot | null;
  sourceState: "ready" | "loading" | "unavailable";
  enabled: boolean;
  readOnly?: boolean;
  /** Stable selection identity while a fresh source is temporarily unavailable. */
  identityUnitId?: string | null;
  /** A canonical unit command is pending or its outcome is unresolved. */
  saveBlocked?: boolean;
  /** Resolves only after the caller has durably committed the canonical unit command. */
  onSave: (data: Readonly<Record<string, unknown>>) => Promise<void>;
  /** Requests an authorized fresh unit and fact read; never certifies a write by itself. */
  onRefresh: () => Promise<void>;
}

const emptyDraft = (): DimensionDraft => ({ width: "", height: "", unit: "in", source: "", reference: "" });
const copy = (en: string, es: string, lang: string) => lang === "es" ? es : en;

/** A dormant editor. The parent owns authorization, the canonical queue, and fresh-read confirmation. */
export function UnitObservationEditor(props: UnitObservationEditorProps) {
  const owner = useSyncExternalStore(subscribeSignedIn, signedInUserId, () => null);
  const generation = useSyncExternalStore(subscribeSignedIn, signInGeneration, () => 0);
  // A remount destroys private drafts and invalidates late callbacks on logout,
  // same-person sign-in ABA, project navigation, or unit navigation.
  const identity = `${owner ?? "anonymous"}:${generation}:${props.projectId}:${props.identityUnitId ?? props.unit?.id ?? "none"}:${props.enabled}:${!!props.readOnly}`;
  return <EditorSession key={identity} {...props} owner={owner} generation={generation} />;
}

function EditorSession({ owner, generation, ...props }: UnitObservationEditorProps & { owner: string | null; generation: number }) {
  const { lang } = useLanguage();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DimensionDraft>(emptyDraft);
  const [basis, setBasis] = useState<{ unitRevision: number; factRevision: number } | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [status, setStatus] = useState<"idle" | "saving" | "queued" | "uncertain">("idle");
  const [refreshing, setRefreshing] = useState(false);
  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // React remounts the session on any ownership/navigation change. This guard
  // also rejects a callback that settles before that remount is painted.
  const session = useRef({ owner, generation, projectId: props.projectId, unitId: props.identityUnitId ?? props.unit?.id });
  const latest = useRef({ enabled: props.enabled, sourceState: props.sourceState, unitRevision: props.unit?.revision, factRevision: props.currentFactSnapshot?.revision });
  latest.current = { enabled: props.enabled, sourceState: props.sourceState, unitRevision: props.unit?.revision, factRevision: props.currentFactSnapshot?.revision };
  const isCurrent = () => alive.current && !!owner &&
    stillSignedInAs({ userId: owner, generation }, owner) &&
    session.current.projectId === props.projectId && session.current.unitId === (props.identityUnitId ?? props.unit?.id) && latest.current.enabled;
  const current = props.currentFactSnapshot;
  const unit = props.unit;
  const sourceReady = props.enabled && !!owner && props.sourceState === "ready" &&
    !!unit && !!current && unit.id === current.unitId && unit.project_id === props.projectId &&
    Number.isSafeInteger(unit.revision) && unit.revision > 0 && Number.isSafeInteger(current.revision) && current.revision >= 0;
  const stale = !!basis && (!sourceReady || basis.unitRevision !== unit?.revision || basis.factRevision !== current?.revision);
  const canEdit = sourceReady && !props.readOnly && !props.saveBlocked && isCurrent();

  const start = () => {
    if (!canEdit || !unit || !current || busy.current) return;
    setDraft(emptyDraft()); // never infer source from legacy mirrors or verification state
    setBasis({ unitRevision: unit.revision, factRevision: current.revision });
    setInvalid(false); setStatus("idle"); setEditing(true);
  };
  const save = async () => {
    if (busy.current || !editing || !basis || !canEdit || stale || !unit || !current || status !== "idle") return;
    let data: Readonly<Record<string, unknown>>;
    try {
      data = unitObservationEdit(unit, current, observationFromDraft({ ...draft }));
    } catch { setInvalid(true); return; }
    const mark = signInMark();
    if (!stillSignedInAs(mark, owner!)) return;
    busy.current = true;
    setInvalid(false); setStatus("saving");
    try {
      await props.onSave(data);
      if (isCurrent() && stillSignedInAs(mark, owner!)) setStatus("queued");
    } catch {
      // A lost reply may follow a durable write. Never say that nothing was sent.
      if (isCurrent() && stillSignedInAs(mark, owner!)) setStatus("uncertain");
    } finally { busy.current = false; }
  };
  const refresh = async () => {
    if (!isCurrent() || refreshing) return;
    setRefreshing(true);
    try { await props.onRefresh(); }
    catch { /* retain the last honest save status */ }
    finally { if (isCurrent()) setRefreshing(false); }
  };
  const raw = sourceReady ? current?.observation : null;
  const text = (en: string, es: string) => copy(en, es, lang);

  // Cleanup is only for late async state writes. Do not reset pending on a
  // normal rerender or language change.
  return <section className="unit-observation-editor" aria-label={text("Unit dimensions", "Dimensiones de la unidad")}>
    <h3>{text("Unit dimensions", "Dimensiones de la unidad")}</h3>
    {!props.enabled || !owner ? <p role="status">{text("Sign in to view current dimensions.", "Inicia sesión para ver las dimensiones actuales.")}</p> :
      props.sourceState !== "ready" || !unit || !current || unit.id !== current.unitId || unit.project_id !== props.projectId ?
        <p role="status">{text("Current unit dimensions are unavailable. Refresh before editing.", "Las dimensiones actuales no están disponibles. Actualiza antes de editarlas.")}</p> : <>
        {raw ? <div className="unit-observation-editor-recorded">
          <p>{text("Recorded original observation (not verified)", "Observación original registrada (sin verificar)")}</p>
          <p>{raw.width} × {raw.height} {raw.unit} · {text("Source", "Origen")}: {raw.source}{raw.sourceReference ? ` · ${raw.sourceReference}` : ""}</p>
          {raw.estimated && <p>{text("Estimate — not verified", "Estimación — sin verificar")}</p>}
        </div> : <p>{text("No original dimension observation is available. Legacy dimensions are not a verified source.", "No hay una observación original de dimensiones. Las dimensiones anteriores no son una fuente verificada.")}</p>}
        {props.readOnly ? <p>{text("Dimension editing is unavailable here.", "La edición de dimensiones no está disponible aquí.")}</p> : <>
          {props.saveBlocked && <p role="status">{text("A unit request is pending or unresolved. Refresh current facts before another edit.", "Hay una solicitud de unidad pendiente o sin resolver. Actualiza los datos actuales antes de otra edición.")}</p>}
          {!editing && <button type="button" disabled={!canEdit} onClick={start}>{text("Enter dimensions", "Introducir dimensiones")}</button>}
          {editing && <div className="unit-observation-editor-form">
            <DimensionObservationFields value={draft} onChange={setDraft} disabled={!canEdit || stale || status !== "idle"} invalid={invalid} />
            {stale && <p role="alert">{text("Unit facts changed. Refresh and start a new edit.", "Los datos de la unidad cambiaron. Actualiza e inicia una nueva edición.")}</p>}
            {stale && canEdit && !busy.current && <button type="button" onClick={start}>{text("Start new edit from current facts", "Nueva edición con los datos actuales")}</button>}
            {status === "saving" && <p role="status">{text("Saving the request on this device…", "Guardando la solicitud en este dispositivo…")}</p>}
            {status === "queued" && <p role="status">{text("Save request stored. Refresh to check the current unit; server confirmation is pending.", "Solicitud guardada. Actualiza para consultar la unidad; falta la confirmación del servidor.")}</p>}
            {status === "uncertain" && <p role="alert">{text("The save reply was lost. The request may have been saved. Refresh before another edit.", "Se perdió la respuesta. Es posible que la solicitud se haya guardado. Actualiza antes de otra edición.")}</p>}
            <div className="unit-observation-editor-actions">
              <button type="button" onClick={() => void save()} disabled={!canEdit || stale || status !== "idle"}>{text("Save dimension request", "Guardar solicitud de dimensiones")}</button>
              <button type="button" onClick={() => { if (!busy.current) { setEditing(false); setDraft(emptyDraft()); setBasis(null); } }} disabled={busy.current || status !== "idle"}>{text("Cancel", "Cancelar")}</button>
            </div>
          </div>}
        </>}
      </>}
    <button type="button" onClick={() => void refresh()} disabled={!owner || !props.enabled || refreshing}>{text("Refresh current unit", "Actualizar unidad actual")}</button>
  </section>;
}
