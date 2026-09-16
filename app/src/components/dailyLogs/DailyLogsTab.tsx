// One shared daily report per job, available to the internal crew.
import { Pencil } from "lucide-react";
import "./dailyLogs.css";
import { useT, type TKey } from "../../lib/i18n";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { QueryError, SkeletonList } from "../ui/States";
import { listDailyLogs, type DailyLog, type DailyLogReflection } from "../../lib/dailyLogs";
import { localDateISO, formatLogDateLabel } from "../../lib/dailyLogDay";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { isSupervisorPlus } from "../../lib/install/types";
import { DayFlowChip } from "./DayFlowChip";
import { ShareWithBuilderChip } from "./ShareWithBuilderChip";
import { DailyLogDialog } from "./DailyLogDialog";

const REFLECTION_LABELS: { key: keyof DailyLogReflection; label: TKey }[] = [
  { key: "went_well", label: "dailyLog.field.wentWell" },
  { key: "went_poorly", label: "dailyLog.field.wentPoorly" },
  { key: "would_have_helped", label: "dailyLog.field.wouldHaveHelped" },
  { key: "what_worked", label: "dailyLog.field.whatWorked" },
];

export function DailyLogsTab({
  projectId,
  jobLabel,
}: {
  projectId: string;
  jobLabel: string;
}) {
  const t = useT();
  const logs = useQuery({
    queryKey: ["dailyLogs", projectId],
    queryFn: () => listDailyLogs(projectId),
  });
  const [openFor, setOpenFor] = useState<string | null>(null);
  const { effectiveRole } = useEffectiveRole();
  const canShare = isSupervisorPlus(effectiveRole);

  return (
    <div className="daily-logs-tab">
      <div className="daily-log-list-header">
        <h2>{t("dailyLog.listTitle")}</h2>
        <button
          type="button"
          className="button-like active-pill"
          onClick={() => setOpenFor(localDateISO())}
        >
          {t("dailyLog.addToday")}
        </button>
      </div>

      {logs.isLoading && <SkeletonList rows={3} />}
      {logs.isError && <QueryError error={logs.error} />}
      {logs.isSuccess && logs.data.length === 0 && (
        <p className="muted">{t("dailyLog.empty")}</p>
      )}
      {logs.isSuccess && logs.data.length > 0 && (
        <ul className="daily-log-list">
          {logs.data.map((log: DailyLog) => (
            <li key={log.id} className="daily-log-report">
              <div className="daily-log-report-header">
                <time dateTime={log.log_date}>{formatLogDateLabel(log.log_date)}</time>
                {log.day_flow && <DayFlowChip flow={log.day_flow} />}
              </div>
              {log.headline && <h3 className="daily-log-headline">{log.headline}</h3>}
              <p className="daily-log-description">{log.notes}</p>
              {(log.weather || REFLECTION_LABELS.some(({ key }) => log.reflection?.[key]?.trim())) && (
                <dl className="daily-log-details">
                  {log.weather && <div><dt>{t("dailyLog.a11y.weather")}</dt><dd>{log.weather}</dd></div>}
                  {REFLECTION_LABELS.map(({ key, label }) => log.reflection?.[key]?.trim() && (
                    <div key={key}><dt>{t(label)}</dt><dd>{log.reflection[key]}</dd></div>
                  ))}
                </dl>
              )}
              <footer className="daily-log-report-footer">
                {log.filer?.display_name && <p>{t("dailyLog.filedBy", { name: log.filer.display_name })}</p>}
                <div className="daily-log-report-actions">
                  {canShare && (
                    <ShareWithBuilderChip logId={log.id} visible={log.customer_visible} onChanged={() => logs.refetch()} />
                  )}
                  <button type="button" className="button-like daily-log-edit" onClick={() => setOpenFor(log.log_date)}>
                    <Pencil size={16} aria-hidden="true" /> {t("dailyLog.title.edit")}
                  </button>
                </div>
              </footer>
            </li>
          ))}
        </ul>
      )}

      {openFor && (
        <DailyLogDialog
          projectId={projectId}
          logDate={openFor}
          jobLabel={jobLabel}
          onClose={() => setOpenFor(null)}
        />
      )}
    </div>
  );
}
