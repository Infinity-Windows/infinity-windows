import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { listProjectsAnyStatus } from "../../lib/api";
import { addDays, listTeamShifts, timecardRange } from "../../lib/timeclock";
import { useT } from "../../lib/i18n";
import { TimeByJobReport } from "./TimeByJobReport";

/** All shift labor, separate from the Data page's unit-installation evidence. */
export function JobHoursLedger({ projectId }: { projectId: string }) {
  const t = useT();
  const [mode, setMode] = useState<"all" | "pay">("all");
  const [anchor, setAnchor] = useState(() => new Date());
  const period = useMemo(() => timecardRange("pay", anchor), [anchor]);
  const start = mode === "all" ? null : period.startIso;
  const end = mode === "all" ? null : period.endIso;
  const shifts = useQuery({ queryKey: ["teamShifts", start, end], queryFn: () => listTeamShifts(start, end), refetchInterval: 30_000 });
  const projects = useQuery({ queryKey: ["projectsAll"], queryFn: listProjectsAnyStatus });
  const rows = useMemo(() => (shifts.data ?? []).filter((s) => projectId === "all" || s.project_id === projectId), [shifts.data, projectId]);
  const jobs = useMemo(() => (projects.data ?? []).filter((p) => projectId === "all" || p.id === projectId), [projects.data, projectId]);
  return <div>
    <div className="row-gap" style={{ flexWrap: "wrap" }} role="group" aria-label={t("timereport.ledgerRange")}>
      <button aria-pressed={mode === "all"} onClick={() => setMode("all")}>{t("timereport.allTime")}</button>
      <button aria-pressed={mode === "pay"} onClick={() => setMode("pay")}>{t("tcx.range.pay")}</button>
      <Link className="button-like" to="/jobs/history">{t("timereport.history")}</Link>
    </div>
    {mode === "pay" && <div className="row-gap" style={{ alignItems: "center" }}>
      <button aria-label={t("tcx.range.prev")} onClick={() => setAnchor((d) => addDays(d, -14))}>‹</button>
      <button style={{ flex: 1 }} onClick={() => setAnchor(new Date())}>{period.label}</button>
      <button aria-label={t("tcx.range.next")} onClick={() => setAnchor((d) => addDays(d, 14))}>›</button>
    </div>}
    <p className="muted">{t("timereport.historyHelp")}</p>
    <TimeByJobReport shifts={rows} rangeLabel={mode === "all" ? t("timereport.allTime") : period.label}
      allProjects={jobs} isLoading={shifts.isPending || projects.isPending} error={shifts.error ?? projects.error}
      isFetching={shifts.isFetching || projects.isFetching} onRefresh={() => { void shifts.refetch(); void projects.refetch(); }} />
  </div>;
}
