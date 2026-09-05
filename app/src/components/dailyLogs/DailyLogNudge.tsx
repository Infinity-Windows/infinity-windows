// "Log today for <job>?" — the one offer a foreman gets when the day ends.
//
// Mounted once in Layout, beside the other app-shell overlays, and listens for
// the clock-out event ClockSheet fires. Everything about when it may appear
// lives in lib/dailyLogNudge.ts; this is the surface.
//
// It renders nothing until it has something to offer, and it is never in the
// way: the punch has already happened by the time this hears about it, so
// dismissing it, ignoring it, or the whole component throwing would all leave
// the clock-out exactly as done as it already was.
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { isForemanPlus } from "../../lib/install/types";
import type { CrewRole } from "../../lib/install/types";
import { jobsNeedingLogToday } from "../../lib/dailyLogs";
import { localDateISO } from "../../lib/dailyLogDay";
import {
  CLOCKED_OUT_EVENT,
  alreadyAskedToday,
  rememberAskedToday,
  type ClockedOutDetail,
} from "../../lib/dailyLogNudge";
import { useT } from "../../lib/i18n";
import { DailyLogDialog } from "./DailyLogDialog";

export function DailyLogNudge({ role }: { role: CrewRole | string | null | undefined }) {
  const t = useT();
  const queryClient = useQueryClient();
  const canLog = isForemanPlus(role);
  const [askedFor, setAskedFor] = useState<string | null>(null);
  const [openFor, setOpenFor] = useState<string | null>(null);

  // Which jobs were worked today with no log filed yet — the SAME query the
  // "Log today · N" chip reads, so the two can never disagree about whether a
  // job still needs one. Only fetched once a clock-out has actually happened.
  const needing = useQuery({
    queryKey: ["jobsNeedingLog"],
    queryFn: jobsNeedingLogToday,
    enabled: canLog && askedFor != null,
  });

  useEffect(() => {
    if (!canLog) return;
    const onClockedOut = (e: Event) => {
      const projectId = (e as CustomEvent<ClockedOutDetail>).detail?.projectId ?? null;
      // A shift with no job on it (an overarching clock-in) has no log to
      // file, and a job already offered today has had its answer.
      if (!projectId || alreadyAskedToday(projectId, localDateISO())) return;
      setAskedFor(projectId);
      // Whether the job still needs a log is a question for the server, and
      // the answer may have changed while this phone was clocked in.
      void queryClient.invalidateQueries({ queryKey: ["jobsNeedingLog"] });
    };
    window.addEventListener(CLOCKED_OUT_EVENT, onClockedOut);
    return () => window.removeEventListener(CLOCKED_OUT_EVENT, onClockedOut);
  }, [canLog, queryClient]);

  const job = askedFor ? (needing.data ?? []).find((j) => j.projectId === askedFor) : undefined;

  const close = () => {
    if (askedFor) rememberAskedToday(askedFor, localDateISO());
    setAskedFor(null);
  };

  if (openFor && job) {
    return (
      <DailyLogDialog
        projectId={job.projectId}
        logDate={localDateISO()}
        jobLabel={`${job.jobCode} — ${job.name}`}
        onClose={() => {
          setOpenFor(null);
          close();
        }}
      />
    );
  }

  // Nothing to say: not a foreman, no clock-out yet, the answer has not come
  // back, or that job's log is already filed.
  if (!canLog || !job) return null;

  return (
    <div className="log-nudge" role="status" aria-live="polite">
      <span className="log-nudge-message">
        {t("dailyLog.nudge.ask", { job: job.jobCode || job.name })}
      </span>
      <button
        type="button"
        className="log-nudge-btn"
        onClick={() => {
          rememberAskedToday(job.projectId, localDateISO());
          setOpenFor(job.projectId);
        }}
      >
        {t("dailyLog.nudge.write")}
      </button>
      <button
        type="button"
        className="log-nudge-close"
        aria-label={t("dailyLog.nudge.dismiss")}
        onClick={close}
      >
        <X size={18} />
      </button>
    </div>
  );
}
