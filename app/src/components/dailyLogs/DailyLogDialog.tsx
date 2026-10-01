// The daily log filing dialog (wave L, L3). Both entry points — the job
// page's Logs tab (DailyLogsTab.tsx) and the "Log today" chip
// (LogTodayChip.tsx) — mount this same component with just a projectId and
// a logDate; it resolves the rest itself:
//   - a log already filed for that job-day -> seed the form from IT
//     (editing = the same upsert, never a freshly recomputed draft that
//     could silently overwrite what a foreman actually wrote), else
//   - seed from buildDraftForJobDay's factual, fully-editable starting point.
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { X } from "lucide-react";
import { LogTextArea } from "./LogTextArea";
import "./dailyLogs.css";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useT, type TKey } from "../../lib/i18n";
import { formatApiError } from "../../lib/errors";
import { pushToast, toastSuccess } from "../../lib/toast";
import { formatLogDateLabel } from "../../lib/dailyLogDay";
import { signInMark, signedInUserId, stillSignedInAs, subscribeSignedIn, type SignInMark } from "../../lib/signedIn";
import { clearManualDailyLogDraft, loadManualDailyLogDraft, saveManualDailyLogDraft, type ManualDailyLogDraft, type ManualDailyLogFields } from "../../lib/manualDailyLogDraft";
import { mergeQueuedDailyLog } from "../../lib/dailyLogMerge";
import { useOverlayWhile } from "../../lib/pwa/useSafeSurface";
import {
  buildDraftForJobDay,
  fileDailyLog,
  getDailyLog,
  isStaleDailyLogError,
  type DailyLog,
  type DailyLogReflection,
} from "../../lib/dailyLogs";

const REFLECTION_FIELDS: { key: keyof DailyLogReflection; labelKey: TKey }[] = [
  { key: "went_well", labelKey: "dailyLog.field.wentWell" },
  { key: "went_poorly", labelKey: "dailyLog.field.wentPoorly" },
  { key: "would_have_helped", labelKey: "dailyLog.field.wouldHaveHelped" },
  { key: "what_worked", labelKey: "dailyLog.field.whatWorked" },
];

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

  const [seeded, setSeeded] = useState(false);
  const [fields, setFields] = useState<ManualDailyLogFields>({ headline: "", notes: "", dayFlow: null, reflection: {}, weather: "" });
  const [baseRevision, setBaseRevision] = useState<number | null>(null);
  const [pending, setPending] = useState<ManualDailyLogDraft | null>(() => ownerId ? loadManualDailyLogDraft(ownerId, projectId, logDate) : null);
  const [storageFailed, setStorageFailed] = useState(false);
  const [stale, setStale] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [stateOwnerId, setStateOwnerId] = useState(ownerId);
  const latestFields = useRef(fields);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    setPending(ownerId ? loadManualDailyLogDraft(ownerId, projectId, logDate) : null);
    setSeeded(false);
    setFields({ headline: "", notes: "", dayFlow: null, reflection: {}, weather: "" });
    latestFields.current = { headline: "", notes: "", dayFlow: null, reflection: {}, weather: "" };
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

  function combineWithCurrent() {
    if (!existing.isSuccess || !ownerId || (existing.data && !Number.isSafeInteger(existing.data.revision))) return;
    const merged = mergeQueuedDailyLog({ projectId, logDate,
      headline: fields.headline || null, notes: fields.notes, dayFlow: fields.dayFlow,
      reflection: reflectionOrNull(fields.reflection), weather: fields.weather || null,
      baseRevision }, existing.data ?? null);
    const next: ManualDailyLogFields = { headline: merged.headline ?? "", notes: merged.notes,
      dayFlow: merged.dayFlow, reflection: merged.reflection ?? {}, weather: merged.weather ?? "" };
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
  }

  useEffect(() => {
    if (seeded || pending) return;
    if (existing.data) {
      const next = { headline: existing.data.headline ?? "", notes: existing.data.notes ?? "",
        dayFlow: existing.data.day_flow, reflection: existing.data.reflection ?? {}, weather: existing.data.weather ?? "" };
      latestFields.current = next;
      setFields(next);
      setBaseRevision(existing.data.revision ?? null);
      setSeeded(true);
    } else if (existing.isSuccess && existing.data == null && draft.data) {
      const next = { ...latestFields.current, headline: draft.data.headline, notes: draft.data.notesDraft };
      latestFields.current = next;
      setFields(next);
      setBaseRevision(0);
      setSeeded(true);
    }
  }, [seeded, pending, existing.data, existing.isSuccess, draft.data]);

  const save = useMutation({
    mutationFn: (request: { ownerId: string; mark: SignInMark; fields: ManualDailyLogFields; revision: number | null }) => {
      if (!stillSignedInAs(request.mark, request.ownerId)) throw new Error("Sign-in changed before the daily log could save");
      return fileDailyLog({
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
      });
    },
    onSuccess: (result, request) => {
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
    <div className="modal-backdrop daily-log-backdrop" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={onClose}>
      <div className="modal-card daily-log-editor" onClick={(e) => e.stopPropagation()}>
        <header className="daily-log-editor-header">
          <div>
            <h2 id={titleId}>{existing.data ? t("dailyLog.title.edit") : t("dailyLog.title.new")}</h2>
            <p className="daily-log-job">{jobLabel}</p>
            <p className="daily-log-date">{formatLogDateLabel(logDate)}</p>
          </div>
          <button type="button" className="daily-log-close" aria-label={t("dailyLog.action.close")} onClick={onClose}>
            <X size={20} aria-hidden="true" />
          </button>
        </header>

        <div className="daily-log-editor-body">
          <p className="daily-log-shared">{t("dailyLog.shared")}</p>
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
            </>
          )}
        </div>

        {!loading && (
          <footer className="daily-log-editor-footer">
            {!fields.notes.trim() && <p className="muted">{t("dailyLog.notesGate")}</p>}
            <div className="daily-log-editor-actions">
              <button
                className="button-like active-pill"
                disabled={!!pending || conflict || !fields.notes.trim() || save.isPending || !ownerId}
                onClick={() => ownerId && save.mutate({ ownerId, mark: signInMark(), fields, revision: baseRevision })}
              >
                {save.isPending ? t("dailyLog.action.saving") : t("dailyLog.action.save")}
              </button>
              <button className="button-like" onClick={onClose}>{t("dailyLog.draft.close")}</button>
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}
