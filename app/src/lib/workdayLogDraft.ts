import type { QueryClient } from "@tanstack/react-query";
import { isUnitComplete } from "./customWork/complete";
import { listWorkSessions, listWorkUnits } from "./customWork/api";
import { clockText, previewCommands, type WorkSession, type WorkUnit } from "./customWork/model";
import { readWorkQueue } from "./customWork/queue";
import type { DailyLogDraft } from "./dailyLogDraft";

export async function buildWorkdayLogDraft(
  client: QueryClient,
  projectId: string,
  day: string,
  personId: string,
): Promise<DailyLogDraft> {
  const start = new Date(day + "T00:00:00");
  const end = new Date(start);
  end.setDate(start.getDate() + 1);
  const from = start.getTime(), until = end.getTime();
  const cachedSessions = client.getQueryData<WorkSession[]>(["customWorkSessions", personId, "mine"])
    ?? client.getQueryData<WorkSession[]>(["customWorkSessions", personId, projectId])
    ?? client.getQueriesData<WorkSession[]>({ queryKey: ["recentWorkSessions", personId, projectId] }).at(-1)?.[1];
  const cachedUnits = client.getQueryData<WorkUnit[]>(["customWorkUnits", personId, projectId])
    ?? client.getQueryData<WorkUnit[]>(["customWorkUnits", personId, "all"]);
  const signal = AbortSignal.timeout(5_000);
  const [remoteSessions, remoteUnits] = navigator.onLine ? await Promise.allSettled([
    listWorkSessions(projectId, personId, { from, until, includeOpen: true, signal }),
    listWorkUnits(projectId, signal),
  ]) : [];
  const saved = remoteSessions?.status === "fulfilled";
  const sessions = saved ? remoteSessions.value : cachedSessions ?? [];
  const units = remoteUnits?.status === "fulfilled" ? remoteUnits.value : cachedUnits ?? [];
  const queue = readWorkQueue(personId).filter(command => !command.error);
  const preview = previewCommands(units, sessions, queue);
  const rows = preview.sessions.filter(row => row.profile_id === personId && row.project_id === projectId
    && row.shift_status !== "voided" && Date.parse(row.started_at) < until
    && (row.ended_at ? Date.parse(row.ended_at) > from : Date.parse(row.started_at) >= from));
  const byUnit = new Map(preview.units.map(unit => [unit.id, unit]));
  const snapshot = new Map(sessions.map(row => [row.id, row]));
  const notes = rows.sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at)).map(row => {
    const began = Date.parse(row.started_at);
    const finished = row.ended_at ? Date.parse(row.ended_at) : null;
    const [activity, ...description] = row.kind === "idle" ? row.description.split(" — ") : [row.stage, row.description];
    const local = JSON.stringify(snapshot.get(row.id)) !== JSON.stringify(row);
    const unitRecord = row.unit_id ? byUnit.get(row.unit_id) : undefined;
    const unit = row.unit_id ? " · Unit " + (unitRecord?.label ?? "(number unavailable)") : "";
    const whole = unitRecord && isUnitComplete(unitRecord) ? " · Unit currently marked complete" : "";
    const timer = finished !== null ? clockText(Math.max(0, Math.round((Math.min(finished, until) - Math.max(began, from)) / 1000))) : "Open timer";
    const machine = row.workday_machinery_ms && began >= from && (finished ?? until) <= until
      ? " · Machinery " + clockText(Math.round(row.workday_machinery_ms / 1000)) : "";
    const outcome = row.workday_done_at && Date.parse(row.workday_done_at) < until && row.outcome !== "rework"
      ? "Activity marked done" : finished !== null && finished < until ? row.outcome : null;
    return "- " + (activity || "Recorded activity") + unit + " · " + timer + machine
      + (outcome ? " · " + outcome : "") + whole + (local ? " · Pending sync" : "")
      + (description.join(" — ").trim() ? ": " + description.join(" — ").trim() : "");
  });
  return {
    headline: rows.length ? "Recorded Workday activities" : "",
    notesDraft: notes.length ? ["Workday records (" + (saved ? "saved records and any pending changes shown below" : "saved copy; may be incomplete") + ")", ...notes].join("\n") : "",
    crewLine: saved ? "" : "Workday records could not be refreshed.",
  };
}
