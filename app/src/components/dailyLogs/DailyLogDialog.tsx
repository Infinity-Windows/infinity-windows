// The daily log filing dialog (wave L, L3). Both entry points — the job
// page's Logs tab (DailyLogsTab.tsx) and the "Log today" chip
// (LogTodayChip.tsx) — mount this same component with just a projectId and
// a logDate; it resolves the rest itself:
//   - a log already filed for that job-day -> seed the form from IT
//     (editing = the same upsert, never a freshly recomputed draft that
//     could silently overwrite what a foreman actually wrote), else
//   - seed from buildDraftForJobDay's factual, fully-editable starting point.
import { Fragment, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useT, type TKey } from "../../lib/i18n";
import { formatApiError } from "../../lib/errors";
import { pushToast, toastSuccess } from "../../lib/toast";
import { formatLogDateLabel } from "../../lib/dailyLogDay";
import {
  buildDraftForJobDay,
  fileDailyLog,
  getDailyLog,
  type DailyLog,
  type DailyLogReflection,
  type DayFlow,
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
  const queryClient = useQueryClient();
  const existing = useQuery({
    queryKey: ["dailyLog", projectId, logDate],
    queryFn: () => getDailyLog(projectId, logDate),
  });
  const draft = useQuery({
    queryKey: ["dailyLogDraft", projectId, logDate],
    queryFn: () => buildDraftForJobDay(projectId, logDate),
    // No point building a draft for a day that's already filed — editing an
    // existing log shows what was actually saved, not a recomputed guess.
    enabled: existing.isSuccess && existing.data == null,
  });

  const [seeded, setSeeded] = useState(false);
  const [headline, setHeadline] = useState("");
  const [notes, setNotes] = useState("");
  const [dayFlow, setDayFlow] = useState<DayFlow | null>(null);
  const [reflection, setReflection] = useState<DailyLogReflection>({});
  const [weather, setWeather] = useState("");

  useEffect(() => {
    if (seeded) return;
    if (existing.data) {
      setHeadline(existing.data.headline ?? "");
      setNotes(existing.data.notes ?? "");
      setDayFlow(existing.data.day_flow);
      setReflection(existing.data.reflection ?? {});
      setWeather(existing.data.weather ?? "");
      setSeeded(true);
    } else if (existing.isSuccess && existing.data == null && draft.data) {
      setHeadline(draft.data.headline);
      setNotes(draft.data.notesDraft);
      setSeeded(true);
    }
  }, [seeded, existing.data, existing.isSuccess, draft.data]);

  const save = useMutation({
    mutationFn: () =>
      fileDailyLog({
        projectId,
        logDate,
        headline: headline.trim() || null,
        notes: notes.trim(),
        dayFlow,
        // Smooth (or nothing picked) hides the reflection inputs; saving
        // clears whatever might still be sitting in their state, per spec.
        reflection: dayFlow === "smooth" || dayFlow === null ? null : reflectionOrNull(reflection),
        weather: weather.trim() || null,
      }),
    onSuccess: (result) => {
      // The same calm sentence the photo sheet gives when there is no signal.
      // To the foreman standing in the canyon the log IS written — it is on
      // their phone and it will go — so this says where it is, not that
      // something went wrong.
      toastSuccess(result.queued ? t("dailyLog.savedOffline") : t("dailyLog.saved"));
      queryClient.invalidateQueries({ queryKey: ["dailyLogs", projectId] });
      queryClient.invalidateQueries({ queryKey: ["dailyLog", projectId, logDate] });
      queryClient.invalidateQueries({ queryKey: ["jobsNeedingLog"] });
      if (result.log) onSaved?.(result.log);
      onClose();
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  const loading = existing.isLoading || (existing.data == null && draft.isLoading && !seeded);
  // "I could not find out whether today's log exists" — which offline is the
  // NORMAL answer, not an error: react-query pauses a query it cannot run, so
  // it never resolves and never fails, and the box below opens empty over a
  // log that may well be sitting on the server. Saying so is the difference
  // between a foreman writing an addendum knowingly and one who thinks they
  // are the first person to write today. What they type is appended to
  // whatever is already there (lib/dailyLogMerge.ts), never swapped for it.
  const cannotCheck = !existing.isSuccess && !existing.isLoading;
  const showReflection = dayFlow === "fine" || dayFlow === "stuck";
  const crewLine = existing.data == null ? draft.data?.crewLine : null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <p style={{ margin: 0, fontWeight: 700 }}>
          {existing.data ? t("dailyLog.title.edit") : t("dailyLog.title.new")} — {jobLabel}
        </p>
        <p className="muted" style={{ margin: "2px 0 10px", fontSize: 12.5 }}>
          {formatLogDateLabel(logDate)}
        </p>

        {loading ? (
          <p className="muted">{t("dailyLog.loading")}</p>
        ) : (
          <>
            {cannotCheck && <p className="muted">{t("dailyLog.cannotCheck")}</p>}
            <label className="field-label">{t("dailyLog.field.headline")}</label>
            <input
              aria-label={t("dailyLog.a11y.headline")}
              value={headline}
              onChange={(e) => setHeadline(e.target.value)}
            />
            {crewLine && (
              <p className="muted" style={{ margin: "2px 0 8px", fontSize: 12 }}>
                {crewLine}
              </p>
            )}

            <label className="field-label">{t("dailyLog.field.dayFlow")}</label>
            <div className="grade-row">
              {(["smooth", "fine", "stuck"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  className={
                    dayFlow === f
                      ? `grade-btn selected${f === "fine" ? " warn" : f === "stuck" ? " danger" : ""}`
                      : "grade-btn"
                  }
                  onClick={() => setDayFlow((cur) => (cur === f ? null : f))}
                >
                  {f === "smooth"
                    ? t("dailyLog.flow.smooth")
                    : f === "fine"
                      ? t("dailyLog.flow.fine")
                      : t("dailyLog.flow.stuck")}
                </button>
              ))}
            </div>

            {showReflection &&
              REFLECTION_FIELDS.map(({ key, labelKey }) => (
                <Fragment key={key}>
                  <label className="field-label">{t(labelKey)}</label>
                  <input
                    aria-label={t(labelKey)}
                    value={reflection[key] ?? ""}
                    onChange={(e) =>
                      setReflection((cur) => ({ ...cur, [key]: e.target.value }))
                    }
                  />
                </Fragment>
              ))}

            <label className="field-label">{t("dailyLog.field.notes")}</label>
            <textarea
              aria-label={t("dailyLog.a11y.notes")}
              rows={5}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t("dailyLog.field.notesPlaceholder")}
            />

            <label className="field-label">{t("dailyLog.field.weather")}</label>
            <input
              aria-label={t("dailyLog.a11y.weather")}
              value={weather}
              onChange={(e) => setWeather(e.target.value)}
              placeholder={t("dailyLog.field.weatherPlaceholder")}
            />

            <div className="row-gap" style={{ marginTop: 10, alignItems: "center" }}>
              <button
                className="button-like active-pill"
                disabled={!notes.trim() || save.isPending}
                onClick={() => save.mutate()}
              >
                {save.isPending ? t("dailyLog.action.saving") : t("dailyLog.action.save")}
              </button>
              <button className="button-like" onClick={onClose}>
                {t("dailyLog.action.cancel")}
              </button>
              {!notes.trim() && (
                <span className="muted" style={{ fontSize: 12.5 }}>
                  {t("dailyLog.notesGate")}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
