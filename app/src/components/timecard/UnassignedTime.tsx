import { useMemo, useState } from "react";
import { ClipboardList, ChevronDown } from "lucide-react";
import { useLanguage, type TKey } from "../../lib/i18n";
import { formatApiError } from "../../lib/errors";
import type { Profile } from "../../lib/install/types";
import { canEditTimecard } from "../../lib/timecardPermissions";
import { unassignedTimeEntries } from "../../lib/unassignedTime";
import { shiftGuard } from "../../lib/shiftGuard";
import { punchDay, type TimeShift } from "../../lib/timeclock";
import { durationText } from "../../lib/timeEntryExport";
import { ShiftEditor, type ProjectOpt, type CostOpt } from "./ShiftEditor";
import { SkeletonList } from "../ui/States";

const STATUS_KEYS: Record<TimeShift["status"], TKey> = {
  open: "timecard.status.open", submitted: "timecard.status.submitted",
  approved: "timecard.status.approved", rejected: "timecard.status.rejected",
  needs_finish: "unassigned.needsFinish", voided: "unassigned.removed",
};

export function UnassignedTime({ shifts, people, projects, costCodes, role, actorId, rangeLabel, isLoading, error, onRefresh, isFetching }: {
  shifts: TimeShift[]; people: Profile[]; projects: ProjectOpt[]; costCodes: CostOpt[];
  role: string | null | undefined; actorId?: string; rangeLabel: string;
  isLoading: boolean; error: unknown; onRefresh: () => void; isFetching: boolean;
}) {
  const { t, lang } = useLanguage();
  const entries = useMemo(() => unassignedTimeEntries(shifts), [shifts]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(20);
  const day = (iso: string) => new Date(iso).toLocaleDateString(lang, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  const clock = (iso: string) => new Date(iso).toLocaleTimeString(lang, { hour: "numeric", minute: "2-digit" });
  const stamp = (iso: string) => `${day(iso)} · ${clock(iso)}`;

  return <section className="detail-card unassigned-time" aria-label={t("unassigned.title")}>
    <header className="unassigned-heading">
      <div className="unassigned-heading-copy">
        <span className="unassigned-icon" aria-hidden><ClipboardList size={22} /></span>
        <div><h2>{t("unassigned.title")}</h2><p>{rangeLabel} · {t("unassigned.oldest")}</p></div>
      </div>
      <button type="button" className="button-like" onClick={onRefresh} disabled={isFetching}>{t("timereport.refresh")}</button>
    </header>
    <p className="muted unassigned-help">{t("unassigned.help")}</p>
    {isLoading ? <SkeletonList rows={2} /> : error ? <p role="alert">{formatApiError(error)}</p> : <>
      {entries.length === 0 ? <p className="unassigned-empty">{t("unassigned.empty")}</p> : <>
        <p className="unassigned-count">{t("unassigned.count", { entries: entries.length, people: new Set(entries.map(s => s.profile_id)).size })}</p>
        <ol className="unassigned-list">
          {entries.slice(0, visibleCount).map(s => {
            const person = people.find(p => p.id === s.profile_id);
            const name = person?.display_name ?? s.profiles?.display_name ?? t("unassigned.person");
            const editable = canEditTimecard(role, actorId, person?.role, s.profile_id);
            const seconds = shiftGuard(s).workedSeconds;
            const invalid = !Number.isFinite(Date.parse(s.clock_in_at)) || (s.clock_out_at && Date.parse(s.clock_out_at) < Date.parse(s.clock_in_at));
            const hours = invalid || seconds === null || !Number.isFinite(seconds) ? t("unassigned.needsReview") : durationText(seconds);
            const reportedJob = s.source_import?.original?.Project;
            return <li key={s.id} className="unassigned-entry" data-entry-id={s.id}>
              <div className="unassigned-entry-top">
                <div className="unassigned-person"><strong>{name}</strong><span className={`tcx-chip ${s.status === "approved" ? "good" : s.status === "rejected" ? "bad" : ""}`}>{t(STATUS_KEYS[s.status])}</span></div>
                <strong className="unassigned-hours">{hours}<small>{s.clock_out_at ? t("unassigned.netHours") : t("unassigned.running")}</small></strong>
              </div>
              <dl className="unassigned-facts">
                <div><dt>{t("unassigned.workDay")}</dt><dd>{day(s.clock_in_at)}</dd></div>
                <div><dt>{t("unassigned.timeEntry")}</dt><dd>{clock(s.clock_in_at)} – {s.clock_out_at ? (punchDay(s.clock_in_at) === punchDay(s.clock_out_at) ? clock(s.clock_out_at) : stamp(s.clock_out_at)) : t("unassigned.noFinish")}</dd></div>
                <div><dt>{t("unassigned.break")}</dt><dd>{durationText(s.break_seconds)}</dd></div>
                <div><dt>{t("unassigned.costCode")}</dt><dd>{s.cost_codes ? `${s.cost_codes.code} · ${s.cost_codes.label}` : t("timereport.noCode")}</dd></div>
              </dl>
              {reportedJob && <p className="unassigned-source">{t("unassigned.reportedJob", { job: reportedJob })}</p>}
              <p className={`unassigned-description${s.note ? "" : " muted"}`}>{s.note || t("unassigned.noDescription")}</p>
              <footer className="unassigned-entry-footer">
                <span className="muted">{t("unassigned.added", { date: stamp(s.created_at || s.clock_in_at) })}</span>
                {editable && <button type="button" className="button-like" aria-expanded={editingId === s.id}
                  onClick={() => setEditingId(editingId === s.id ? null : s.id)}>{editingId === s.id ? t("unassigned.close") : t("unassigned.assign")}</button>}
              </footer>
              {editingId === s.id && editable && <ShiftEditor mode="edit" shift={s} profileId={s.profile_id}
                projects={projects} costCodes={costCodes} canDelete={false} onDone={() => setEditingId(null)} />}
            </li>;
          })}
        </ol>
        {entries.length > visibleCount && <button type="button" className="button-like unassigned-more" onClick={() => setVisibleCount(n => n + 20)}>
          <ChevronDown size={18} aria-hidden />{t("unassigned.more", { count: Math.min(20, entries.length - visibleCount) })}
        </button>}
      </>}
    </>}
  </section>;
}
