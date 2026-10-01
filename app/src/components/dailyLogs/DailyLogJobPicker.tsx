// "Log today" from the cross-job Daily Logs page has no job in context yet
// — Horizon's own flow is job picker, THEN the narrow form (HORIZON-
// REFERENCE.md). A small, self-contained sheet rather than reusing the
// clock's JobPickSheet, which also asks cost code / mode / note that a
// daily log has no use for.
import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { useT } from "../../lib/i18n";
import "../../lib/i18n/workCatalog";
import type { Project } from "../../lib/types";

export function DailyLogJobPicker({
  projects,
  onPick,
  onClose,
}: {
  projects: readonly Project[];
  onPick: (project: Project) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => `${p.job_code} ${p.name}`.toLowerCase().includes(q));
  }, [projects, search]);

  return (
    <div className="modal-backdrop daily-log-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal-card daily-log-job-picker" onClick={(e) => e.stopPropagation()}>
        <header className="daily-log-editor-header">
          <h2>{t("dailyLog.whichJob")}</h2>
          <button type="button" className="daily-log-close" aria-label={t("dailyLog.action.close")} onClick={onClose}>
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <div className="daily-log-editor-body">
          <label className="daily-log-field">
            <span className="sr-only">{t("dailyLogsPage.searchJob")}</span>
            <div className="daily-log-search">
              <Search size={16} aria-hidden="true" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("dailyLogsPage.searchJob")} autoFocus />
            </div>
          </label>
          <ul className="daily-log-job-list">
            {filtered.map((p) => (
              <li key={p.id}>
                <button type="button" className="daily-log-job-list-item" onClick={() => onPick(p)}>
                  <span className="daily-log-job-code">{p.job_code}</span>
                  <span>{p.name}</span>
                </button>
              </li>
            ))}
            {filtered.length === 0 && <p className="muted">{t("dailyLogsPage.noJobsMatch")}</p>}
          </ul>
        </div>
      </div>
    </div>
  );
}
