import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useLanguage } from "../../lib/i18n";
import { signedInUserId, signInGeneration, stillSignedInAs, subscribeSignedIn } from "../../lib/signedIn";
import { useViewAsRole } from "../../lib/viewAsRoleContext";
import { ProjectActivityView, type ActivityChoice, type ActivityIntent, type ActivityScope, type RunningActivity, type WorkUnitChoice } from "../../components/work/ProjectActivityView";
import { useActivityCatalog } from "../../lib/workActivity/useActivityCatalog";
import { useActivitySnapshot, useActivityUnitBasis } from "../../lib/workActivity/useActivityReads";
import { getActivityDeviceId } from "../../lib/workActivity/device";
import { getCurrentActivityCommand, type ActivityCommandRecord } from "../../lib/workActivity/journal";
import { saveActivityTap } from "../../lib/workActivity/saveTap";
import { dispatchSavedActivityCommand } from "../../lib/workActivity/dispatch";
import { unitCommandBasis, type Intent } from "../../lib/workActivity/protocol";
import { SelectedJobUnitDimensions, type SelectedJobUnitDimensionsProps } from "./SelectedJobUnitDimensions";
import { createUnitReviewSelectionSource } from "../../lib/workUnitReview/useUnitReviewCoordinator";
import type { SelectedUnitReviewSource } from "./SelectedUnitReview";
import { useActivityTotals } from "../../lib/workActivityTotals/useActivityTotals";
import { choiceTotals, personalScopeSeconds } from "../../lib/workActivityTotals/format";
import { REVIEW_FRESH_MS } from "../../lib/workUnitReview/coordinator";
import "./SelectedJobWork.css";
const UnitReview = lazy(async () => ({ default: (await import("./SelectedUnitReview")).SelectedUnitReview }));
const Contributors = lazy(async () => ({ default: (await import("./SelectedUnitContributors")).SelectedUnitContributors }));
const ActivityTotals = lazy(async () => ({ default: (await import("../../components/work/ActivityTotalsPanel")).ActivityTotalsPanel }));

export interface SelectedJobWorkProps {
  /** The real selected job, supplied by the production route; never a schedule fallback. */
  project: { id: string; name: string; code?: string };
  /** Already authorized operational choices. This component never enumerates jobs or units. */
  units: readonly WorkUnitChoice[];
  /** Deliberate activation gate and read-only preview gate owned by the caller. */
  featureEnabled: boolean;
  previewDisabled: boolean;
  /** Verified payroll arithmetic supplied by the caller; null means unknown. */
  paidSeconds: number | null;
  /** Explicit setup allocation chosen upstream, or null when none is selected. */
  setupAllocation: { projectId: string; costCodeId: string | null } | null;
  /** Shared with the route so every navigation door closes review first. */
  reviewSource?: SelectedUnitReviewSource;
  dimensionsSlot?: ReactNode;
  /** Fresh canonical units and their existing durable save seam, owned by the route. */
  dimensionEntry?: Omit<SelectedJobUnitDimensionsProps, "projectId" | "selectedUnitId" | "unitBasis" | "enabled" | "onRefreshActivity">;
  unitActionsSlot?: ReactNode;
  onAddUnit: () => void;
  onOpenClock: () => void;
  onBreak: () => void;
  onClockOut: () => void;
  onSchedule: () => void;
  onAsk: () => void;
}

const copy = {
  en: {
    unavailable: "Activity information is unavailable. Refresh to try again.",
    disabled: "Activity capture is not available here.",
    loading: "Loading current activity…",
    held: "Your saved activity request needs review before another start.",
    saved: "Your request is saved on this device; its result is not confirmed.",
    storage: "This device could not save the activity request. Nothing was sent.",
    rejected: "The activity request was not applied. Refresh before choosing again.",
    ready: "Reaffirm activity stream",
    retry: "Check receipt and retry original request",
    send: "Send saved request",
    stop: "Stop current activity",
    finish: "Finish paid setup",
    review: "Review the current state and try again.",
    unit: "Current unit facts are unavailable. Refresh before Specific work.",
    dimensions: "Record current width, height, and source before Specific work.",
  },
  es: {
    unavailable: "La información de actividad no está disponible. Actualiza para intentarlo de nuevo.",
    disabled: "La captura de actividad no está disponible aquí.",
    loading: "Cargando la actividad actual…",
    held: "Tu solicitud de actividad guardada necesita revisión antes de otro inicio.",
    saved: "Tu solicitud está guardada en este dispositivo; el resultado no está confirmado.",
    storage: "Este dispositivo no pudo guardar la solicitud. No se envió nada.",
    rejected: "La solicitud de actividad no se aplicó. Actualiza antes de elegir otra.",
    ready: "Reafirmar actividad",
    retry: "Revisar recibo y reintentar solicitud original",
    send: "Enviar solicitud guardada",
    stop: "Detener actividad actual",
    finish: "Terminar preparación pagada",
    review: "Revisa el estado actual e inténtalo de nuevo.",
    unit: "Los datos actuales de la unidad no están disponibles. Actualiza antes del trabajo específico.",
    dimensions: "Registra el ancho, alto y origen actuales antes del trabajo específico.",
  },
} as const;

function validId(value: string): boolean { return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value); }
function emptyCatalog(message: string): Parameters<typeof ProjectActivityView>[0]["catalog"] {
  return { status: "unavailable", capturable: false, blockReason: message, general: [], specific: [] };
}

/** Dormant parent: keeps all payroll/navigation controls callable even when private reads fail. */
export function SelectedJobWork(props: SelectedJobWorkProps) {
  const owner = useSyncExternalStore(subscribeSignedIn, signedInUserId, () => null);
  const generation = useSyncExternalStore(subscribeSignedIn, signInGeneration, () => 0);
  const preview = useViewAsRole();
  const [localReviewSource] = useState(createUnitReviewSelectionSource);
  const reviewSource = props.reviewSource ?? localReviewSource;
  useLayoutEffect(() => () => reviewSource.invalidate(), [reviewSource]);
  const { lang } = useLanguage();
  const locale = lang === "es" ? "es" : "en";
  const enabled = props.featureEnabled && !props.previewDisabled && !preview.previewPerson && !preview.previewRole && !!owner && validId(props.project.id);
  const t = copy[locale];
  if (!enabled) return <ProjectActivityView locale={locale} project={props.project} tab="general" onTabChange={() => {}}
    paidSeconds={props.paidSeconds} scopeSeconds={{ general: null, specific: null }} running={null}
    catalog={emptyCatalog(t.disabled)} units={[]} selectedUnitId={null} selectedUnitState="unavailable" selectedUnitBasis={null}
    onSelectUnit={() => {}} onAddUnit={props.onAddUnit} activityPending onStartActivity={async () => {}}
    onOpenClock={props.onOpenClock} onBreak={props.onBreak} onClockOut={props.onClockOut}
    onSchedule={props.onSchedule} onAsk={props.onAsk} />;
  return <SelectedJobWorkActive key={owner + ":" + generation + ":" + props.project.id}
    {...props} reviewSource={reviewSource} owner={owner!} generation={generation} locale={locale} />;
}

function SelectedJobWorkActive(props: SelectedJobWorkProps & { reviewSource: SelectedUnitReviewSource; owner: string; generation: number; locale: "en" | "es" }) {
  const { owner, generation, locale, project } = props;
  const t = copy[locale];
  const reviewSource = props.reviewSource;
  const [contributorSource] = useState(createUnitReviewSelectionSource);
  const reviewLifetime = useRef(0), selectionLifetime = useRef(0), reviewOpen = useRef(true);
  const [, repaintSelection] = useState(0);
  const closeReview = () => { reviewLifetime.current++; reviewSource.invalidate(); contributorSource.invalidate(); };
  const leaveReview = (next: () => void) => { selectionLifetime.current++; reviewOpen.current = false; closeReview(); next(); };
  useLayoutEffect(() => {
    reviewOpen.current = true;
    const close = () => { selectionLifetime.current++; reviewOpen.current = false; reviewLifetime.current++; reviewSource.invalidate(); contributorSource.invalidate(); };
    window.addEventListener("popstate", close);
    return () => { close(); window.removeEventListener("popstate", close); };
  }, [reviewSource, contributorSource]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [deviceError, setDeviceError] = useState(false);
  const [tab, setTab] = useState<ActivityScope>("general");
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null);
  const [head, setHead] = useState<ActivityCommandRecord | null>(null);
  const [recovered, setRecovered] = useState(false);
  const [recoveryError, setRecoveryError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [dimensionHolds, setDimensionHolds] = useState<Record<string, { unitRevision: number; factRevision: number }>>({});
  const inFlight = useRef(false);
  const alive = useRef(true);
  const current = () => alive.current && stillSignedInAs({ userId: owner, generation }, owner);
  const selectedUnit = props.units.find((unit) => unit.id === selectedUnitId) ?? null;
  const unitId = selectedUnit?.id ?? null;
  const liveUnitId = useRef(unitId);
  liveUnitId.current = unitId;
  const snapshot = useActivitySnapshot(deviceId, !!deviceId);
  const catalog = useActivityCatalog(project.id, unitId, !!deviceId);
  const basis = useActivityUnitBasis(unitId, !!deviceId && !!unitId);
  const source = snapshot.data;
  const view = source?.value;
  const state = view?.state;
  const selection = catalog.data?.value.availability === "available" ? catalog.data.value.selection : null;
  const pending = !!head && !head.receipt;
  const privacyReady = current() && !!deviceId && recovered && !recoveryError;
  const snapshotReady = privacyReady && snapshot.state === "ready" && view?.capability.mode !== "unavailable";
  const catalogReady = snapshotReady && catalog.state === "ready" && catalog.data?.value.availability === "available";
  const headReady = !!head?.receipt && (head.receipt.status === "applied" || head.receipt.status === "noop") &&
    view?.stream?.headCommandId === head.commandId && head.receipt.afterRevision === state?.revision;
  const unitReply = basis.data?.value;
  const catalogUnit = catalog.data?.value.availability === "available" ? catalog.data.value.unit : null;
  const matchingUnitBasis = unitId && basis.state === "ready" && unitReply?.availability === "available" &&
    catalogUnit?.id === unitId && unitReply.unit.projectId === project.id &&
    JSON.stringify(unitReply.unit) === JSON.stringify(catalogUnit) ? unitReply.unit : null;
  const dimensionEntry = props.dimensionEntry;
  const canonicalUnit = dimensionEntry?.units.find((unit) => unit.id === unitId);
  const heldBasis = unitId ? dimensionHolds[unitId] : undefined;
  // A fresh later unit+fact basis fences the original immutable write by its
  // old revisions. Queue disappearance alone never confirms that write.
  const laterDimensionBasis = !!heldBasis && dimensionEntry?.unitSourceState === "ready" && !!canonicalUnit &&
    !!matchingUnitBasis && canonicalUnit.project_id === project.id &&
    canonicalUnit.opening_id === matchingUnitBasis.openingId && canonicalUnit.revision === matchingUnitBasis.operationalRevision &&
    canonicalUnit.revision > heldBasis.unitRevision && (matchingUnitBasis.fact?.revision ?? 0) > heldBasis.factRevision;
  const dimensionHeld = !!unitId && (!!dimensionEntry?.pendingUnitIds.includes(unitId) || (!!heldBasis && !laterDimensionBasis));
  const reviewLive = useRef({ unitId, tab, unit: basis.data, catalog: catalog.data, dimensionHeld });
  useLayoutEffect(() => { reviewLive.current = { unitId, tab, unit: basis.data, catalog: catalog.data, dimensionHeld }; });
  const reviewEpoch = reviewLifetime.current, selectionEpoch = selectionLifetime.current;
  const refreshingSelection = useRef<number | null>(null);
  const reviewAdmitted = () => current() && reviewOpen.current && reviewLifetime.current === reviewEpoch
    && liveUnitId.current === unitId && reviewLive.current.unitId === unitId && reviewLive.current.tab === "specific"
    && reviewLive.current.unit?.requestStartedAt === basis.data?.requestStartedAt
    && reviewLive.current.catalog?.requestStartedAt === catalog.data?.requestStartedAt
    && reviewLive.current.unit?.value === basis.data?.value && reviewLive.current.catalog?.value === catalog.data?.value
    && !reviewLive.current.dimensionHeld;
  const totalsUnitId = tab === "specific" ? unitId : null;
  const totalsAdmitted = () => current() && reviewOpen.current && reviewLifetime.current === reviewEpoch
    && selectionLifetime.current === selectionEpoch && reviewLive.current.tab === tab
    && refreshingSelection.current !== selectionEpoch
    && catalogReady && catalog.state === "ready" && !!catalog.data
    && performance.now() - catalog.data.requestStartedAt >= 0
    && performance.now() - catalog.data.requestStartedAt < REVIEW_FRESH_MS
    && reviewLive.current.catalog === catalog.data
    && (tab === "general" || (!!unitId && reviewAdmitted()));
  // Only real read/selection transitions reopen totals. An unrelated clock
  // repaint updates the live callback without starting another server read.
  const totalsAdmissionRevision = JSON.stringify([reviewEpoch, selectionEpoch, tab,
    catalog.state, catalog.data?.requestStartedAt,
    tab === "specific" ? basis.state : null, tab === "specific" ? basis.data?.requestStartedAt : null,
    dimensionHeld, refreshingSelection.current === selectionEpoch, catalogReady]);
  const totals = useActivityTotals(project.id, totalsUnitId, reviewSource, totalsAdmitted, totalsAdmissionRevision);
  // Raw labor is independent of dimensions, QC acceptance and capture
  // eligibility. This live parent fence only owns the selected job/unit and
  // navigation lifetime; the manual reader proves its own fresh canonical unit.
  const contributorAdmitted = () => current() && reviewOpen.current
    && reviewLifetime.current === reviewEpoch && selectionLifetime.current === selectionEpoch
    && liveUnitId.current === unitId && reviewLive.current.unitId === unitId
    && reviewLive.current.tab === "specific" && refreshingSelection.current !== selectionEpoch;
  const contributorRevision = JSON.stringify([reviewEpoch, selectionEpoch, tab,
    catalog.state, catalog.data?.requestStartedAt, basis.state, basis.data?.requestStartedAt,
    unitReply?.availability === "available" ? unitReply.unit : null]);
  let frozenUnit: ReturnType<typeof unitCommandBasis> | null = null;
  if (!dimensionHeld && unitId && basis.state === "ready" && unitReply?.availability === "available" &&
      catalogUnit?.id === unitId && unitReply.unit.projectId === project.id) {
    try {
      const a = unitCommandBasis(unitReply.unit), b = unitCommandBasis(catalogUnit);
      if (JSON.stringify(a) === JSON.stringify(b)) frozenUnit = a;
    } catch { /* incomplete, hidden, or conflicting source remains unavailable */ }
  }
  const unitState = !unitId || !catalogUnit ? "unavailable"
    : !catalogUnit.eligibleForCapture ? "needs_dimensions"
    : frozenUnit ? "ready" : "unavailable";
  const canSwitch = catalogReady && !!selection?.eligibleNow && view?.capability.mode === "active" &&
    !!state?.actions.canSwitch && !!view.observation && !!view.stream &&
    headReady && !pending && !busy;
  const choices: ActivityChoice[] = catalogReady && selection ? selection.activities.map((activity) => ({
    selectionId: selection.selectionId, selectionRevision: selection.selectionRevision,
    menuVersionId: selection.menuVersionId, definitionVersionId: activity.definitionVersionId,
    definitionId: activity.definitionId, scope: activity.scope,
    label: { en: activity.labelEn, es: activity.labelEs }, kind: activity.machineSelection ? "machinery" : "activity",
    fields: activity.typedFields, ...choiceTotals(totals.data, activity.definitionVersionId, totals.liveElapsedMicros),
    eligible: activity.eligibleNow,
    unavailableReason: activity.eligibleNow ? undefined : { en: "This activity is unavailable.", es: "Esta actividad no está disponible." },
  })) : [];
  const runningCapture = state?.activity?.visibility === "available" ? state.activity.capture : null;
  const running: RunningActivity | null = state?.status === "running" && runningCapture &&
    state.activity?.visibility === "available" && state.activity.project.visibility === "available"
    && state.activity.project.id === project.id ? {
      projectId: project.id, definitionVersionId: runningCapture.definitionVersionId,
      unitId: runningCapture.scope === "specific" ? runningCapture.unitAtStart?.id ?? null : null,
      label: { en: runningCapture.labelEn, es: runningCapture.labelEs }, scope: runningCapture.scope,
      machine: runningCapture.machineKind, status: "confirmed",
    } : null;

  useEffect(() => {
    alive.current = true;
    let active = true;
    void getActivityDeviceId().then((id) => { if (active && current()) setDeviceId(id); })
      .catch(() => { if (active && current()) setDeviceError(true); });
    return () => { active = false; alive.current = false; };
  // This child is remounted on owner/generation/project change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!deviceId) return;
    let active = true;
    setRecovered(false);
    void getCurrentActivityCommand(owner, deviceId).then(async (row) => {
      if (!active || !current()) return;
      setHead(row); setRecovered(true);
      if (row?.uncertain && !row.receipt) {
        const outcome = await dispatchSavedActivityCommand(deviceId, row.commandId, { userId: owner, generation }, "first_attempt");
        if (!active || !current()) return;
        if (outcome.kind === "settled") {
          setHead({ ...row, receipt: outcome.receipt, uncertain: false });
          setMessage(outcome.receipt.status === "applied" || outcome.receipt.status === "noop" ? null : t.rejected);
          await snapshot.refresh();
        } else setMessage(t.saved);
      }
    }).catch(() => { if (active && current()) { setRecovered(true); setRecoveryError(true); setMessage(t.storage); } });
    return () => { active = false; };
  // Recovery is only for this owner/device mount. A locale change changes copy, not recovery authority.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, owner, generation]);

  async function refreshReads(reopen = false) {
    if (!current() || (!reviewOpen.current && !reopen) || selectionLifetime.current !== selectionEpoch || liveUnitId.current !== unitId
      || refreshingSelection.current === selectionEpoch) return;
    if (reopen) reviewOpen.current = true;
    refreshingSelection.current = selectionEpoch;
    closeReview();
    try {
      await Promise.all([snapshot.refresh(), catalog.refresh(), tab === "specific" && unitId ? basis.refresh() : Promise.resolve()]);
    } finally {
      if (refreshingSelection.current === selectionEpoch) refreshingSelection.current = null;
      if (current() && selectionLifetime.current === selectionEpoch) repaintSelection(n => n + 1);
    }
  }
  // Activity receipts belong to the current login/device stream even if its
  // selected unit changed during delivery. Refresh the latest committed read
  // callbacks so the activity controls recover, while closing review first.
  const refreshAfterActivity = useRef(async () => {});
  useLayoutEffect(() => {
    refreshAfterActivity.current = async () => {
      if (!current()) return;
      closeReview();
      await Promise.all([snapshot.refresh(), catalog.refresh(), unitId ? basis.refresh() : Promise.resolve()]);
    };
  });
  async function saveDimension(data: Readonly<Record<string, unknown>>) {
    if (!dimensionEntry || !unitId || !reviewOpen.current || selectionLifetime.current !== selectionEpoch || liveUnitId.current !== unitId || data.id !== unitId || !current() ||
      !Number.isSafeInteger(data.revision) || (data.revision as number) < 1 ||
      !Number.isSafeInteger(data.expected_fact_revision) || (data.expected_fact_revision as number) < 0) throw new Error(t.review);
    closeReview();
    setDimensionHolds((old) => ({ ...old, [unitId]: {
      unitRevision: data.revision as number, factRevision: data.expected_fact_revision as number,
    } }));
    await dimensionEntry.onSave(data);
  }
  async function dispatchOriginal(row: ActivityCommandRecord, policy: "first_attempt" | "retry_original") {
    const outcome = await dispatchSavedActivityCommand(deviceId!, row.commandId, { userId: owner, generation }, policy);
    if (!current()) return;
    if (outcome.kind === "settled") {
      setHead({ ...row, receipt: outcome.receipt, uncertain: false });
      setMessage(outcome.receipt.status === "applied" || outcome.receipt.status === "noop" ? null : t.rejected);
      await refreshAfterActivity.current();
    } else {
      if (outcome.kind === "unknown" || outcome.reason === "receipt_unknown") setHead({ ...row, uncertain: true });
      setMessage(outcome.kind === "unknown" || outcome.reason === "receipt_unknown" ? t.saved : t.held);
    }
  }
  async function act(intent: Intent) {
    if (inFlight.current || !source || !deviceId || !current() || !recovered || !snapshotReady) return;
    closeReview();
    inFlight.current = true; setBusy(true); setMessage(null);
    try {
      const saved = await saveActivityTap(deviceId, source, intent);
      if (!current()) return;
      if (saved.kind === "saved") {
        // Native transaction has committed before any pending state or RPC.
        setHead(saved.record);
        await dispatchOriginal(saved.record, "first_attempt");
      } else setMessage(saved.kind === "unavailable" ? t.storage : t.review);
    } catch {
      // A failed return may happen on either side of the native commit. Do not
      // claim a saved command or permit another tap until a new mount rereads it.
      try { const row = await getCurrentActivityCommand(owner, deviceId); if (current()) setHead(row); } catch { /* keep blocked */ }
      if (current()) { setRecoveryError(true); setMessage(t.review); }
    } finally { inFlight.current = false; if (current()) setBusy(false); }
  }
  async function retryOriginal() {
    if (!head || head.receipt || !deviceId || inFlight.current || !current()) return;
    closeReview();
    inFlight.current = true; setBusy(true);
    try { await dispatchOriginal(head, "retry_original"); }
    catch { if (current()) setMessage(t.saved); }
    finally { inFlight.current = false; if (current()) setBusy(false); }
  }
  function onStart(intent: ActivityIntent): Promise<void> {
    if (!canSwitch || intent.projectId !== project.id || !selection ||
      intent.selectionId !== selection.selectionId || intent.selectionRevision !== selection.selectionRevision ||
      intent.menuVersionId !== selection.menuVersionId ||
      !selection.activities.some((a) => a.definitionVersionId === intent.definitionVersionId && a.scope === intent.scope && a.eligibleNow) ||
      (intent.scope === "specific" && (!frozenUnit || JSON.stringify(intent.unit) !== JSON.stringify(frozenUnit))) ||
      (intent.scope === "general" && intent.unit !== null)) return Promise.resolve();
    return act({ kind: "switch", ...intent, values: Object.fromEntries(Object.entries(intent.values).map(([key, value]) =>
      [key, Array.isArray(value) ? [...(value as readonly string[])] : value])) as Record<string, string | number | boolean | string[]> });
  }
  let displayCatalog: Parameters<typeof ProjectActivityView>[0]["catalog"];
  if (deviceError || recoveryError) displayCatalog = emptyCatalog(deviceError ? t.storage : t.review);
  else if (!privacyReady || snapshot.state === "loading" || catalog.state === "loading") {
    displayCatalog = { ...emptyCatalog(t.loading), status: "loading" };
  } else if (!catalogReady) displayCatalog = emptyCatalog(t.unavailable);
  else displayCatalog = { status: "ready", capturable: canSwitch, blockReason: pending ? t.saved : t.review,
    general: choices.filter((c) => c.scope === "general"), specific: choices.filter((c) => c.scope === "specific") };
  const allowControl = snapshotReady && !!view?.observation && recovered && !pending && !busy;
  // A human may explicitly establish a new generation even while the old
  // generation has an uncertain head. The planner fences it to the observed
  // previous generation/head; the original request remains in the journal.
  const canEstablish = snapshotReady && !!view?.observation && recovered && !busy && !!state?.actions.canEstablishStream;
  const canStop = allowControl && headReady && !!state?.actions.canStop;
  const canFinish = allowControl && headReady && view?.capability.mode === "active" && !!state?.actions.canFinishSetup &&
    props.setupAllocation?.projectId === project.id && !!state.shift;
  return <div className="selected-job-work">
    <ProjectActivityView locale={locale} project={project} tab={tab} onTabChange={next => { selectionLifetime.current++; closeReview(); reviewOpen.current = true; repaintSelection(n => n + 1); setTab(next); }}
      paidSeconds={props.paidSeconds} scopeSeconds={{ general: tab === "general" ? personalScopeSeconds(totals.data, totals.liveElapsedMicros) : null,
        specific: tab === "specific" ? personalScopeSeconds(totals.data, totals.liveElapsedMicros) : null }} running={running}
      catalog={displayCatalog} units={props.units} selectedUnitId={unitId}
      selectedUnitState={unitState} selectedUnitBasis={frozenUnit}
      selectedUnitBlockReason={unitState === "needs_dimensions" ? t.dimensions : t.unit}
      onSelectUnit={(id) => {
        selectionLifetime.current++; closeReview(); reviewOpen.current = true; repaintSelection(n => n + 1);
        const next = props.units.some((u) => u.id === id) ? id : null;
        liveUnitId.current = next; setSelectedUnitId(next);
      }}
      onAddUnit={() => leaveReview(props.onAddUnit)} dimensionsSlot={dimensionEntry ? <SelectedJobUnitDimensions {...dimensionEntry}
        projectId={project.id} selectedUnitId={unitId} unitBasis={matchingUnitBasis} enabled={catalogReady}
        pendingUnitIds={dimensionHeld && unitId ? [...new Set([...dimensionEntry.pendingUnitIds, unitId])] : dimensionEntry.pendingUnitIds}
        onSave={saveDimension} onRefreshActivity={refreshReads} /> : props.dimensionsSlot} unitActionsSlot={props.unitActionsSlot}
      activityPending={busy || pending} activityStatus={message ? { kind: "info", message } : null}
      onStartActivity={onStart} onOpenClock={() => { closeReview(); props.onOpenClock(); }} onBreak={() => { closeReview(); props.onBreak(); }}
      onClockOut={() => { closeReview(); props.onClockOut(); }} onSchedule={() => leaveReview(props.onSchedule)} onAsk={() => leaveReview(props.onAsk)} />
    {tab === "specific" && unitId && <Suspense fallback={<p role="status">{locale === "es" ? "Cargando revisión…" : "Loading review…"}</p>}>
      <UnitReview source={reviewSource} login={{ userId: owner, generation }} projectId={project.id} unitId={unitId}
        admitted={reviewAdmitted} unitRequestStartedAt={basis.data?.requestStartedAt ?? NaN}
        catalogRequestStartedAt={catalog.data?.requestStartedAt ?? NaN} onRefresh={refreshReads} locale={locale} />
    </Suspense>}
    <Suspense fallback={<p role="status">{locale === "es" ? "Cargando totales…" : "Loading totals…"}</p>}>
      <ActivityTotals totals={totals} onRefresh={() => refreshReads(true)} />
    </Suspense>
    <Suspense fallback={<p role="status">{locale === "es" ? "Cargando colaboradores…" : "Loading contributors…"}</p>}>
      <Contributors projectId={project.id} unitId={unitId} locale={locale}
        enabled={tab === "specific" && !!unitId} selectionRevision={contributorRevision}
        admitted={contributorAdmitted} invalidationSource={contributorSource} />
    </Suspense>
    <div className="selected-job-work-controls">
      {canEstablish && <button type="button" disabled={busy} onClick={() => void act({ kind: "establish_stream", previousGeneration: null, previousHeadCommandId: null })}>{t.ready}</button>}
      {canStop && <button type="button" disabled={busy} onClick={() => void act({ kind: "stop" })}>{t.stop}</button>}
      {canFinish && <button type="button" disabled={busy} onClick={() => void act({ kind: "finish_setup", projectId: project.id, costCodeId: props.setupAllocation!.costCodeId })}>{t.finish}</button>}
      {pending && <button type="button" disabled={busy} onClick={() => void retryOriginal()}>{head?.uncertain ? t.retry : t.send}</button>}
    </div>
  </div>;
}
