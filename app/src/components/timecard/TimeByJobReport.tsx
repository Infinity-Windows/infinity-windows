// Time by job & cost code (standard-tracking-jobs slice 3, foreman+).
//
// The pay-period rollup cut the OTHER way: instead of hours per person, hours
// per job split by the cost code charged. This is the billing basis for service
// work — an owner reads "6h Service call + 2h Warranty on Cedar Ridge" straight
// off it. The math is the pure summarizeByJobCostCode; this component just fetches
// the pay period's shifts and lays the answer out.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  listTeamShifts,
  summarizeByJobCostCode,
  timecardRange,
} from "../../lib/timeclock";
import { useT } from "../../lib/i18n";
import { SkeletonList } from "../ui/States";

function fmtHours(h: number): string {
  return `${h.toFixed(1)}h`;
}

export function TimeByJobReport() {
  const t = useT();
  const range = useMemo(() => timecardRange("pay", new Date()), []);
  const shifts = useQuery({
    queryKey: ["payPeriodShifts", range.startIso],
    queryFn: () => listTeamShifts(range.startIso, range.endIso),
  });
  const report = useMemo(
    () => summarizeByJobCostCode(shifts.data ?? []),
    [shifts.data],
  );

  return (
    <section className="detail-card" style={{ marginTop: 12 }}>
      <h2 style={{ margin: 0, fontSize: 15 }}>{t("timereport.title")}</h2>
      <p className="muted" style={{ margin: "2px 0 4px", fontSize: 12 }}>
        {t("timereport.help")}
      </p>
      <p className="wh-row-sub" style={{ margin: "0 0 8px" }}>{range.label}</p>

      {shifts.isLoading && <SkeletonList rows={3} />}
      {shifts.isSuccess && report.jobs.length === 0 && (
        <p className="muted">{t("timereport.empty")}</p>
      )}

      {report.jobs.map((job) => (
        <div key={job.jobKey} style={{ marginBottom: 10 }}>
          <div className="row-between">
            <strong style={{ minWidth: 0 }}>
              {job.jobKey === "unassigned"
                ? t("timereport.noJob")
                : `${job.jobCode}${job.jobName ? ` · ${job.jobName}` : ""}`}
            </strong>
            <span>{fmtHours(job.hours)}</span>
          </div>
          <ul className="unit-list work-list">
            {job.costCodes.map((c) => (
              <li key={c.costCodeKey} className="find-row">
                <span style={{ minWidth: 0 }}>
                  {c.costCodeKey === "none"
                    ? t("timereport.noCode")
                    : `${c.code}${c.label ? ` — ${c.label}` : ""}`}
                </span>
                <span className="wh-actions">{fmtHours(c.hours)}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {report.jobs.length > 0 && (
        <div
          className="row-between"
          style={{ borderTop: "1px solid var(--border)", paddingTop: 6 }}
        >
          <strong>{t("timereport.total")}</strong>
          <strong>{fmtHours(report.totalHours)}</strong>
        </div>
      )}
    </section>
  );
}
