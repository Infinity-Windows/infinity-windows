import { useQuery } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";
import { listFirstFinishedShifts } from "../../lib/timeclock";
import { reportQueryPolicy } from "./reportQueries";
import { midnight, workDate } from "./generalLabor";
import { nextWeekDate } from "./weeklyUnitRateData";
export type RelativeOrigin = { jobId: string; startedAt: string; job?: string };
export type RelativeStart = "clocked" | "unit";
/** One candidate per source/job, using explicit opening links. No date,
 * activity, person or area filter is permitted to move this origin. */
export async function firstUnitOrigins(jobs: string[], signal?: AbortSignal): Promise<RelativeOrigin[]> {
  const result: RelativeOrigin[] = [];
  for (const job of jobs) {
    signal?.throwIfAborted();
    const candidates: { started_at: string; ended_at: string }[] = [];
    for (const table of ["custom_work_sessions", "unit_sessions"]) {
      let query = table === "custom_work_sessions"
        ? supabase.from(table).select("id,started_at,ended_at,unit:custom_work_units!inner(project_id,opening:project_openings!inner(project_id,removed_at))").eq("project_id", job).eq("kind", "unit").eq("unit.project_id", job).eq("unit.opening.project_id", job).is("unit.opening.removed_at", null)
        : supabase.from(table).select("id,started_at,ended_at,opening:project_openings!inner(project_id,removed_at)").eq("opening.project_id", job).is("opening.removed_at", null);
      query = query.not("ended_at", "is", null).not("started_at", "is", null).order("started_at").order("id").limit(1);
      if (signal) query = query.abortSignal(signal);
      const { data, error } = await query;
      if (error) throw error;
      for (const row of data ?? []) {
        if (!Number.isFinite(Date.parse(row.started_at)) || !Number.isFinite(Date.parse(row.ended_at)) || Date.parse(row.ended_at) <= Date.parse(row.started_at)) throw new Error("First linked unit timer needs interval review; origin unavailable.");
        candidates.push(row);
      }
    }
    candidates.sort((a, b) => a.started_at.localeCompare(b.started_at));
    if (candidates[0]) result.push({ jobId: job, startedAt: candidates[0].started_at });
  }
  return result;
}
export function useRelativeOrigins(owner: string, jobs: string[], basis: RelativeStart, enabled: boolean) {
  const clocked = useQuery({ ...reportQueryPolicy, queryKey: ["dataReview", owner, "clockedOrigins", jobs], queryFn: ({ signal }) => listFirstFinishedShifts(jobs, signal), select: rows => rows.filter(row => !!row.project_id && Number.isFinite(Date.parse(row.clock_in_at))).map(row => ({ jobId: row.project_id!, startedAt: row.clock_in_at, job: row.projects?.job_code })), enabled: enabled && basis === "clocked" && jobs.length > 0 });
  const unit = useQuery({ ...reportQueryPolicy, queryKey: ["dataReview", owner, "unitOrigins", jobs], queryFn: ({ signal }) => firstUnitOrigins(jobs, signal), enabled: enabled && basis === "unit" && jobs.length > 0 });
  return basis === "unit" ? unit : clocked;
}
export function relativeOriginWindows(origins: RelativeOrigin[], count: number) {
  return origins.filter(origin => origin.jobId && Number.isFinite(Date.parse(origin.startedAt))).map(origin => {
    const date = workDate(Date.parse(origin.startedAt));
    return { jobId: origin.jobId, from: midnight(date), until: midnight(nextWeekDate(date, count * 7)) };
  });
}
