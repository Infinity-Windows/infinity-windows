import type { WorkSession, WorkUnit } from "../../lib/customWork/model";
import { useState, type CSSProperties } from "react";
import { AgendaUnitDetails, type AgendaUnit } from "./AgendaUnitDetails";
import { isUnitComplete } from "../../lib/customWork/complete";
import { pilotActivityColor } from "../../lib/installerWorkflow/pilotActivities";
import { CalendarDays, ChevronRight } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import { useLanguage } from "../../lib/i18n";
import type { PlannedJob } from "../../lib/installerWorkflow/sharedPlan";
import { addDaysISO } from "../../lib/schedule/dates";
import { coversPlanSlot, planBoundary, type PlanBlock } from "../../lib/installerWorkflow/jobPlan";
import { ActivityIcon, activityLabel } from "../installerPilot/workdayActivities";
import type { ScheduleAssignment } from "../../lib/schedule/types";

export function AssignedPlan({ profileId, today, plan, scheduled = [], previewSessions, previewUnitCompletion, liveWork }: {
  profileId: string;
  today: string;
  plan: UseQueryResult<PlannedJob[]>;
  /**
   * This person's published schedule for the same two weeks. A job on the
   * schedule that nobody has laid out on the Plan yet still belongs here, or
   * the list reads "no assigned work" to someone who is booked (Matt,
   * 2026-11-22). A job with planned work showing is not repeated.
   */
  scheduled?: readonly ScheduleAssignment[];
  previewSessions?: readonly WorkSession[];
  previewUnitCompletion?: Record<string, boolean>;
  liveWork?: { sessions: readonly WorkSession[]; units: readonly WorkUnit[] };
}) {
  const { lang } = useLanguage();
  const [unit, setUnit] = useState<AgendaUnit | null>(null);
  const localWorkUnit = unit && liveWork?.units.find(workUnit =>
    workUnit.project_id === unit.projectId && workUnit.opening_id === unit.id);
  const es = lang === "es";
  const title = es ? "Próximos trabajos" : "Upcoming work";
  const through = addDaysISO(today, 13);
  if (plan.isError && !plan.data) return (
    <section className="ws-card" aria-label={title}>
      <p role="status">{es ? "No se pudo cargar el plan." : "Couldn’t load assigned work."}</p>
      <button className="ws-btn" onClick={() => void plan.refetch()}>{es ? "Reintentar" : "Retry"}</button>
    </section>
  );
  // One section per day, named by its date down the left. The list used to be
  // cut into "Today / Next few days / Remaining", which made a person read
  // every row's own date to learn when anything was (Matt, 2026-11-23).
  const days = new Map<string, { jobs: Map<string, PlannedJob>; booked: Map<string, ScheduleAssignment[]> }>();
  const dayOf = (day: string) => {
    if (day > through) return null;
    if (!days.has(day)) days.set(day, { jobs: new Map(), booked: new Map() });
    return days.get(day)!;
  };
  const planned = new Set<string>();
  for (const job of plan.data ?? []) {
    for (const block of job.blocks) {
      if (block.start < today) continue;
      const period = dayOf(block.start);
      if (!period) continue;
      const group = period.jobs.get(job.projectId) ?? { ...job, blocks: [] };
      group.blocks.push(block);
      period.jobs.set(job.projectId, group);
      planned.add(job.projectId);
    }
  }
  for (const entry of scheduled) {
    if (!entry.project_id || !entry.project || planned.has(entry.project_id)) continue;
    if (entry.status !== "published" || entry.end_date < today) continue;
    // A booking already under way belongs to today, as it does on the Workday.
    const day = entry.start_date < today ? today : entry.start_date;
    const period = dayOf(day);
    if (!period) continue;
    period.booked.set(entry.project_id, [...(period.booked.get(entry.project_id) ?? []), entry]);
  }

  const agenda = [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, group]) => ({ day, ...group }));
  if (!agenda.length) return <section className="ws-card" aria-label={title}>
    <h2 className="ws-h2">{title}</h2>
    <p className="ws-meta">{plan.isLoading ? (es ? "Cargando…" : "Loading…")
      : (es ? "Sin trabajo asignado para las próximas dos semanas." : "No assigned work in the next two weeks.")}</p>
  </section>;
  const dayLabel = new Intl.DateTimeFormat(lang, { weekday: "short", month: "short", day: "numeric" });
  const timeLabel = new Intl.DateTimeFormat(lang, { hour: "numeric", minute: "2-digit" });
  const dayName = (iso: string) => dayLabel.format(new Date(iso + "T12:00:00"));
  // The section already says the first day; a row only adds where it ends.
  const until = (end: string) => `${es ? "hasta" : "through"} ${dayName(end)}`;
  const unitsLabel = (count: number) => es ? (count === 1 ? "unidad" : "unidades") : (count === 1 ? "unit" : "units");
  const byStart = (a: PlanBlock, b: PlanBlock) =>
    a.start.localeCompare(b.start) || planBoundary(a, "start") - planBoundary(b, "start");
  const grouped = (blocks: PlanBlock[]) => {
    const rows = new Map<string, PlanBlock[]>();
    for (const block of [...blocks].sort(byStart)) {
      const key = [block.kind, block.activity, block.start, block.end].join("|");
      rows.set(key, [...(rows.get(key) ?? []), block]);
    }
    return [...rows.values()];
  };
  return (
    <section className="ws-card ws-upcoming-plan" aria-label={title}>
      <h2 className="ws-h2">{title}</h2>
      {agenda.map(({ day, jobs, booked }) => (
        <section className="ws-plan-date" key={day}>
          <h3 className="ws-plan-date-label"><time dateTime={day}>{day === today ? (es ? "Hoy" : "Today") : dayName(day)}</time></h3>
          <div className="ws-plan-jobs">{[...jobs.values()].map(job => (
            <section className="ws-plan-job" key={job.projectId} aria-label={job.jobCode}>
              <h4>{job.jobName || job.jobCode}</h4>
              {grouped(job.blocks).map(cards => {
                // One row per activity and day, however many cards the Plan
                // holds for it (carried work arrives as a card per original
                // day). The cards stay separate in the Plan; each unit keeps
                // the crew of the card it came from.
                const block = cards[0];
                const seen = new Set<string>();
                const units = cards.flatMap(card => card.openingIds.flatMap(id => {
                  if (seen.has(id)) return [];
                  seen.add(id);
                  return [{ id, card }];
                }));
                const isLead = (unit: typeof units[number]) => unit.card.openingCrew?.[unit.id]?.leadId === profileId;
                const roles = [
                  { name: es ? "A cargo" : "Lead", units: units.filter(isLead) },
                  { name: es ? "Equipo" : "Crew", units: units.filter(unit => !isLead(unit)) },
                ];
                const shifts = block.start === block.end
                  ? (["AM", "PM"] as const).filter(period => cards.some(card => coversPlanSlot(card, card.start, period)))
                  : [];
                const timing = shifts.join(" / ");
                const count = units.length;
                const row = <>
                  <span className="ws-plan-icon"><ActivityIcon activity={block.activity} /></span>
                  <strong>{activityLabel(block.activity, es)}</strong>
                  <span className="ws-plan-meta">
                    {block.end > block.start && <span>{until(block.end)}</span>}
                    {timing && <span>{timing}</span>}
                    {count > 0 && <span>{count} {unitsLabel(count)}</span>}
                    {roles.map(({ name, units }) => units.length > 0 && <span key={name}>{name} {units.length}</span>)}
                  </span>
                </>;
                return (
                  <article className="ws-plan-entry" key={block.id}
                    style={{ "--activity-color": pilotActivityColor(`${block.kind}:${block.activity}`) } as CSSProperties}>
                    {count > 0 ? <details>
                      <summary className="ws-plan-row">{row}<ChevronRight className="ws-plan-chevron" size={16} aria-hidden="true" /></summary>
                      <div className="ws-plan-roles">
                        {roles.map(({ name, units }) => {
                          if (!units.length) return null;
                          const missingLabels = units.filter(unit => !job.unitLabels[unit.id]).length;
                          return <div className="ws-plan-role" key={name}>
                            <strong>{name}</strong>
                            <div className="ws-plan-units">
                              {units.map(({ id, card }) => {
                                const label = job.unitLabels[id];
                                if (!label) return null;
                                const crew = card.openingCrew?.[id];
                                return <button type="button" className="ws-plan-unit" key={id} aria-haspopup="dialog" onClick={() => setUnit({
                                  id, label, projectId: job.projectId, activity: card.activity,
                                  leadId: crew?.leadId, crewIds: crew?.crewIds ?? (card.unitCrewOnly ? [] : card.installerIds),
                                })}>{label}</button>;
                              })}
                              {missingLabels > 0 && <span className="ws-meta">
                                {missingLabels} {es ? "sin etiqueta" : "without unit labels"}
                              </span>}
                            </div>
                          </div>;
                        })}
                      </div>
                    </details> : <div className="ws-plan-row">{row}</div>}
                  </article>
                );
              })}
            </section>
          ))}{[...booked.values()].map(entries => {
            const { project, project_id: projectId } = entries[0];
            return <section className="ws-plan-job" key={projectId} aria-label={project!.job_code}>
              <h4>{project!.name || project!.job_code}</h4>
              {entries.map(entry => {
                const from = entry.start_date < today ? today : entry.start_date;
                const [hour, minute] = entry.start_time?.split(":").map(Number) ?? [];
                return <article className="ws-plan-entry" key={entry.id}>
                  <div className="ws-plan-row">
                    <span className="ws-plan-icon"><CalendarDays size={16} aria-hidden="true" /></span>
                    <strong>{es ? "Programado" : "Scheduled"}</strong>
                    <span className="ws-plan-meta">
                      {entry.end_date > from && <span>{until(entry.end_date)}</span>}
                      {Number.isFinite(hour) && <span>{timeLabel.format(new Date(2000, 0, 1, hour, minute || 0))}</span>}
                    </span>
                  </div>
                </article>;
              })}
            </section>;
          })}</div>
        </section>
      ))}
      {unit && <AgendaUnitDetails unit={unit} profileId={profileId} onClose={() => setUnit(null)}
        localUnitComplete={previewUnitCompletion?.[unit.id] ?? (localWorkUnit ? isUnitComplete(localWorkUnit) : undefined)}
        localSessions={(previewSessions ?? liveWork?.sessions ?? []).filter(session =>
          session.project_id === unit.projectId && session.stage === unit.activity
          && (previewSessions ? session.profile_id === profileId && session.unit_id === unit.id
            : liveWork?.units.some(workUnit => workUnit.id === session.unit_id && workUnit.opening_id === unit.id)))}
      />}
    </section>
  );
}
