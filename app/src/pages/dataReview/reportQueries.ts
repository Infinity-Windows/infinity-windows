import { listProjectsAnyStatus } from "../../lib/api";
import { signInMark } from "../../lib/signedIn";
import { listTeamShifts } from "../../lib/timeclock";

// Private, memory-only snapshots revalidate automatically when stale.
// High-frequency clock updates use a separate bounded recent-window query.
export const reportQueryPolicy = {
  staleTime: 5 * 60_000, gcTime: 5 * 60_000, retry: false,
  refetchOnMount: true, refetchOnWindowFocus: true, refetchOnReconnect: true,
  refetchInterval: false, meta: { offline: false },
} as const;
export function reportOwner() {
  const mark = signInMark();
  return `${mark.userId}:${mark.generation}`;
}
export function reportProjects(owner: string, active: boolean) {
  return { ...reportQueryPolicy, queryKey: ["dataReview", owner, "projects"], queryFn: listProjectsAnyStatus, enabled: active };
}
export function reportShifts(owner: string, jobs: readonly string[] | null, from: number, until: number, active: boolean) {
  const ids = jobs === null ? null : [...new Set(jobs)].sort();
  return {
    ...reportQueryPolicy,
    queryKey: ["dataReview", owner, "clockedShifts", ids, Number.isFinite(from) ? from : null, Number.isFinite(until) ? until : null],
    queryFn: ({ signal }: { signal: AbortSignal }) => listTeamShifts(Number.isFinite(from) ? new Date(from).toISOString() : null, Number.isFinite(until) ? new Date(until).toISOString() : null, undefined, { projectIds: ids, signal }),
    // Reconcile bounded windows, including historical edits/voids. Never timer-scan all history.
    refetchInterval: active && Number.isFinite(from) && Number.isFinite(until) && until - from <= 45 * 86400_000 ? 5 * 60_000 : false as const,
    enabled: active && from < until && (ids === null || ids.length > 0),
  };
}

/** Limit Current's six-reader bundles to one job at a time. Cancellation stops
 * the queue before the next job; already-issued legacy reads may finish. */
export async function mapReportJobs<T, R>(jobs: T[], read: (job: T) => Promise<R>, serial: boolean, signal: AbortSignal): Promise<R[]> {
  if (!serial) return Promise.all(jobs.map(read));
  const result: R[] = [];
  for (const job of jobs) { signal.throwIfAborted(); result.push(await read(job)); }
  return result;
}
