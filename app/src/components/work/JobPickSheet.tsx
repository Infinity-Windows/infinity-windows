// "Where are you working?" — the one-tap-to-change behind Start day's
// preselected job (crew redesign K1.3, 2026-09-23). Today's scheduled job
// and the recent ones are chips; the whole list is a search away; the cost
// code, the both-mode question and the office note sit underneath, the same
// answers the classic clock-in asks for — just not asked again every morning.

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Sheet } from "../ui/Sheet";
import { VoiceTextarea } from "../voice/VoiceTextarea";
import { JobModeBadge } from "../JobModeBadge";
import { useT } from "../../lib/i18n";
import "../../lib/i18n/workCatalog";
import { normalizeModes, type JobMode } from "../../lib/jobModes";
import type { CostCode, RecentJob } from "../../lib/timeclock";
import type { Project } from "../../lib/types";

export interface JobPick {
  projectId: string;
  costCodeId: string;
  mode: JobMode;
  note: string;
}

export function JobPickSheet({
  open,
  onClose,
  todayJobId,
  projects,
  recents,
  costCodes,
  value,
  onChange,
}: {
  open: boolean;
  onClose: () => void;
  todayJobId: string | null;
  projects: readonly Project[];
  recents: readonly RecentJob[];
  costCodes: readonly CostCode[];
  value: JobPick;
  onChange: (next: JobPick) => void;
}) {
  const t = useT();
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => `${p.job_code} ${p.name} ${p.address ?? ""}`.toLowerCase().includes(q));
  }, [projects, search]);
  const scheduled = todayJobId ? projects.find((p) => p.id === todayJobId) : null;
  const chosen = projects.find((p) => p.id === value.projectId);
  const isBothMode = normalizeModes(chosen?.allowed_modes).length >= 2;

  const pickJob = (projectId: string) => {
    // A recent's last cost code follows the job; otherwise keep the current
    // pick and let the cost-code list below correct it.
    const recent = recents.find((r) => r.projectId === projectId);
    onChange({ ...value, projectId, costCodeId: recent?.costCodeId ?? value.costCodeId });
  };

  return (
    <Sheet open={open} onClose={onClose} label={t("work.jobPick.title")} className="ws-sheet">
      <h2 className="ws-sheet-title">{t("work.jobPick.title")}</h2>

      {scheduled && (
        <>
          <p className="ws-label">{t("work.jobPick.scheduled")}</p>
          <div className="ws-chip-row">
            <button
              type="button"
              className={`ws-chip${value.projectId === scheduled.id ? " ws-chip--on" : ""}`}
              aria-pressed={value.projectId === scheduled.id}
              onClick={() => pickJob(scheduled.id)}
            >
              {scheduled.job_code} · {scheduled.name}
            </button>
          </div>
        </>
      )}

      {recents.length > 0 && (
        <>
          <p className="ws-label">{t("work.jobPick.recent")}</p>
          <div className="ws-chip-row">
            {recents.map((r) => (
              <button
                key={r.projectId}
                type="button"
                className={`ws-chip${value.projectId === r.projectId ? " ws-chip--on" : ""}`}
                aria-pressed={value.projectId === r.projectId}
                onClick={() => pickJob(r.projectId)}
              >
                {r.jobCode || r.name}
              </button>
            ))}
          </div>
        </>
      )}

      <p className="ws-label">{t("work.jobPick.allJobs")}</p>
      <label className="ws-search">
        <Search size={18} aria-hidden />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("work.jobPick.search")}
          aria-label={t("work.jobPick.search")}
        />
      </label>
      <div className="ws-list">
        {filtered.slice(0, 40).map((p) => (
          <button
            key={p.id}
            type="button"
            className={`ws-list-item${value.projectId === p.id ? " ws-list-item--on" : ""}`}
            aria-pressed={value.projectId === p.id}
            onClick={() => pickJob(p.id)}
          >
            <span className="ws-list-code">{p.job_code}</span>
            <span className="ws-list-name">{p.name}</span>
            <JobModeBadge allowed={p.allowed_modes} />
          </button>
        ))}
        {filtered.length === 0 && <p className="ws-meta">{t("work.jobPick.noMatch", { q: search })}</p>}
      </div>

      <p className="ws-label">{t("work.clock.costCode")}</p>
      <div className="ws-chip-row ws-chip-row--wrap">
        {costCodes.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`ws-chip${value.costCodeId === c.id ? " ws-chip--on" : ""}`}
            aria-pressed={value.costCodeId === c.id}
            onClick={() => onChange({ ...value, costCodeId: c.id })}
          >
            {c.code} — {c.label}
          </button>
        ))}
      </div>

      {isBothMode && (
        <>
          <p className="ws-label">{t("work.jobPick.mode")}</p>
          <div className="ws-chip-row">
            {(["data", "tracking"] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={`ws-chip${value.mode === m ? " ws-chip--on" : ""}`}
                aria-pressed={value.mode === m}
                onClick={() => onChange({ ...value, mode: m })}
              >
                {m === "data" ? t("clockblock.mode.data") : t("clockblock.mode.tracking")}
              </button>
            ))}
          </div>
        </>
      )}

      <label className="ws-label" htmlFor="ws-jobpick-note">{t("work.jobPick.note")}</label>
      <VoiceTextarea
        id="ws-jobpick-note"
        className="ws-textarea"
        rows={2}
        maxLength={1000}
        value={value.note}
        onChange={(e) => onChange({ ...value, note: e.target.value })}
      />

      <button type="button" className="ws-btn ws-btn--primary" onClick={onClose}>
        {t("work.jobPick.done")}
      </button>
    </Sheet>
  );
}
