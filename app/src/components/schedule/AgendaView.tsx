import { AlertTriangle, Plus, Truck } from "lucide-react";
import { useLanguage } from "../../lib/i18n";
import { addDaysISO, enumerateDays, formatScheduleTime } from "../../lib/schedule/dates";
import { calendarColorStyle } from "../../lib/schedule/jobHue";
import type { ScheduleAssignment } from "../../lib/schedule/types";

export function AgendaView({ day, weekStart, assignments, conflictIds, vehicleLabels, onDay, onOpen, onCreate }: {
  day: string; weekStart: string; assignments: ScheduleAssignment[];
  conflictIds: Set<string>; vehicleLabels: Map<string, string>;
  onDay: (day: string) => void; onOpen: (assignment: ScheduleAssignment) => void;
  onCreate?: (day: string) => void;
}) {
  const { lang, t } = useLanguage();
  const locale = lang === "es" ? "es-US" : "en-US";
  const label = (date: string, long = false) => new Date(`${date}T12:00:00`).toLocaleDateString(locale, {
    weekday: long ? "long" : "short", month: long ? "short" : undefined, day: "numeric",
  });
  const items = assignments.filter(a => a.status !== "canceled" && a.start_date <= day && a.end_date >= day)
    .sort((a, b) => (a.start_time ?? "24:00").localeCompare(b.start_time ?? "24:00") || a.id.localeCompare(b.id));
  return (
    <section className="sched-agenda" aria-label={t("schedule.agenda")}>
      <div className="sched-agenda-days" role="group" aria-label={t("schedule.agenda")}>
        {enumerateDays(weekStart, addDaysISO(weekStart, 6)).map(date => (
          <button key={date} className={`button-like${date === day ? " active-pill" : ""}`}
            aria-pressed={date === day} onClick={() => onDay(date)}>{label(date)}</button>
        ))}
      </div>
      <h2>{label(day, true)}</h2>
      {items.length === 0 && <p className="muted">{t("schedule.emptyDay")}</p>}
      <div className="sched-agenda-items">
        {items.map(a => (
          <button key={a.id} className={`sched-agenda-item${a.kind === "delivery" ? " delivery" : ""}`} style={calendarColorStyle(a)} onClick={() => onOpen(a)}>
            <strong>{a.kind === "delivery" ? a.delivery?.label ?? t("schedule.delivery") :
              [a.project?.job_code, a.project?.name].filter(Boolean).join(" · ") || t("schedule.job")}</strong>
            <span>{a.start_time ? formatScheduleTime(a.start_time, a.end_time) : "—"} · {t("schedule.crewCount", { n: a.members.length })}</span>
            <span>{a.members.map(m => m.display_name).filter(Boolean).join(", ")}</span>
            {vehicleLabels.get(a.id) && <span><Truck size={14} aria-hidden /> {vehicleLabels.get(a.id)}</span>}
            {a.status === "draft" && <span className="travel-chip travel-chip-draft">{t("schedule.draft")}</span>}
            {a.status === "published" && <span className="travel-chip">{t("schedule.published")}</span>}
            {conflictIds.has(a.id) && <span className="warn-text"><AlertTriangle size={14} aria-hidden /> {t("schedule.conflict")}</span>}
          </button>
        ))}
      </div>
      {onCreate && <button className="button-like" onClick={() => onCreate(day)}>
        <Plus size={16} aria-hidden /> {t("schedule.addDay", { date: label(day) })}
      </button>}
    </section>
  );
}
