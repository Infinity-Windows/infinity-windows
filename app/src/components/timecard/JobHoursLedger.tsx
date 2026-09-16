import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { listProjectsAnyStatus } from "../../lib/api";
import { addDays, listTeamShifts, timecardRange } from "../../lib/timeclock";
import { useT } from "../../lib/i18n";
import { customTimeRange, dateFieldValue, includesJob, type JobSelection } from "../../lib/timeReportFilters";
import { TimeByJobReport } from "./TimeByJobReport";

/** All shift labor, separate from the Data page's unit-installation evidence. */
export function JobHoursLedger({ selectedJobs }: { selectedJobs: JobSelection }) {
  const t = useT();
  const [mode, setMode] = useState<"all" | "pay" | "custom">("all");
  const [anchor, setAnchor] = useState(() => new Date());
  const period = useMemo(() => timecardRange("pay", anchor), [anchor]);
  const [from, setFrom] = useState(() => dateFieldValue(period.start));
  const [through, setThrough] = useState(() => dateFieldValue(addDays(period.end, -1)));
  const custom = useMemo(() => customTimeRange(from, through), [from, through]);
  const rangeError = mode === "custom" ? custom.error : null;
  const start = mode === "pay" ? period.startIso : mode === "custom" && !custom.error ? custom.startIso : null;
  const end = mode === "pay" ? period.endIso : mode === "custom" && !custom.error ? custom.endIso : null;
  const noJobs = selectedJobs?.length === 0;
  const shifts = useQuery({ queryKey: ["teamShifts", start, end], queryFn: () => listTeamShifts(start, end), enabled: !rangeError && !noJobs, refetchInterval: 30_000 });
  const projects = useQuery({ queryKey: ["projectsAll"], queryFn: listProjectsAnyStatus });
  const rows = useMemo(() => (shifts.data ?? []).filter((s) => includesJob(selectedJobs, s.project_id)), [shifts.data, selectedJobs]);
  const jobs = useMemo(() => (projects.data ?? []).filter((p) => includesJob(selectedJobs, p.id)), [projects.data, selectedJobs]);
  const rangeLabel = mode === "all" ? t("timereport.allTime") : mode === "pay" ? period.label : `${from} – ${through}`;
  return <div>
    <div className="job-hours-toolbar" role="group" aria-label={t("timereport.ledgerRange")}>
      <button aria-pressed={mode === "all"} onClick={() => setMode("all")}>{t("timereport.allTime")}</button>
      <button aria-pressed={mode === "pay"} onClick={() => setMode("pay")}>{t("tcx.range.pay")}</button>
      <button aria-pressed={mode === "custom"} onClick={() => setMode("custom")}>{t("timereport.customRange")}</button>
      <Link className="button-like" to="/jobs/history">{t("timereport.history")}</Link>
    </div>
    {mode === "pay" && <div className="row-gap" style={{ alignItems: "center" }}>
      <button aria-label={t("tcx.range.prev")} onClick={() => setAnchor((d) => addDays(d, -14))}>‹</button>
      <button style={{ flex: 1 }} onClick={() => setAnchor(new Date())}>{period.label}</button>
      <button aria-label={t("tcx.range.next")} onClick={() => setAnchor((d) => addDays(d, 14))}>›</button>
    </div>}
    {mode === "custom" && <div className="job-hours-custom-range">
      <div className="job-hours-dates">
        <label>{t("timereport.fromDate")}<input type="date" value={from} aria-invalid={Boolean(rangeError)} aria-describedby="job-hours-date-help" onChange={e => setFrom(e.target.value)} /></label>
        <label>{t("timereport.throughDate")}<input type="date" value={through} aria-invalid={Boolean(rangeError)} aria-describedby="job-hours-date-help" onChange={e => setThrough(e.target.value)} /></label>
      </div>
      <p className="muted" id="job-hours-date-help">{t("timereport.customRangeHelp")}</p>
      {rangeError && <p role="alert">{t(`timereport.rangeError.${rangeError}`)}</p>}
    </div>}
    <p className="muted">{t("timereport.historyHelp")}</p>
    {noJobs && <p role="status" className="detail-card">{t("timereport.noJobsSelected")}</p>}
    {!rangeError && !noJobs && <TimeByJobReport shifts={rows} rangeLabel={rangeLabel}
      allProjects={jobs} isLoading={shifts.isPending || projects.isPending} error={shifts.error ?? projects.error}
      isFetching={shifts.isFetching || projects.isFetching} onRefresh={() => { void shifts.refetch(); void projects.refetch(); }} />}
  </div>;
}
