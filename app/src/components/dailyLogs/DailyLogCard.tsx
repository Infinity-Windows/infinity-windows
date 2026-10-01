// One card on the cross-job Daily Logs page — Horizon's own compact report
// shape (owner acceptance review, 2026-10-01): a card must carry the day's
// progress on its face, not hide it behind "open to see counts". Every
// number here is read straight off THIS log's own row — never summed across
// days, never a partial row silently treated as complete, always labeled by
// this log's own date so a historical card is never mistaken for current.
import { useQuery } from "@tanstack/react-query";
import { CloudDrizzle, CloudOff, CloudRain, Pencil, Sun } from "lucide-react";
import { useT, type TKey } from "../../lib/i18n";
import "../../lib/i18n/workCatalog";
import { formatLogDateLabel } from "../../lib/dailyLogDay";
import { listDailyLogPhotos } from "../../lib/photos";
import type { DailyLog } from "../../lib/dailyLogs";
import {
  isWorkStageKey,
  previousStageValue,
  stageProgressCaption,
  type WorkStageKey,
} from "../../lib/dailyLogStages";
import { DayFlowChip } from "./DayFlowChip";

const STAGE_LABEL_KEYS: Record<WorkStageKey, TKey> = {
  prep: "dailyLog.stage.prep", flashing: "dailyLog.stage.flashing", frames: "dailyLog.stage.frames",
  glass: "dailyLog.stage.glass", doors: "dailyLog.stage.doors", hardware: "dailyLog.stage.hardware",
  sealing: "dailyLog.stage.sealing", qc: "dailyLog.stage.qc", site_clean: "dailyLog.stage.siteClean",
};

/** Reads ONLY the explicitly recorded weatherImpact field — never guesses an
 * icon from the freeform `weather` text, and never shows a cheerful Sun when
 * nothing was actually recorded (independent review, 2026-10-01: a null
 * impact used to default straight to Sun, which reads as a reported "clear"
 * that nobody ever reported). "none" IS a recorded, deliberate answer
 * ("weather did not affect work today") distinct from null ("not asked" /
 * "not answered"), so only "none" earns the Sun. */
function WeatherIcon({ impact, weather }: { impact: DailyLog["weatherImpact"]; weather: string | null }) {
  const icon = impact === "stopped" ? <CloudRain size={16} aria-hidden="true" />
    : impact === "slowed" ? <CloudDrizzle size={16} aria-hidden="true" />
    : impact === "none" ? <Sun size={16} aria-hidden="true" />
    : <CloudOff size={16} aria-hidden="true" />;
  return <span title={weather ?? undefined}>{icon}</span>;
}

export function DailyLogCard({
  log,
  jobLabel,
  earlierSameJobLogs,
  isLatest,
  onOpen,
  onEdit,
}: {
  log: DailyLog;
  jobLabel: string;
  /** Every OTHER loaded log for this same job, older than this one — the
   * window this page already fetched, never an extra network round trip per
   * card. previousStageValue skips days nobody reported a stage, so a stage
   * worked Monday and again Thursday still reads Monday's cumulative value,
   * not an invented 0. */
  earlierSameJobLogs: { stageProgress: DailyLog["stageProgress"]; logDate: string }[];
  /** True only for the single most-recent-dated log, PER JOB, among what is
   * currently loaded (independent review, 2026-10-01: every card used to
   * claim "Latest", which is false for all but one of them per job). A date
   * filter that excludes a newer report makes this an honest "latest WITHIN
   * this window", not a claim about today. */
  isLatest: boolean;
  onOpen: () => void;
  /** Null when this log's job has been purged — editing a log with no real
   * project_id would file against nothing; the owner acceptance review asks
   * for an explained disable here, not a silent null write. */
  onEdit: (() => void) | null;
}) {
  const t = useT();
  const photos = useQuery({
    queryKey: ["dailyLogPhotos", log.id],
    queryFn: () => listDailyLogPhotos(log.id),
  });
  const stages = log.workStages.filter(isWorkStageKey);
  const photoCount = photos.data?.length ?? null;
  const stopped = log.delays.length > 0;
  const needed = log.missingTomorrow.length > 0;
  const noPhotos = photos.isSuccess && photoCount === 0;

  return (
    <li className="daily-log-card">
      <header className="daily-log-card-header">
        <button type="button" className="daily-log-card-job" onClick={onOpen}>{jobLabel}</button>
        <div className="daily-log-card-header-right">
          {log.day_flow && <DayFlowChip flow={log.day_flow} />}
          <button type="button" className="daily-log-card-edit" aria-label={onEdit ? t("dailyLog.title.edit") : t("dailyLogsPage.unknownJob")}
            disabled={!onEdit} title={onEdit ? undefined : t("dailyLogsPage.unknownJob")} onClick={() => onEdit?.()}>
            <Pencil size={14} aria-hidden="true" />
          </button>
        </div>
      </header>

      <p className="daily-log-card-meta muted">
        {t("dailyLog.filedBy", { name: log.filer?.display_name ?? "—" })}
        {" · "}
        {photoCount === null ? "…" : t("dailyLogsPage.card.photos", { count: photoCount })}
      </p>

      <div className="daily-log-card-body">
        <div className="daily-log-card-main">
          {log.notes && <p className="daily-log-description daily-log-card-notes">{log.notes}</p>}
          {photoCount !== null && photoCount > 0 && (
            <ul className="daily-log-card-thumbs">
              {photos.data!.slice(0, 3).map((p) => (
                <li key={p.id}>{p.signedUrl && <img src={p.signedUrl} alt="" loading="lazy" />}</li>
              ))}
            </ul>
          )}
          <div className="daily-log-card-badges">
            {stopped && <span className="daily-log-badge daily-log-badge-stopped">{t("dailyLogsPage.card.stopped")}</span>}
            {needed && <span className="daily-log-badge daily-log-badge-needed">{t("dailyLogsPage.card.needed")}</span>}
            {noPhotos && <span className="daily-log-badge daily-log-badge-nophotos">{t("dailyLogsPage.card.noPhotos")}</span>}
          </div>
        </div>

        {stages.length > 0 && (
          <div className="daily-log-card-stages">
            {stages.map((stage) => {
              // A stage can be picked in "what did the crew work on" without
              // a numeric reading ever being dragged for it — that is NOT a
              // reported 0 (independent review, 2026-10-01: ?? 0 invented one).
              const raw = log.stageProgress[stage];
              const hasValue = typeof raw === "number";
              const previous = previousStageValue(earlierSameJobLogs, stage);
              const { was, deltaToday } = hasValue ? stageProgressCaption(previous, raw) : { was: null, deltaToday: null };
              return (
                <div key={stage} className="daily-log-card-mini-bar">
                  <span className="daily-log-card-mini-bar-label">{t(STAGE_LABEL_KEYS[stage])}</span>
                  {hasValue ? (
                    <>
                      <div className="daily-log-progress-bar daily-log-progress-bar-mini"><div style={{ width: `${raw}%` }} /></div>
                      <span className="daily-log-card-mini-bar-caption">
                        {raw}%{" "}
                        {was === null
                          ? `(${t("dailyLogsPage.card.firstReading")})`
                          : (deltaToday !== null && deltaToday >= 0 ? `+${deltaToday}` : String(deltaToday))}
                      </span>
                    </>
                  ) : (
                    <span className="daily-log-card-mini-bar-caption">{t("dailyLog.units.notReported")}</span>
                  )}
                </div>
              );
            })}
            <span className="daily-log-card-weather"><WeatherIcon impact={log.weatherImpact} weather={log.weather} /></span>
          </div>
        )}
      </div>

      <dl className="daily-log-card-units">
        <div>
          <dt>{t("dailyLog.units.today")}</dt>
          <dd>{log.unitsToday ?? t("dailyLog.units.notReported")}</dd>
        </div>
        <div>
          <dt>{t("dailyLog.units.toDate")}</dt>
          <dd>{log.unitsToDate ?? t("dailyLog.units.notReported")}</dd>
        </div>
        <div>
          <dt>{t("dailyLog.units.remaining")}</dt>
          <dd>{log.unitsRemaining ?? t("dailyLog.units.notReported")}</dd>
        </div>
      </dl>
      {log.unitsRemainingDetail && <p className="daily-log-card-units-detail">{log.unitsRemainingDetail}</p>}
      <p className="daily-log-card-asof muted">
        {isLatest
          ? t("dailyLogsPage.card.latestAsOf", { date: formatLogDateLabel(log.log_date) })
          : t("dailyLogsPage.card.reportedAsOf", { date: formatLogDateLabel(log.log_date) })}
      </p>
    </li>
  );
}
