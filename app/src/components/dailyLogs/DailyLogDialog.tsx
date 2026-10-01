// The daily log filing dialog (wave L, L3; extended 2026-10-01 for Horizon
// parity / window-stage progress). Both entry points — the job page's Logs
// tab (DailyLogsTab.tsx) and the cross-job Daily Logs page — mount this same
// component with just a projectId and a logDate; it resolves the rest itself:
//   - a log already filed for that job-day -> seed the form from IT
//     (editing = the same upsert, never a freshly recomputed draft that
//     could silently overwrite what a foreman actually wrote), else
//   - seed from buildDraftForJobDay's factual, fully-editable starting point.
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { Minus, Plus, X } from "lucide-react";
import { LogTextArea } from "./LogTextArea";
import { LogPhotoCapture } from "./LogPhotoCapture";
import "./dailyLogs.css";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useT, type TFn, type TKey } from "../../lib/i18n";
import { formatApiError } from "../../lib/errors";
import { pushToast, toastSuccess } from "../../lib/toast";
import { formatLogDateLabel } from "../../lib/dailyLogDay";
import { signInMark, signedInUserId, stillSignedInAs, subscribeSignedIn, type SignInMark } from "../../lib/signedIn";
import { clearManualDailyLogDraft, loadManualDailyLogDraft, saveManualDailyLogDraft, type ManualDailyLogDraft, type ManualDailyLogFields } from "../../lib/manualDailyLogDraft";
import { mergeQueuedDailyLog, type ProgressConflict } from "../../lib/dailyLogMerge";
import { clearProgressConflicts, loadProgressConflicts } from "../../lib/dailyLogProgressConflicts";
import { reconcileDailyLogPendingPhotos } from "../../lib/offline/dailyLogPendingPhotos";
import { dailyLogPhotoUploader } from "../../lib/offline/dailyLogPhotoUploader";
import { useOverlayWhile } from "../../lib/pwa/useSafeSurface";
import {
  buildDraftForJobDay,
  fileDailyLog,
  getDailyLog,
  isStaleDailyLogError,
  listDailyLogs,
  type DailyLog,
  type DailyLogReflection,
} from "../../lib/dailyLogs";
import {
  clampPercent,
  COVERS_OPTIONS,
  DELAY_ATTRIBUTIONS,
  DELAY_CAUSES,
  DELAY_STATUSES,
  emptyProgressFields,
  isWorkStageKey,
  MISSING_ITEM_KINDS,
  NON_STAGE_WORK_KEYS,
  previousStageValue,
  SAFETY_STATUS_OPTIONS,
  stageProgressCaption,
  WEATHER_IMPACT_OPTIONS,
  WORK_STAGE_KEYS,
  type Covers,
  type DelayAttribution,
  type DelayCause,
  type DelayEntry,
  type DelayStatus,
  type MissingItem,
  type MissingItemKind,
  type SafetyStatus,
  type WeatherImpact,
  type WorkChipKey,
  type WorkStageKey,
} from "../../lib/dailyLogStages";

const REFLECTION_FIELDS: { key: keyof DailyLogReflection; labelKey: TKey }[] = [
  { key: "went_well", labelKey: "dailyLog.field.wentWell" },
  { key: "went_poorly", labelKey: "dailyLog.field.wentPoorly" },
  { key: "would_have_helped", labelKey: "dailyLog.field.wouldHaveHelped" },
  { key: "what_worked", labelKey: "dailyLog.field.whatWorked" },
];

const STAGE_LABEL_KEYS: Record<WorkStageKey, TKey> = {
  prep: "dailyLog.stage.prep",
  flashing: "dailyLog.stage.flashing",
  frames: "dailyLog.stage.frames",
  glass: "dailyLog.stage.glass",
  doors: "dailyLog.stage.doors",
  hardware: "dailyLog.stage.hardware",
  sealing: "dailyLog.stage.sealing",
  qc: "dailyLog.stage.qc",
  site_clean: "dailyLog.stage.siteClean",
};
const NON_STAGE_LABEL_KEYS: Record<(typeof NON_STAGE_WORK_KEYS)[number], TKey> = {
  corrections: "dailyLog.chip.corrections",
  material_run: "dailyLog.chip.materialRun",
};
const COVERS_LABEL_KEYS: Record<Covers, TKey> = {
  windows: "dailyLog.covers.windows",
  doors: "dailyLog.covers.doors",
  both: "dailyLog.covers.both",
};
const WEATHER_IMPACT_LABEL_KEYS: Record<WeatherImpact, TKey> = {
  slowed: "dailyLog.weatherImpact.slowed",
  stopped: "dailyLog.weatherImpact.stopped",
  none: "dailyLog.weatherImpact.none",
};
const DELAY_CAUSE_LABEL_KEYS: Record<DelayCause, TKey> = {
  material: "dailyLog.delays.cause.material",
  weather: "dailyLog.delays.cause.weather",
  equipment: "dailyLog.delays.cause.equipment",
  access: "dailyLog.delays.cause.access",
  other: "dailyLog.delays.cause.other",
};
const DELAY_STATUS_LABEL_KEYS: Record<DelayStatus, TKey> = {
  happened: "dailyLog.delays.status.happened",
  still_going: "dailyLog.delays.status.stillGoing",
};
const DELAY_ATTRIBUTION_LABEL_KEYS: Record<DelayAttribution, TKey> = {
  builder: "dailyLog.delays.attribution.builder",
  forge: "dailyLog.delays.attribution.forge",
  weather: "dailyLog.delays.attribution.weather",
  other: "dailyLog.delays.attribution.other",
};
const MISSING_KIND_LABEL_KEYS: Record<MissingItemKind, TKey> = {
  material: "dailyLog.missingTomorrow.material",
  equipment: "dailyLog.missingTomorrow.equipment",
};
const PROGRESS_CONFLICT_LABEL_KEYS: Partial<Record<ProgressConflict["field"], TKey>> = {
  workStages: "dailyLog.conflict.field.workStages",
  stageProgress: "dailyLog.conflict.field.stageProgress",
  covers: "dailyLog.conflict.field.covers",
  delays: "dailyLog.conflict.field.delays",
  safetyStatus: "dailyLog.conflict.field.safetyStatus",
  weatherImpact: "dailyLog.conflict.field.weatherImpact",
  missingTomorrow: "dailyLog.conflict.field.missingTomorrow",
  tomorrowStages: "dailyLog.conflict.field.tomorrowStages",
  tomorrowCrewExpected: "dailyLog.conflict.field.tomorrowCrewExpected",
  tomorrowPlan: "dailyLog.conflict.field.tomorrowPlan",
  unitsToday: "dailyLog.conflict.field.unitsToday",
  unitsToDate: "dailyLog.conflict.field.unitsToDate",
  unitsRemaining: "dailyLog.conflict.field.unitsRemaining",
  unitsRemainingDetail: "dailyLog.conflict.field.unitsRemainingDetail",
};

const EMPTY_FIELDS: ManualDailyLogFields = { headline: "", notes: "", dayFlow: null, reflection: {}, weather: "", ...emptyProgressFields() };

/** Only the fields with something actually typed in them — reflection is
 * optional even on a Fine/Stuck day, and Smooth clears it entirely. */
function reflectionOrNull(r: DailyLogReflection): DailyLogReflection | null {
  const out: DailyLogReflection = {};
  for (const { key } of REFLECTION_FIELDS) {
    const v = r[key]?.trim();
    if (v) out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function newDelay(cause: DelayCause): DelayEntry {
  return { cause, description: "", minutes: null, status: "happened", attribution: "forge" };
}

/** Notes are optional (owner acceptance review, 2026-10-01): left blank, the
 * saved note is an honest account of the stage chips actually picked, never
 * a fabricated default. PURE given the translator, so it is easy to reason
 * about at the one call site that uses it. */
function synthesizeNotes(
  workStages: WorkChipKey[],
  stageLabels: Record<WorkStageKey, TKey>,
  t: TFn,
): string {
  const picked = workStages.filter(isWorkStageKey).map((s) => t(stageLabels[s]));
  if (picked.length === 0) return t("dailyLog.notes.noneRecorded");
  return t("dailyLog.notes.autoPrefix", { stages: picked.join(", ") });
}

function newMissingItem(): MissingItem {
  return { description: "", kind: "material" };
}

export function DailyLogDialog({
  projectId,
  logDate,
  jobLabel,
  onClose,
  onSaved,
}: {
  projectId: string;
  logDate: string;
  jobLabel: string;
  onClose: () => void;
  onSaved?: (log: DailyLog) => void;
}) {
  const t = useT();
  const reviewedConflict=useRef<string|null>(null);
  const [photoBusy,setPhotoBusy]=useState(false);
  const [photoStorageIssue,setPhotoStorageIssue]=useState(false);
  const titleId = useId();
  const queryClient = useQueryClient();
  const ownerId = useSyncExternalStore(subscribeSignedIn, signedInUserId, () => null);
  // Mounted only while open, and traps no focus, so it declares itself.
  useOverlayWhile(true);
  const existing = useQuery({
    queryKey: ["dailyLog", projectId, logDate, ownerId],
    queryFn: () => getDailyLog(projectId, logDate),
  });
  const draft = useQuery({
    queryKey: ["dailyLogDraft", projectId, logDate, ownerId],
    queryFn: () => buildDraftForJobDay(projectId, logDate),
    // No point building a draft for a day that's already filed — editing an
    // existing log shows what was actually saved, not a recomputed guess.
    enabled: existing.isSuccess && existing.data == null,
  });
  // Earlier logs on this SAME job, for "was N%" stage captions — a stage
  // worked Monday and again Thursday must show Monday's cumulative reading,
  // not an invented 0. Scoped to installer-and-up reads, same as every other
  // daily_logs query here.
  const history = useQuery({
    queryKey: ["dailyLogs", projectId],
    queryFn: () => listDailyLogs(projectId),
  });
  const priorLogs = (history.data ?? []).filter((l) => l.log_date < logDate);

  const [seeded, setSeeded] = useState(false);
  const [fields, setFields] = useState<ManualDailyLogFields>(EMPTY_FIELDS);
  const [baseRevision, setBaseRevision] = useState<number | null>(null);
  const [pending, setPending] = useState<ManualDailyLogDraft | null>(() => ownerId ? loadManualDailyLogDraft(ownerId, projectId, logDate) : null);
  const [storageFailed, setStorageFailed] = useState(false);
  const [stale, setStale] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [stateOwnerId, setStateOwnerId] = useState(ownerId);
  // True once the person has touched the tomorrow-stage chips themselves —
  // until then, tomorrow silently tracks today's stage picks (the brief's
  // own rule: "auto-follow initial work selection; never override later
  // choices").
  const tomorrowTouched = useRef(false);
  const latestFields = useRef(fields);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const [progressConflict, setProgressConflict] = useState(() =>
    ownerId ? loadProgressConflicts(ownerId, projectId, logDate) : null);

  useEffect(() => {
    setPending(ownerId ? loadManualDailyLogDraft(ownerId, projectId, logDate) : null);
    setProgressConflict(ownerId ? loadProgressConflicts(ownerId, projectId, logDate) : null);
    setSeeded(false);
    setFields(EMPTY_FIELDS);
    latestFields.current = EMPTY_FIELDS;
    tomorrowTouched.current = false;
    setBaseRevision(null);
    setStale(false);
    setDirty(false);
    setStateOwnerId(ownerId);
  }, [ownerId, projectId, logDate]);

  function edit(next: ManualDailyLogFields) {
    latestFields.current = next;
    setFields(next);
    setSeeded(true);
    setDirty(true);
    if (!ownerId) { setStorageFailed(true); return; }
    try {
      saveManualDailyLogDraft({ version: 1, ownerId, projectId, logDate, baseRevision, fields: next, savedAt: new Date().toISOString() });
      setStorageFailed(false);
    } catch { setStorageFailed(true); }
  }

  /** Toggle a "what did the crew work on today" chip. Mirrors into tomorrow's
   * stage chips while the person hasn't touched those yet. */
  function toggleWorkChip(key: WorkChipKey) {
    const has = fields.workStages.includes(key);
    const workStages = has ? fields.workStages.filter((k) => k !== key) : [...fields.workStages, key];
    const stageProgress = { ...fields.stageProgress };
    if (has && isWorkStageKey(key)) delete stageProgress[key];
    const next: ManualDailyLogFields = { ...fields, workStages, stageProgress };
    if (!tomorrowTouched.current) {
      next.tomorrowStages = workStages.filter(isWorkStageKey);
    }
    edit(next);
  }

  function setStageProgress(stage: WorkStageKey, value: number) {
    edit({ ...fields, stageProgress: { ...fields.stageProgress, [stage]: clampPercent(value) } });
  }

  function toggleTomorrowStage(stage: WorkStageKey) {
    tomorrowTouched.current = true;
    const has = fields.tomorrowStages.includes(stage);
    edit({ ...fields, tomorrowStages: has ? fields.tomorrowStages.filter((s) => s !== stage) : [...fields.tomorrowStages, stage] });
  }

  function updateDelay(index: number, patch: Partial<DelayEntry>) {
    const delays = fields.delays.map((d, i) => (i === index ? { ...d, ...patch } : d));
    edit({ ...fields, delays });
  }
  function removeDelay(index: number) {
    edit({ ...fields, delays: fields.delays.filter((_, i) => i !== index) });
  }
  /** Matches the actual Horizon reference (owner acceptance review,
   * 2026-10-01): picking a CAUSE chip is what opens or closes that cause's
   * own card — one card per cause, never a free-floating "Add a delay" list.
   * Picking "Nothing" clears every card at once. */
  function toggleDelayCause(cause: DelayCause) {
    const has = fields.delays.some((d) => d.cause === cause);
    edit({
      ...fields,
      delays: has ? fields.delays.filter((d) => d.cause !== cause) : [...fields.delays, newDelay(cause)],
    });
  }
  function clearDelays() {
    edit({ ...fields, delays: [] });
  }

  function updateMissing(index: number, patch: Partial<MissingItem>) {
    edit({ ...fields, missingTomorrow: fields.missingTomorrow.map((m, i) => (i === index ? { ...m, ...patch } : m)) });
  }
  function removeMissing(index: number) {
    edit({ ...fields, missingTomorrow: fields.missingTomorrow.filter((_, i) => i !== index) });
  }
  function addMissing() {
    edit({ ...fields, missingTomorrow: [...fields.missingTomorrow, newMissingItem()] });
  }

  function discard() {
    if (ownerId) {
      try { clearManualDailyLogDraft(ownerId, projectId, logDate); } catch { setStorageFailed(true); return; }
    }
    setPending(null);
  }

  function resume() {
    if (!pending) return;
    latestFields.current = pending.fields;
    setFields(pending.fields);
    setBaseRevision(pending.baseRevision);
    setSeeded(true);
    setDirty(true);
    setPending(null);
  }

  function dismissProgressConflict() {
    if (ownerId) clearProgressConflicts(ownerId, projectId, logDate);
    setProgressConflict(null);
  }

  /** Load the phone's own COMPLETE structured answer back into the editable
   * form — the whole queuedSnapshot, never a per-field patchwork rebuilt
   * from individual conflicts (that can assemble a combination — e.g. a
   * newer unitsToDate beside an older unitsRemaining — nobody actually
   * reported). A deliberate human choice, never automatic: the person still
   * has to press Save, which re-checks the CURRENT revision. */
  function restoreProgressConflict() {
    if (!progressConflict || !existing.isSuccess) return;
    reviewedConflict.current=JSON.stringify(progressConflict);
    edit({ ...fields, ...progressConflict.queuedSnapshot });
    setBaseRevision(existing.data?.revision??0);
    setStale(false);
  }

  function combineWithCurrent() {
    if (!existing.isSuccess || !ownerId || (existing.data && !Number.isSafeInteger(existing.data.revision))) return;
    const { merged, progressConflicts } = mergeQueuedDailyLog({
      projectId, logDate,
      headline: fields.headline || null, notes: fields.notes, dayFlow: fields.dayFlow,
      reflection: reflectionOrNull(fields.reflection), weather: fields.weather || null,
      baseRevision,
      // The form always carries a deliberate, complete structured answer —
      // never the "this caller never knew about these fields" case.
      progressProvided: true,
      workStages: fields.workStages, stageProgress: fields.stageProgress, covers: fields.covers,
      delays: fields.delays, safetyStatus: fields.safetyStatus, weatherImpact: fields.weatherImpact,
      missingTomorrow: fields.missingTomorrow, tomorrowStages: fields.tomorrowStages,
      tomorrowCrewExpected: fields.tomorrowCrewExpected, tomorrowPlan: fields.tomorrowPlan,
      unitsToday: fields.unitsToday, unitsToDate: fields.unitsToDate, unitsRemaining: fields.unitsRemaining,
      unitsRemainingDetail: fields.unitsRemainingDetail,
    }, existing.data ?? null);
    const next: ManualDailyLogFields = {
      headline: merged.headline ?? "", notes: merged.notes,
      dayFlow: merged.dayFlow, reflection: merged.reflection ?? {}, weather: merged.weather ?? "",
      workStages: merged.workStages, stageProgress: merged.stageProgress, covers: merged.covers,
      delays: merged.delays, safetyStatus: merged.safetyStatus, weatherImpact: merged.weatherImpact,
      missingTomorrow: merged.missingTomorrow, tomorrowStages: merged.tomorrowStages,
      tomorrowCrewExpected: merged.tomorrowCrewExpected, tomorrowPlan: merged.tomorrowPlan,
      unitsToday: merged.unitsToday, unitsToDate: merged.unitsToDate, unitsRemaining: merged.unitsRemaining,
      unitsRemainingDetail: merged.unitsRemainingDetail,
    };
    const revision = existing.data?.revision ?? 0;
    setBaseRevision(revision);
    setFields(next);
    latestFields.current = next;
    try {
      saveManualDailyLogDraft({ version: 1, ownerId, projectId, logDate, baseRevision: revision,
        fields: next, savedAt: new Date().toISOString() });
      setStorageFailed(false);
    } catch { setStorageFailed(true); }
    setStale(false);
    if (progressConflicts.length > 0) {
      // Immediate (online) conflict — resolved right here, not left for a
      // later banner; still never choosing silently: say what was kept.
      const names = progressConflicts
        .map((c) => PROGRESS_CONFLICT_LABEL_KEYS[c.field] && t(PROGRESS_CONFLICT_LABEL_KEYS[c.field]!))
        .filter(Boolean)
        .join(", ");
      pushToast(t("dailyLog.conflict.keptSaved", { fields: names }), "info");
    }
  }

  useEffect(() => {
    if (seeded || pending) return;
    if (existing.data) {
      const d = existing.data;
      const next: ManualDailyLogFields = {
        headline: d.headline ?? "", notes: d.notes ?? "",
        dayFlow: d.day_flow, reflection: d.reflection ?? {}, weather: d.weather ?? "",
        workStages: d.workStages, stageProgress: d.stageProgress, covers: d.covers,
        delays: d.delays, safetyStatus: d.safetyStatus, weatherImpact: d.weatherImpact,
        missingTomorrow: d.missingTomorrow, tomorrowStages: d.tomorrowStages,
        tomorrowCrewExpected: d.tomorrowCrewExpected, tomorrowPlan: d.tomorrowPlan,
        unitsToday: d.unitsToday, unitsToDate: d.unitsToDate, unitsRemaining: d.unitsRemaining,
        unitsRemainingDetail: d.unitsRemainingDetail,
      };
      tomorrowTouched.current = d.tomorrowStages.length > 0;
      latestFields.current = next;
      setFields(next);
      setBaseRevision(d.revision ?? null);
      setSeeded(true);
    } else if (existing.isSuccess && existing.data == null && draft.data) {
      const next = { ...latestFields.current, headline: /^0 units installed.*0 crew/.test(draft.data.headline) ? "" : draft.data.headline, notes: draft.data.notesDraft };
      latestFields.current = next;
      setFields(next);
      setBaseRevision(0);
      setSeeded(true);
    }
  }, [seeded, pending, existing.data, existing.isSuccess, draft.data]);

  const save = useMutation({
    mutationFn: (request: { ownerId: string; mark: SignInMark; fields: ManualDailyLogFields; revision: number | null; reviewedConflict: string|null }) => {
      if (!stillSignedInAs(request.mark, request.ownerId)) throw new Error("Sign-in changed before the daily log could save");
      return fileDailyLog({
        ownerId:request.ownerId,
        projectId,
        logDate,
        headline: request.fields.headline.trim() || null,
        notes: request.fields.notes.trim(),
        dayFlow: request.fields.dayFlow,
        // Smooth (or nothing picked) hides the reflection inputs; saving
        // clears whatever might still be sitting in their state, per spec.
        reflection: request.fields.dayFlow === "smooth" || request.fields.dayFlow === null ? null : reflectionOrNull(request.fields.reflection),
        weather: request.fields.weather.trim() || null,
        baseRevision: request.revision,
        reviewedConflict: request.reviewedConflict,
        workStages: request.fields.workStages,
        stageProgress: request.fields.stageProgress,
        covers: request.fields.covers,
        delays: request.fields.delays.filter((d) => d.description.trim()),
        safetyStatus: request.fields.safetyStatus,
        weatherImpact: request.fields.weatherImpact,
        missingTomorrow: request.fields.missingTomorrow.filter((m) => m.description.trim()),
        tomorrowStages: request.fields.tomorrowStages,
        tomorrowCrewExpected: request.fields.tomorrowCrewExpected,
        tomorrowPlan: request.fields.tomorrowPlan?.trim() || null,
        unitsToday: request.fields.unitsToday,
        unitsToDate: request.fields.unitsToDate,
        unitsRemaining: request.fields.unitsRemaining,
        unitsRemainingDetail: request.fields.unitsRemainingDetail?.trim() || null,
      });
    },
    onSuccess: async (result, request) => {
      if (!mounted.current || !stillSignedInAs(request.mark, request.ownerId)) return;
      let newerDraft = JSON.stringify(latestFields.current) !== JSON.stringify(request.fields);
      try {
        const current = loadManualDailyLogDraft(request.ownerId, projectId, logDate);
        if (current && current.baseRevision === request.revision && JSON.stringify(current.fields) === JSON.stringify(request.fields))
          clearManualDailyLogDraft(request.ownerId, projectId, logDate);
        else if (current) newerDraft = true;
      } catch { setStorageFailed(true); }
      // The same calm sentence the photo sheet gives when there is no signal.
      // To the foreman standing in the canyon the log IS written — it is on
      // their phone and it will go — so this says where it is, not that
      // something went wrong.
      toastSuccess(result.queued ? t("dailyLog.savedOffline") : t("dailyLog.saved"));
      queryClient.invalidateQueries({ queryKey: ["dailyLogs", projectId] });
      queryClient.invalidateQueries({ queryKey: ["dailyLog", projectId, logDate] });
      queryClient.invalidateQueries({ queryKey: ["jobsNeedingLog"] });
      queryClient.invalidateQueries({ queryKey: ["dailyLogsAcrossJobs"] });
      // Log-save and photo-attach are reported separately (owner acceptance
      // review, 2026-10-01): the save toast above already fired; any photo
      // taken before this log had an id is reconciled here with the id Save
      // JUST returned, fire-and-forget — a clean save with no draft conflict
      // closes this dialog right away, so LogPhotoCapture's own mount effect
      // would not get a re-render with the new id to react to. A queued
      // (offline) save has no id yet; those pending photos reconcile the
      // next time this job-day is reopened, once the queued entry syncs.
      if (result.log && request.ownerId) {
        try{
          const outcome=await reconcileDailyLogPendingPhotos(
            {ownerId:request.ownerId,projectId,logDate,dailyLogId:result.log.id,uploaderUid:request.ownerId},dailyLogPhotoUploader);
          if(outcome.reconciled)void queryClient.invalidateQueries({queryKey:["dailyLogPhotos",result.log.id]});
          if(outcome.failed){pushToast(t("dailyLog.photos.failed"),"error");return;}
        }catch(e){pushToast(`${t("dailyLog.photos.failed")} — ${formatApiError(e)}`,"error");return;}
      }
      if(!mounted.current || !stillSignedInAs(request.mark,request.ownerId))return;
      if(result.log && request.reviewedConflict && JSON.stringify(loadProgressConflicts(request.ownerId,projectId,logDate))===request.reviewedConflict){
        clearProgressConflicts(request.ownerId,projectId,logDate);setProgressConflict(null);reviewedConflict.current=null;
      }
      if (result.log) onSaved?.(result.log);
      if (newerDraft) {
        setStale(true);
        pushToast(t("dailyLog.draft.newerKept"), "info");
        return;
      }
      onClose();
    },
    onError: (e, request) => {
      if (!mounted.current || !stillSignedInAs(request.mark, request.ownerId)) return;
      if (isStaleDailyLogError(e)) {
        setStale(true);
        queryClient.invalidateQueries({ queryKey: ["dailyLog", projectId, logDate] });
      } else pushToast(formatApiError(e), "error");
    },
  });

  const loading = !pending && !seeded && (existing.isLoading || (existing.data == null && draft.isLoading));
  // "I could not find out whether today's log exists" — which offline is the
  // NORMAL answer, not an error: react-query pauses a query it cannot run, so
  // it never resolves and never fails, and the box below opens empty over a
  // log that may well be sitting on the server. Saying so is the difference
  // between a foreman writing an addendum knowingly and one who thinks they
  // are the first person to write today. What they type is appended to
  // whatever is already there (lib/dailyLogMerge.ts), never swapped for it.
  const cannotCheck = !existing.isSuccess && !existing.isLoading;
  const showReflection = fields.dayFlow === "fine" || fields.dayFlow === "stuck";
  const conflict = stale || (seeded && existing.isSuccess
    && (baseRevision === null || baseRevision !== (existing.data?.revision ?? 0)));
  const crewLine = existing.data == null ? draft.data?.crewLine : null;

  // A sign-in change must not render another person's unsent words while the
  // owner-scoped state resets in the effect above.
  if (ownerId !== stateOwnerId) return null;

  return (
    <div className="modal-backdrop daily-log-backdrop" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={()=>{if(!photoBusy && !photoStorageIssue && !save.isPending)onClose();}}>
      <div className="modal-card daily-log-editor" onClick={(e) => e.stopPropagation()}>
        <header className="daily-log-editor-header">
          <div>
            <h2 id={titleId}>{existing.data ? t("dailyLog.title.edit") : t("dailyLog.title.new")}</h2>
            <p className="daily-log-job">{jobLabel}</p>
            <p className="daily-log-date">{formatLogDateLabel(logDate)}</p>
          </div>
          <button type="button" className="daily-log-close" aria-label={t("dailyLog.action.close")} onClick={()=>{if(!photoBusy && !photoStorageIssue && !save.isPending)onClose();}}>
            <X size={20} aria-hidden="true" />
          </button>
        </header>

        <div className="daily-log-editor-body">
          <p className="daily-log-shared">{t("dailyLog.shared")}</p>

          {progressConflict && progressConflict.conflicts.length > 0 && (
            <div className="daily-log-draft-warning" role="alert">
              <p>{t("dailyLog.conflict.title")}</p>
              <p className="muted">
                {t("dailyLog.conflict.body", {
                  fields: progressConflict.conflicts
                    .map((c) => PROGRESS_CONFLICT_LABEL_KEYS[c.field] && t(PROGRESS_CONFLICT_LABEL_KEYS[c.field]!))
                    .filter(Boolean)
                    .join(", "),
                })}
              </p>
              <button type="button" className="button-like active-pill" disabled={save.isPending} onClick={restoreProgressConflict}>{t("dailyLog.conflict.restore")}</button>
              <button type="button" className="button-like" disabled={save.isPending} onClick={dismissProgressConflict}>{t("dailyLog.conflict.dismiss")}</button>
            </div>
          )}

          {pending && (
            <div className="daily-log-draft-notice" role="status">
              <p>{t("dailyLog.draft.found")}</p>
              {existing.isSuccess && (pending.baseRevision === null || pending.baseRevision !== (existing.data?.revision ?? 0))
                && <p>{t("dailyLog.draft.changed")}</p>}
              <button type="button" className="button-like active-pill" onClick={resume}>{t("dailyLog.draft.resume")}</button>
              <button type="button" className="button-like" onClick={discard}>{t("dailyLog.draft.discard")}</button>
            </div>
          )}
          {storageFailed && <p className="daily-log-draft-warning" role="alert">{t("dailyLog.draft.storageFailed")}</p>}
          {!pending && dirty && !storageFailed && <p className="muted" role="status">{t("dailyLog.draft.local")}</p>}
          {!pending && conflict && (
            <div className="daily-log-draft-warning" role="alert">
              <p>{t("dailyLog.draft.conflict")}</p>
              <button type="button" className="button-like" disabled={!existing.isSuccess || !ownerId || !!existing.data && !Number.isSafeInteger(existing.data.revision)} onClick={combineWithCurrent}>
                {t("dailyLog.draft.combine")}
              </button>
            </div>
          )}
          {loading ? (
            <p className="muted">{t("dailyLog.loading")}</p>
          ) : (
            <>
              {cannotCheck && <p className="muted">{t("dailyLog.cannotCheck")}</p>}

              {/* 1. What did the crew work on today? */}
              <fieldset className="daily-log-field daily-log-fieldset">
                <legend>{t("dailyLog.section.workedOn")}</legend>
                <div className="daily-log-chip-row">
                  {WORK_STAGE_KEYS.map((stage) => (
                    <button key={stage} type="button" className="daily-log-chip" aria-pressed={fields.workStages.includes(stage)}
                      disabled={!!pending} onClick={() => toggleWorkChip(stage)}>
                      {t(STAGE_LABEL_KEYS[stage])}
                    </button>
                  ))}
                  {NON_STAGE_WORK_KEYS.map((key) => (
                    <button key={key} type="button" className="daily-log-chip" aria-pressed={fields.workStages.includes(key)}
                      disabled={!!pending} onClick={() => toggleWorkChip(key)}>
                      {t(NON_STAGE_LABEL_KEYS[key])}
                    </button>
                  ))}
                </div>
                {fields.workStages.filter(isWorkStageKey).map((stage) => {
                  const previous = previousStageValue(priorLogs.map((l) => ({ stageProgress: l.stageProgress, logDate: l.log_date })), stage);
                  const current = fields.stageProgress[stage] ?? previous ?? 0;
                  const { was, deltaToday } = stageProgressCaption(previous, current);
                  return (
                    <div key={stage} className="daily-log-stage-slider">
                      <label htmlFor={`stage-${stage}`}>{t(STAGE_LABEL_KEYS[stage])}</label>
                      <input id={`stage-${stage}`} type="range" min={0} max={100} value={current} disabled={!!pending}
                        onChange={(e) => setStageProgress(stage, Number(e.target.value))} />
                      <span className="daily-log-stage-caption">
                        {current}% — {was === null
                          ? t("dailyLog.stageProgress.firstReading")
                          : t("dailyLog.stageProgress.delta", { was, delta: deltaToday !== null && deltaToday >= 0 ? `+${deltaToday}` : String(deltaToday) })}
                      </span>
                    </div>
                  );
                })}
              </fieldset>

              {/* 2. What does this log cover? */}
              <fieldset className="daily-log-field daily-log-fieldset">
                <legend>{t("dailyLog.section.covers")}</legend>
                <div className="daily-log-chip-row">
                  {COVERS_OPTIONS.map((c) => (
                    <button key={c} type="button" className="daily-log-chip" aria-pressed={fields.covers === c} disabled={!!pending}
                      onClick={() => edit({ ...fields, covers: fields.covers === c ? null : c })}>
                      {t(COVERS_LABEL_KEYS[c])}
                    </button>
                  ))}
                </div>
              </fieldset>

              <label className="daily-log-field">
                <span>{t("dailyLog.field.headline")}</span>
                <LogTextArea
                  aria-label={t("dailyLog.a11y.headline")}
                  rows={2}
                  value={fields.headline}
                  onChange={(e) => edit({ ...fields, headline: e.target.value })}
                  disabled={!!pending}
                />
              </label>
              {crewLine && <p className="daily-log-crew muted">{crewLine}</p>}

              {/* 3. What got done today, in your words? */}
              <label className="daily-log-field daily-log-notes-field">
                <span>{t("dailyLog.field.notes")}</span>
                <LogTextArea
                  aria-label={t("dailyLog.a11y.notes")}
                  rows={7}
                  value={fields.notes}
                  onChange={(e) => edit({ ...fields, notes: e.target.value })}
                  disabled={!!pending}
                  placeholder={t("dailyLog.field.notesPlaceholder")}
                />
              </label>

              {/* 4. Did anything stop work for 30 minutes or more? Horizon's
                  own shape: pick a cause, its own card opens — never a
                  free-floating "Add a delay" list. */}
              <fieldset className="daily-log-field daily-log-fieldset">
                <legend>{t("dailyLog.section.delays")}</legend>
                <div className="daily-log-chip-row">
                  {DELAY_CAUSES.map((cause) => (
                    <button key={cause} type="button" className="daily-log-chip"
                      aria-pressed={fields.delays.some((d) => d.cause === cause)} disabled={!!pending}
                      onClick={() => toggleDelayCause(cause)}>
                      {t(DELAY_CAUSE_LABEL_KEYS[cause])}
                    </button>
                  ))}
                  <button type="button" className="daily-log-chip" aria-pressed={fields.delays.length === 0}
                    disabled={!!pending || fields.delays.length === 0} onClick={clearDelays}>
                    {t("dailyLog.delays.cause.nothing")}
                  </button>
                </div>
                {fields.delays.length === 0 && <p className="muted">{t("dailyLog.delays.none")}</p>}
                {fields.delays.map((d, i) => (
                  <div key={d.cause} className="daily-log-delay-card">
                    <p className="daily-log-delay-cause">{t(DELAY_CAUSE_LABEL_KEYS[d.cause])}</p>
                    <label className="daily-log-field">
                      <span>{t("dailyLog.delays.description")}</span>
                      <input value={d.description} disabled={!!pending} onChange={(e) => updateDelay(i, { description: e.target.value })} />
                    </label>
                    <div className="daily-log-conditions">
                      <label className="daily-log-field">
                        <span>{t("dailyLog.delays.minutes")}</span>
                        <input type="number" min={0} inputMode="numeric" value={d.minutes ?? ""} disabled={!!pending}
                          onChange={(e) => updateDelay(i, { minutes: e.target.value === "" ? null : Math.max(0, Number(e.target.value)) })} />
                      </label>
                      <div className="daily-log-chip-row">
                        {DELAY_STATUSES.map((s) => (
                          <button key={s} type="button" className="daily-log-chip" aria-pressed={d.status === s} disabled={!!pending}
                            onClick={() => updateDelay(i, { status: s })}>{t(DELAY_STATUS_LABEL_KEYS[s])}</button>
                        ))}
                      </div>
                    </div>
                    <div className="daily-log-chip-row">
                      {DELAY_ATTRIBUTIONS.map((a) => (
                        <button key={a} type="button" className="daily-log-chip" aria-pressed={d.attribution === a} disabled={!!pending}
                          onClick={() => updateDelay(i, { attribution: a })}>{t(DELAY_ATTRIBUTION_LABEL_KEYS[a])}</button>
                      ))}
                    </div>
                    <button type="button" className="button-like" disabled={!!pending} onClick={() => removeDelay(i)}>{t("dailyLog.delays.remove")}</button>
                  </div>
                ))}
              </fieldset>

              {/* 5. Safety — private to internal crew, never in shared notes */}
              <fieldset className="daily-log-field daily-log-fieldset">
                <legend>{t("dailyLog.section.safety")}</legend>
                <div className="daily-log-chip-row">
                  {SAFETY_STATUS_OPTIONS.map((s: SafetyStatus) => (
                    <button key={s} type="button" className="daily-log-chip" aria-pressed={fields.safetyStatus === s} disabled={!!pending}
                      onClick={() => edit({ ...fields, safetyStatus: s })}>
                      {t(s === "none_reported" ? "dailyLog.safety.none" : "dailyLog.safety.reported")}
                    </button>
                  ))}
                </div>
                {fields.safetyStatus === "reported" && (
                  <a className="button-like" href="/safety" target="_blank" rel="noreferrer">{t("dailyLog.safety.openSafety")}</a>
                )}
              </fieldset>

              <div className="daily-log-conditions">
                <fieldset className="daily-log-flow">
                  <legend>{t("dailyLog.field.dayFlow")}</legend>
                  <div className="grade-row">
                    {(["smooth", "fine", "stuck"] as const).map((f) => (
                      <button
                        key={f}
                        type="button"
                        aria-pressed={fields.dayFlow === f}
                        className={fields.dayFlow === f
                          ? `grade-btn selected${f === "fine" ? " warn" : f === "stuck" ? " danger" : ""}`
                          : "grade-btn"}
                        disabled={!!pending}
                        onClick={() => edit({ ...fields, dayFlow: fields.dayFlow === f ? null : f })}
                      >
                        {f === "smooth" ? t("dailyLog.flow.smooth")
                          : f === "fine" ? t("dailyLog.flow.fine") : t("dailyLog.flow.stuck")}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <label className="daily-log-field">
                  <span>{t("dailyLog.field.weather")}</span>
                  <input
                    aria-label={t("dailyLog.a11y.weather")}
                    value={fields.weather}
                    onChange={(e) => edit({ ...fields, weather: e.target.value })}
                    disabled={!!pending}
                    placeholder={t("dailyLog.field.weatherPlaceholder")}
                  />
                </label>
              </div>

              {/* 6. Weather impact */}
              <fieldset className="daily-log-field daily-log-fieldset">
                <legend>{t("dailyLog.section.weatherImpact")}</legend>
                <div className="daily-log-chip-row">
                  {WEATHER_IMPACT_OPTIONS.map((w) => (
                    <button key={w} type="button" className="daily-log-chip" aria-pressed={fields.weatherImpact === w} disabled={!!pending}
                      onClick={() => edit({ ...fields, weatherImpact: fields.weatherImpact === w ? null : w })}>
                      {t(WEATHER_IMPACT_LABEL_KEYS[w])}
                    </button>
                  ))}
                </div>
              </fieldset>

              {showReflection && (
                <div className="daily-log-reflections">
                  {REFLECTION_FIELDS.map(({ key, labelKey }) => (
                    <label className="daily-log-field" key={key}>
                      <span>{t(labelKey)}</span>
                      <LogTextArea
                        aria-label={t(labelKey)}
                        rows={3}
                        value={fields.reflection[key] ?? ""}
                        onChange={(e) => edit({ ...fields, reflection: { ...fields.reflection, [key]: e.target.value } })}
                        disabled={!!pending}
                      />
                    </label>
                  ))}
                </div>
              )}

              {/* 7. Log photos — offered from the moment this form opens, not
                  gated behind a first Save (owner acceptance review,
                  2026-10-01). A photo taken before this log exists is held
                  durably on this phone and attaches itself the moment the
                  log is confirmed saved; LogPhotoCapture owns that. */}
              <fieldset className="daily-log-field daily-log-fieldset">
                <legend>{t("dailyLog.section.photos")}</legend>
                <LogPhotoCapture projectId={projectId} logDate={logDate} ownerId={ownerId} dailyLogId={existing.data?.id ?? null} disabled={save.isPending} onBusyChange={setPhotoBusy} onStorageIssue={setPhotoStorageIssue} />
                <p className="muted daily-log-photos-caption">{t("dailyLog.photos.caption")}</p>
              </fieldset>

              {/* 8. Something has to be on site tomorrow that isn't */}
              <fieldset className="daily-log-field daily-log-fieldset">
                <legend>{t("dailyLog.section.missingTomorrow")}</legend>
                {fields.missingTomorrow.map((m, i) => (
                  <div key={i} className="daily-log-conditions">
                    <label className="daily-log-field">
                      <span>{t("dailyLog.missingTomorrow.placeholder")}</span>
                      <input value={m.description} disabled={!!pending} onChange={(e) => updateMissing(i, { description: e.target.value })} />
                    </label>
                    <div className="daily-log-chip-row">
                      {MISSING_ITEM_KINDS.map((k) => (
                        <button key={k} type="button" className="daily-log-chip" aria-pressed={m.kind === k} disabled={!!pending}
                          onClick={() => updateMissing(i, { kind: k })}>{t(MISSING_KIND_LABEL_KEYS[k])}</button>
                      ))}
                      <button type="button" className="button-like" disabled={!!pending} onClick={() => removeMissing(i)}>{t("dailyLog.delays.remove")}</button>
                    </div>
                  </div>
                ))}
                <button type="button" className="button-like" disabled={!!pending} onClick={addMissing}>{t("dailyLog.missingTomorrow.add")}</button>
              </fieldset>

              {/* 9. Tomorrow */}
              <fieldset className="daily-log-field daily-log-fieldset">
                <legend>{t("dailyLog.section.tomorrow")}</legend>
                <div className="daily-log-chip-row">
                  {WORK_STAGE_KEYS.map((stage) => (
                    <button key={stage} type="button" className="daily-log-chip" aria-pressed={fields.tomorrowStages.includes(stage)}
                      disabled={!!pending} onClick={() => toggleTomorrowStage(stage)}>
                      {t(STAGE_LABEL_KEYS[stage])}
                    </button>
                  ))}
                </div>
                <div className="daily-log-crew-expected">
                  <span>{t("dailyLog.tomorrow.crewExpected")}</span>
                  <button type="button" className="button-like" disabled={!!pending || !fields.tomorrowCrewExpected}
                    onClick={() => edit({ ...fields, tomorrowCrewExpected: Math.max(0, (fields.tomorrowCrewExpected ?? 0) - 1) })}
                    aria-label="-"><Minus size={16} aria-hidden="true" /></button>
                  <span className="daily-log-crew-expected-value">{fields.tomorrowCrewExpected ?? "—"}</span>
                  <button type="button" className="button-like" disabled={!!pending}
                    onClick={() => edit({ ...fields, tomorrowCrewExpected: (fields.tomorrowCrewExpected ?? 0) + 1 })}
                    aria-label="+"><Plus size={16} aria-hidden="true" /></button>
                </div>
                <label className="daily-log-field">
                  <span>{t("dailyLog.tomorrow.plan")}</span>
                  <LogTextArea rows={3} value={fields.tomorrowPlan ?? ""} disabled={!!pending}
                    onChange={(e) => edit({ ...fields, tomorrowPlan: e.target.value })} />
                  <span className="muted">{t("dailyLog.tomorrow.planHelper")}</span>
                </label>
              </fieldset>

              {/* Units completed/remaining */}
              <fieldset className="daily-log-field daily-log-fieldset">
                <legend>{t("dailyLog.section.units")}</legend>
                <div className="daily-log-conditions">
                  <label className="daily-log-field">
                    <span>{t("dailyLog.units.today")}</span>
                    <input type="number" min={0} inputMode="numeric" placeholder={t("dailyLog.units.notReported")}
                      value={fields.unitsToday ?? ""} disabled={!!pending}
                      onChange={(e) => edit({ ...fields, unitsToday: e.target.value === "" ? null : Math.max(0, Number(e.target.value)) })} />
                  </label>
                  <label className="daily-log-field">
                    <span>{t("dailyLog.units.toDate")}</span>
                    <input type="number" min={0} inputMode="numeric" placeholder={t("dailyLog.units.notReported")}
                      value={fields.unitsToDate ?? ""} disabled={!!pending}
                      onChange={(e) => edit({ ...fields, unitsToDate: e.target.value === "" ? null : Math.max(0, Number(e.target.value)) })} />
                  </label>
                  <label className="daily-log-field">
                    <span>{t("dailyLog.units.remaining")}</span>
                    <input type="number" min={0} inputMode="numeric" placeholder={t("dailyLog.units.notReported")}
                      value={fields.unitsRemaining ?? ""} disabled={!!pending}
                      onChange={(e) => edit({ ...fields, unitsRemaining: e.target.value === "" ? null : Math.max(0, Number(e.target.value)) })} />
                  </label>
                </div>
                <label className="daily-log-field">
                  <span>{t("dailyLog.units.remainingDetail")}</span>
                  <LogTextArea rows={2} value={fields.unitsRemainingDetail ?? ""} disabled={!!pending}
                    onChange={(e) => edit({ ...fields, unitsRemainingDetail: e.target.value })} />
                </label>
              </fieldset>
            </>
          )}
        </div>

        {!loading && (
          <footer className="daily-log-editor-footer">
            {/* Notes are optional (owner acceptance review, 2026-10-01) —
                a hint, never a block on Save. */}
            {!fields.notes.trim() && <p className="muted">{t("dailyLog.notesGate")}</p>}
            <div className="daily-log-editor-actions">
              <button
                className="button-like active-pill daily-log-submit"
                disabled={!!pending || conflict || save.isPending || photoBusy || photoStorageIssue || !ownerId}
                onClick={() => {
                  if (!ownerId) return;
                  const notes = fields.notes.trim() || synthesizeNotes(fields.workStages, STAGE_LABEL_KEYS, t);
                  save.mutate({ ownerId, mark: signInMark(), fields: { ...fields, notes }, revision: baseRevision, reviewedConflict: reviewedConflict.current });
                }}
              >
                {save.isPending ? t("dailyLog.action.saving") : t("dailyLog.action.save")}
              </button>
              <button className="button-like" onClick={()=>{if(!photoBusy && !photoStorageIssue && !save.isPending)onClose();}}>{t("dailyLog.draft.close")}</button>
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}
