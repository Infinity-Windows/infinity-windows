import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { UnitObservationEditor } from "../../components/work/UnitObservationEditor";
import type { WorkUnit } from "../../lib/customWork/model";
import { useLanguage } from "../../lib/i18n";
import { signedInUserId, signInGeneration, stillSignedInAs, subscribeSignedIn } from "../../lib/signedIn";
import type { UnitBasis } from "../../lib/workActivity/protocol";
import { useUnitFactSnapshot } from "../../lib/workUnitObservations/useUnitFactSnapshot";

export interface SelectedJobUnitDimensionsProps {
  projectId: string;
  selectedUnitId: string | null;
  /** Fresh server operational rows from an authorized read; never optimistic queue preview, schedule, or legacy mirrors. */
  units: readonly WorkUnit[];
  unitSourceState: "ready" | "loading" | "unavailable";
  /** Fresh activity/catalog projection for the exact selected unit. */
  unitBasis: UnitBasis | null;
  enabled: boolean;
  canEditDimensions: boolean;
  pendingUnitIds: readonly string[];
  /** Resolves only after the existing canonical queue durably commits this unit command. */
  onSave: (data: Readonly<Record<string, unknown>>) => Promise<void>;
  onRefreshUnits: () => Promise<void>;
  onRefreshActivity: () => Promise<void>;
}

function sameUnitBasis(unit: WorkUnit, basis: UnitBasis, projectId: string) {
  return unit.id === basis.id && unit.project_id === projectId && basis.projectId === projectId &&
    unit.opening_id === basis.openingId && unit.revision === basis.operationalRevision &&
    Number.isSafeInteger(unit.revision) && unit.revision > 0;
}

/** Dormant adapter. A missing or conflicting private source is unavailable, never an empty observation. */
export function SelectedJobUnitDimensions(props: SelectedJobUnitDimensionsProps) {
  const owner = useSyncExternalStore(subscribeSignedIn, signedInUserId, () => null);
  const generation = useSyncExternalStore(subscribeSignedIn, signInGeneration, () => 0);
  const { lang } = useLanguage();
  const selected = props.unitSourceState === "ready" && props.selectedUnitId
    ? props.units.filter(unit => unit.id === props.selectedUnitId) : [];
  const unit = selected.length === 1 ? selected[0] : null;
  const preliminary = !!unit && !!props.unitBasis && sameUnitBasis(unit, props.unitBasis, props.projectId);
  const fact = useUnitFactSnapshot(props.projectId, preliminary ? unit!.id : null,
    props.enabled && !!owner && preliminary);
  const ready = props.enabled && !!owner && preliminary && fact.state === "ready" && !!fact.snapshot &&
    fact.snapshot.unitId === unit!.id && fact.snapshot.revision === (props.unitBasis!.fact?.revision ?? 0) &&
    fact.snapshot.eventKind === (props.unitBasis!.fact?.eventKind ?? null);
  const pending = !!props.selectedUnitId && props.pendingUnitIds.includes(props.selectedUnitId);
  const identity = `${owner ?? "anonymous"}:${generation}:${props.projectId}:${props.selectedUnitId ?? "none"}:${props.enabled}`;
  if (!props.enabled || !owner || fact.state === "blocked") return <p role="status">{lang === "es" ? "Las dimensiones actuales no están disponibles aquí." : "Current dimensions are unavailable here."}</p>;
  return <DimensionsSession key={identity} {...props} owner={owner} generation={generation}
    unit={unit} snapshot={fact.state === "ready" ? fact.snapshot ?? null : null} pending={pending}
    sourceReady={ready} refreshFact={fact.refresh} />;
}

function DimensionsSession({ owner, generation, unit, snapshot, pending, sourceReady, refreshFact, ...props }:
  SelectedJobUnitDimensionsProps & { owner: string; generation: number; unit: WorkUnit | null;
    snapshot: NonNullable<ReturnType<typeof useUnitFactSnapshot>["snapshot"]> | null; pending: boolean;
    sourceReady: boolean; refreshFact: ReturnType<typeof useUnitFactSnapshot>["refresh"] }) {
  const { lang } = useLanguage();
  const alive = useRef(true);
  const [held, setHeld] = useState<{ unitRevision: number; factRevision: number } | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const latest = useRef({ unit, snapshot, pending, sourceReady, canEdit: props.canEditDimensions,
    enabled: props.enabled, projectId: props.projectId, unitBasis: props.unitBasis });
  latest.current = { unit, snapshot, pending, sourceReady, canEdit: props.canEditDimensions,
    enabled: props.enabled, projectId: props.projectId, unitBasis: props.unitBasis };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const current = () => alive.current && stillSignedInAs({ userId: owner, generation }, owner);
  // A queue row disappearing is not acceptance. A new authorized source revision
  // is required before the user may author a different command for this unit.
  const unresolved = !!held && (!sourceReady || !unit || !snapshot ||
    unit.revision <= held.unitRevision || snapshot.revision <= held.factRevision);
  const blocked = pending || unresolved;
  const usable = sourceReady && !refreshFailed;
  const save = async (data: Readonly<Record<string, unknown>>) => {
    const now = latest.current;
    if (!current() || !now.enabled || !now.canEdit || now.pending || !now.sourceReady || !now.unit || !now.snapshot ||
      !now.unitBasis || refreshFailed || unresolved || !sameUnitBasis(now.unit, now.unitBasis, now.projectId) ||
      now.snapshot.revision !== (now.unitBasis.fact?.revision ?? 0) ||
      data.id !== now.unit.id || data.project_id !== now.projectId || data.opening_id !== now.unit.opening_id ||
      data.revision !== now.unit.revision || data.expected_fact_revision !== now.snapshot.revision) throw Error("Current unit source unavailable");
    const bound = { unitRevision: now.unit.revision, factRevision: now.snapshot.revision };
    setHeld(bound);
    await props.onSave(data);
  };
  const refresh = async () => {
    if (!current() || !props.enabled) return;
    try {
      const [, , result] = await Promise.all([props.onRefreshUnits(), props.onRefreshActivity(), refreshFact()]);
      if (result?.data?.status !== "ready") throw Error("Current fact unavailable");
      if (current()) setRefreshFailed(false);
    } catch {
      if (current()) setRefreshFailed(true);
      throw Error("Current unit source unavailable");
    }
  };
  return <section aria-label={lang === "es" ? "Dimensiones de la unidad seleccionada" : "Selected unit dimensions"}>
    {pending && <p role="status">{lang === "es" ? "Hay una solicitud de esta unidad pendiente. Su resultado no está confirmado." : "A request for this unit is pending. Its result is not confirmed."}</p>}
    {!usable && <p role="status">{lang === "es" ? "Los datos actuales de la unidad no están disponibles. Actualiza antes de editar." : "Current unit facts are unavailable. Refresh before editing."}</p>}
    <UnitObservationEditor projectId={props.projectId} identityUnitId={props.selectedUnitId} unit={unit}
      currentFactSnapshot={snapshot} sourceState={usable ? "ready" : "unavailable"}
      enabled={props.enabled} readOnly={!props.canEditDimensions} saveBlocked={blocked}
      onSave={save} onRefresh={refresh} />
  </section>;
}
