// The saved-log detail view — Horizon's own "printable ticket" shape
// (HORIZON-REFERENCE.md): title, a receipt-style code, SUBMITTED status, a
// facts grid, then stage progress, delays, a PRIVATE safety line, tomorrow's
// plan, the day's own words, photos, and the submission date. Back / Copy
// link / Print / Edit. No public sharing: "Copy link" copies the app's own
// URL, readable only by someone who can already sign in and pass the same
// RLS this whole feature reads through. No delete here — see HANDOFF for why.
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Copy, Pencil, Printer } from "lucide-react";
import { useT, type TKey } from "../../lib/i18n";
import "../../lib/i18n/workCatalog";
import { formatLogDateLabel } from "../../lib/dailyLogDay";
import { listDailyLogPhotos } from "../../lib/photos";
import { pushToast } from "../../lib/toast";
import type { DailyLog } from "../../lib/dailyLogs";
import {
  isWorkStageKey,
  previousStageValue,
  stageProgressCaption,
  type WorkStageKey,
} from "../../lib/dailyLogStages";
import "./dailyLogs.css";

const STAGE_LABEL_KEYS: Record<WorkStageKey, TKey> = {
  prep: "dailyLog.stage.prep", flashing: "dailyLog.stage.flashing", frames: "dailyLog.stage.frames",
  glass: "dailyLog.stage.glass", doors: "dailyLog.stage.doors", hardware: "dailyLog.stage.hardware",
  sealing: "dailyLog.stage.sealing", qc: "dailyLog.stage.qc", site_clean: "dailyLog.stage.siteClean",
};

/** DL-YYYYMMDD-xxxxxx — display only, never stored; a short, stable-looking
 * receipt code built from the log's own date and id. */
function receiptCode(log: DailyLog): string {
  return `DL-${log.log_date.replace(/-/g, "")}-${log.id.slice(0, 6).toUpperCase()}`;
}

export function DailyLogDetail({
  log,
  priorLogs,
  onBack,
  onEdit,
}: {
  log: DailyLog;
  /** This job's earlier logs, for the same "was N%" captions the editor
   * shows — read-only here, never recomputed from sessions/timers. */
  priorLogs: DailyLog[];
  onBack: () => void;
  onEdit: () => void;
}) {
  const t = useT();
  const photos = useQuery({
    queryKey: ["dailyLogPhotos", log.id],
    queryFn: () => listDailyLogPhotos(log.id),
  });
  const jobLabel = log.project ? `${log.project.job_code} · ${log.project.name}` : (log.job_name ?? t("dailyLogsPage.unknownJob"));

  function copyLink() {
    const url = `${location.origin}/daily-logs?log=${log.id}`;
    navigator.clipboard?.writeText(url).then(
      () => pushToast(t("dailyLogsPage.linkCopied"), "info"),
      () => pushToast(t("dailyLogsPage.linkCopyFailed"), "error"),
    );
  }

  return (
    <div className="daily-log-detail">
      <div className="daily-log-detail-actions">
        <button type="button" className="button-like" onClick={onBack}><ArrowLeft size={16} aria-hidden="true" /> {t("dailyLogsPage.back")}</button>
        <button type="button" className="button-like" onClick={copyLink}><Copy size={16} aria-hidden="true" /> {t("dailyLogsPage.copyLink")}</button>
        <button type="button" className="button-like" onClick={() => window.print()}><Printer size={16} aria-hidden="true" /> {t("dailyLogsPage.print")}</button>
        <button type="button" className="button-like active-pill" onClick={onEdit}><Pencil size={16} aria-hidden="true" /> {t("dailyLog.title.edit")}</button>
      </div>

      <article className="daily-log-receipt">
        <header>
          <p className="daily-log-receipt-kicker">{t("dailyLogsPage.title")}</p>
          <p className="daily-log-receipt-code">{receiptCode(log)} · {t("dailyLogsPage.submitted")}</p>
        </header>

        <dl className="daily-log-details">
          <div><dt>{t("dailyLogsPage.facts.project")}</dt><dd>{jobLabel}</dd></div>
          <div><dt>{t("dailyLogsPage.facts.date")}</dt><dd>{formatLogDateLabel(log.log_date)}</dd></div>
          <div><dt>{t("dailyLogsPage.facts.submittedBy")}</dt><dd>{log.filer?.display_name ?? "—"}</dd></div>
          <div><dt>{t("dailyLog.a11y.weather")}</dt><dd>{log.weather ?? t("dailyLog.units.notReported")}</dd></div>
          {log.day_flow && <div><dt>{t("dailyLog.field.dayFlow")}</dt><dd>{t(`dailyLog.flow.${log.day_flow}` as TKey)}</dd></div>}
        </dl>

        {log.workStages.filter(isWorkStageKey).length > 0 && (
          <section>
            <h3>{t("dailyLog.section.workedOn")}</h3>
            {log.workStages.filter(isWorkStageKey).map((stage) => {
              const current = log.stageProgress[stage] ?? 0;
              const previous = previousStageValue(priorLogs.map((l) => ({ stageProgress: l.stageProgress, logDate: l.log_date })), stage);
              const { was, deltaToday } = stageProgressCaption(previous, current);
              return (
                <div key={stage} className="daily-log-stage-slider">
                  <label>{t(STAGE_LABEL_KEYS[stage])}</label>
                  <div className="daily-log-progress-bar"><div style={{ width: `${current}%` }} /></div>
                  <span className="daily-log-stage-caption">
                    {current}% — {was === null ? t("dailyLog.stageProgress.firstReading")
                      : t("dailyLog.stageProgress.delta", { was, delta: deltaToday !== null && deltaToday >= 0 ? `+${deltaToday}` : String(deltaToday) })}
                  </span>
                </div>
              );
            })}
          </section>
        )}

        {log.delays.length > 0 && (
          <section>
            <h3>{t("dailyLog.section.delays")}</h3>
            <ul>
              {log.delays.map((d, i) => (
                <li key={i}>{d.description} — {d.minutes ?? "?"} min — {t(d.status === "happened" ? "dailyLog.delays.status.happened" : "dailyLog.delays.status.stillGoing")} — {t(`dailyLog.delays.attribution.${d.attribution}` as TKey)}</li>
              ))}
            </ul>
          </section>
        )}

        {/* PRIVATE — internal crew only, same as every other read on this page. Never the content, just the flag. */}
        {log.safetyStatus && (
          <section>
            <h3>{t("dailyLog.section.safety")}</h3>
            <p>{t(log.safetyStatus === "none_reported" ? "dailyLog.safety.none" : "dailyLog.safety.reported")}</p>
          </section>
        )}

        {photos.data && photos.data.length > 0 && (
          <section>
            <h3>{t("dailyLog.section.photos")}</h3>
            <ul className="daily-log-photo-grid daily-log-photo-grid-receipt">
              {photos.data.map((p, i) => (
                <li key={p.id} className={i === 0 ? "daily-log-photo-first" : undefined}>
                  {p.signedUrl && <a href={p.signedUrl} target="_blank" rel="noreferrer"><img src={p.signedUrl} alt="" loading={i === 0 ? undefined : "lazy"} /></a>}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Tomorrow before the day's own words — matches the actual Horizon
            ticket layout (owner acceptance review, 2026-10-01). */}
        {(log.tomorrowStages.length > 0 || log.tomorrowPlan || log.tomorrowCrewExpected != null) && (
          <section>
            <h3>{t("dailyLog.section.tomorrow")}</h3>
            {log.tomorrowStages.length > 0 && <p>{log.tomorrowStages.map((s) => t(STAGE_LABEL_KEYS[s])).join(", ")}</p>}
            <p>{t("dailyLog.tomorrow.crewExpected")}: {log.tomorrowCrewExpected ?? "—"}</p>
            {log.tomorrowPlan && <p className="daily-log-description">{log.tomorrowPlan}</p>}
          </section>
        )}

        <section>
          <h3>{t("dailyLog.field.notes")}</h3>
          <p className="daily-log-description">{log.notes}</p>
        </section>

        {(log.unitsToday != null || log.unitsToDate != null || log.unitsRemaining != null) && (
          <section>
            <h3>{t("dailyLog.section.units")}</h3>
            <dl className="daily-log-details">
              <div><dt>{t("dailyLog.units.today")}</dt><dd>{log.unitsToday ?? t("dailyLog.units.notReported")}</dd></div>
              <div><dt>{t("dailyLog.units.toDate")}</dt><dd>{log.unitsToDate ?? t("dailyLog.units.notReported")}</dd></div>
              <div><dt>{t("dailyLog.units.remaining")}</dt><dd>{log.unitsRemaining ?? t("dailyLog.units.notReported")}</dd></div>
            </dl>
            {log.unitsRemainingDetail && <p className="daily-log-description">{log.unitsRemainingDetail}</p>}
          </section>
        )}

        <footer className="daily-log-receipt-footer muted">
          {t("dailyLogsPage.submittedOn", { date: new Date(log.created_at).toLocaleString() })}
        </footer>
      </article>
    </div>
  );
}
