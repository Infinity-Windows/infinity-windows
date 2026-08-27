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

const REFLECTION_FIELDS: { key: keyof DailyLogReflection; label: string }[] = [
  { key: "went_well", label: "What went well" },
  { key: "went_poorly", label: "What went poorly" },
  { key: "would_have_helped", label: "What would have helped" },
  { key: "what_worked", label: "What's worth doing again" },
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
    onSuccess: (log) => {
      toastSuccess("Day logged.");
      queryClient.invalidateQueries({ queryKey: ["dailyLogs", projectId] });
      queryClient.invalidateQueries({ queryKey: ["dailyLog", projectId, logDate] });
      queryClient.invalidateQueries({ queryKey: ["jobsNeedingLog"] });
      onSaved?.(log);
      onClose();
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  const loading = existing.isLoading || (existing.data == null && draft.isLoading && !seeded);
  const showReflection = dayFlow === "fine" || dayFlow === "stuck";
  const crewLine = existing.data == null ? draft.data?.crewLine : null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <p style={{ margin: 0, fontWeight: 700 }}>
          {existing.data ? "Edit the log" : "Log today"} — {jobLabel}
        </p>
        <p className="muted" style={{ margin: "2px 0 10px", fontSize: 12.5 }}>
          {formatLogDateLabel(logDate)}
        </p>

        {loading ? (
          <p className="muted">Putting together what happened today…</p>
        ) : (
          <>
            <label className="field-label">Headline</label>
            <input
              aria-label="Headline"
              value={headline}
              onChange={(e) => setHeadline(e.target.value)}
            />
            {crewLine && (
              <p className="muted" style={{ margin: "2px 0 8px", fontSize: 12 }}>
                {crewLine}
              </p>
            )}

            <label className="field-label">Day flow</label>
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
                  {f === "smooth" ? "Smooth" : f === "fine" ? "Fine" : "Stuck"}
                </button>
              ))}
            </div>

            {showReflection &&
              REFLECTION_FIELDS.map(({ key, label }) => (
                <Fragment key={key}>
                  <label className="field-label">{label}</label>
                  <input
                    aria-label={label}
                    value={reflection[key] ?? ""}
                    onChange={(e) =>
                      setReflection((cur) => ({ ...cur, [key]: e.target.value }))
                    }
                  />
                </Fragment>
              ))}

            <label className="field-label">Notes — what did the crew get done today?</label>
            <textarea
              aria-label="Notes"
              rows={5}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What got done, what didn't, anything worth a word"
            />

            <label className="field-label">Weather (optional)</label>
            <input
              aria-label="Weather"
              value={weather}
              onChange={(e) => setWeather(e.target.value)}
              placeholder="Clear, 88°, breezy"
            />

            <div className="row-gap" style={{ marginTop: 10, alignItems: "center" }}>
              <button
                className="button-like active-pill"
                disabled={!notes.trim() || save.isPending}
                onClick={() => save.mutate()}
              >
                {save.isPending ? "Saving…" : "Save"}
              </button>
              <button className="button-like" onClick={onClose}>
                Cancel
              </button>
              {!notes.trim() && (
                <span className="muted" style={{ fontSize: 12.5 }}>
                  Add a few words about what got done before saving.
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
