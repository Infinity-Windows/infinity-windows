import { useMemo, useState } from "react";
import type { Project } from "../../lib/types";
import { includesJob, NO_JOB, type JobSelection } from "../../lib/timeReportFilters";
import { useT } from "../../lib/i18n";

export function JobMultiSelect({ projects, selection, onChange, loading }: {
  projects: Project[];
  selection: JobSelection;
  onChange: (next: JobSelection) => void;
  loading: boolean;
}) {
  const t = useT();
  const [search, setSearch] = useState("");
  const options = useMemo(() => [
    ...[...projects].sort((a, b) => a.job_code.localeCompare(b.job_code)).map(p => ({
      id: p.id, label: `${p.job_code} · ${p.name}`,
      status: p.status === "completed" ? t("timereport.completed") : p.status === "cancelled" ? t("timereport.cancelled") : "",
    })),
    { id: NO_JOB, label: t("timereport.noJob"), status: "" },
  ], [projects, t]);
  const visible = options.filter(p => `${p.label} ${p.status}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  function toggle(id: string) {
    const current = selection ?? options.map(p => p.id);
    onChange(current.includes(id) ? current.filter(key => key !== id) : [...current, id]);
  }
  return <details className="job-filter-picker">
    <summary>
      <span>{t("timereport.chooseJobs")}</span>
      <strong>{selection === null ? t("timereport.allJobs") : t("timereport.selectedJobs", { n: selection.length })}</strong>
    </summary>
    <div className="job-filter-body">
      <label className="job-filter-search">{t("timereport.searchJobs")}
        <input type="search" value={search} onChange={e => setSearch(e.target.value)} />
      </label>
      <div className="row-gap">
        <button type="button" onClick={() => onChange(null)}>{t("timereport.allJobs")}</button>
        <button type="button" onClick={() => onChange([])}>{t("timereport.clearJobs")}</button>
      </div>
      <div className="job-filter-options" role="group" aria-label={t("timereport.chooseJobs")} aria-busy={loading}>
        {visible.map(p => <label key={p.id} className="job-filter-option">
          <input type="checkbox" checked={includesJob(selection, p.id)} disabled={loading} onChange={() => toggle(p.id)} />
          <span>{p.label}{p.status && <small className="muted">{p.status}</small>}</span>
        </label>)}
        {!visible.length && <p className="muted">{t("timereport.noMatchingJobs")}</p>}
      </div>
      <p className="muted">{t("timereport.jobSelectionHelp")}</p>
    </div>
  </details>;
}
