import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { listWindowTypes } from "../lib/api";
import {
  getInstallerLeaderboard,
  getJobVariance,
  getMyProfile,
} from "../lib/install/api";
import { formatHours, variance } from "../lib/estimate";
import { isForemanPlus } from "../lib/install/types";

export function Analytics() {
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const leaders = useQuery({
    queryKey: ["installerLeaderboard"],
    queryFn: getInstallerLeaderboard,
  });
  const jobs = useQuery({ queryKey: ["jobVariance"], queryFn: getJobVariance });
  const types = useQuery({
    queryKey: ["windowTypes"],
    queryFn: listWindowTypes,
  });

  if (me.data && !isForemanPlus(me.data.role)) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Analytics</h1>
          <Link to="/" className="button-like">
            Home
          </Link>
        </header>
        <p className="muted">Analytics is for leads.</p>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Analytics</h1>
          <p className="muted" style={{ margin: 0 }}>Speed, quality, and bid accuracy.</p>
        </div>
        <Link to="/" className="back-chip" aria-label="Home">‹</Link>
      </header>

      <h2>Installer leaderboard</h2>
      <p className="muted">Speed and quality from real installs.</p>
      <div className="table-wrap">
        <table className="analytics-table">
          <thead>
            <tr>
              <th>Installer</th>
              <th className="num">Installs</th>
              <th className="num">Median</th>
              <th className="num">Avg grade</th>
              <th className="num">Fail %</th>
            </tr>
          </thead>
          <tbody>
            {(leaders.data ?? []).map((r) => (
              <tr key={r.installer_id}>
                <td>{r.display_name}</td>
                <td className="num">{r.installs}</td>
                <td className="num">
                  {r.median_minutes != null ? `${Math.round(r.median_minutes)}m` : "—"}
                </td>
                <td className="num">{r.avg_grade ?? "—"}</td>
                <td className="num">{r.fail_rate != null ? `${r.fail_rate}%` : "—"}</td>
              </tr>
            ))}
            {leaders.data?.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No installs with a linked installer yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h2>Bid accuracy (estimate vs actual)</h2>
      <div className="table-wrap">
        <table className="analytics-table">
          <thead>
            <tr>
              <th>Job</th>
              <th className="num">Progress</th>
              <th className="num">Estimate</th>
              <th className="num">Actual</th>
              <th className="num">Variance</th>
            </tr>
          </thead>
          <tbody>
            {(jobs.data ?? []).map((j) => {
              const v =
                j.estimated_minutes != null
                  ? variance(j.estimated_minutes, j.actual_minutes)
                  : null;
              return (
                <tr key={j.id}>
                  <td>{j.job_code}</td>
                  <td className="num">
                    {j.installed}/{j.openings}
                  </td>
                  <td className="num">
                    {j.estimated_minutes != null ? formatHours(j.estimated_minutes) : "—"}
                  </td>
                  <td className="num">{formatHours(j.actual_minutes)}</td>
                  <td className={"num " + (v && v.pctOver > 0 ? "warn-text" : v ? "ok" : "")}>
                    {v ? `${v.pctOver > 0 ? "+" : ""}${v.pctOver}%` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h2>Type difficulty + fail trends</h2>
      <div className="table-wrap">
        <table className="analytics-table">
          <thead>
            <tr>
              <th>Type</th>
              <th className="num">Installs</th>
              <th className="num">Median</th>
              <th className="num">P90</th>
              <th className="num">Difficulty</th>
              <th className="num">Fail %</th>
            </tr>
          </thead>
          <tbody>
            {(types.data ?? [])
              .filter((t) => (t.n_installs ?? 0) > 0)
              .sort((a, b) => (b.learned_difficulty ?? 0) - (a.learned_difficulty ?? 0))
              .map((t) => (
                <tr key={t.id}>
                  <td>{t.type_code}</td>
                  <td className="num">{t.n_installs ?? 0}</td>
                  <td className="num">
                    {t.median_minutes != null ? `${Math.round(t.median_minutes)}m` : "—"}
                  </td>
                  <td className="num">
                    {t.p90_minutes != null ? `${Math.round(t.p90_minutes)}m` : "—"}
                  </td>
                  <td className="num">
                    {t.learned_difficulty != null ? t.learned_difficulty.toFixed(1) : "—"}
                  </td>
                  <td className="num">{t.fail_rate != null ? `${t.fail_rate}%` : "—"}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
