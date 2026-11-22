import { readShiftRange } from "./shiftRangeCache";
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listTeamShifts, type TimeShift } from "../../lib/timeclock";
import { reportQueryPolicy, reportShifts } from "./reportQueries";

export function mergeRecentShifts(snapshot: TimeShift[], incoming: TimeShift[], from: number, until: number, pinnedIds: string[]) {
  const pinned = new Set(pinnedIds);
  const rows = new Map(snapshot.filter(row => !pinned.has(row.id) && !(Date.parse(row.clock_in_at) >= from && Date.parse(row.clock_in_at) < until)).map(row => [row.id, row]));
  for (const row of incoming) if (row.status !== "voided") rows.set(row.id, row);
  return [...rows.values()].sort((a, b) => Date.parse(b.clock_in_at) - Date.parse(a.clock_in_at) || b.id.localeCompare(a.id));
}

/** Keep an authoritative snapshot, then cheaply replace recent/open coverage.
 * A failed or cancelled poll never commits a partial result. Older closed edits
 * are reconciled by the snapshot, not guessed from a nonexistent change cursor. */
export function useReportShifts(owner: string, jobs: readonly string[] | null, from: number, until: number, active: boolean) {
  const client = useQueryClient();
  const options = reportShifts(owner, jobs, from, until, active);
  const scopeKey = JSON.stringify(options.queryKey);
  const snapshot = useQuery({...options, structuralSharing:false,
    queryFn:({signal})=>readShiftRange(client,options.queryKey,from,until,signal,(start,end)=>listTeamShifts(Number.isFinite(start)?new Date(start).toISOString():null,Number.isFinite(end)?new Date(end).toISOString():null,undefined,{projectIds:jobs===null?null:[...jobs],signal})),
    placeholderData:(previous,query)=>query?.queryKey[1]===owner?previous:undefined,
  });
  const hasRecentWindow=until>Date.now()-2*86400_000;
  const hasOpenRecords=snapshot.data?.some(row=>!row.clock_out_at)??false;
  const recent = useQuery({
    ...reportQueryPolicy,
    queryKey: [...options.queryKey, "recent"],
    enabled: options.enabled && snapshot.data !== undefined && !snapshot.isPlaceholderData && (hasRecentWindow||hasOpenRecords),
    structuralSharing: false,
    staleTime: 30_000, refetchInterval: active ? 30_000 : false,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      const cached = client.getQueryData<TimeShift[]>(options.queryKey) ?? [];
      const recentFrom = Math.max(from, Date.now() - 2 * 86400_000);
      const pinned = cached.filter(row => !row.clock_out_at && Date.parse(row.clock_in_at) < recentFrom).map(row => row.id);
      const rows = recentFrom < until ? await listTeamShifts(new Date(recentFrom).toISOString(), Number.isFinite(until) ? new Date(until).toISOString() : null, undefined, { projectIds: jobs === null ? null : [...jobs], signal }) : [];
      // Bound URL size; include older running/unresolved punches by identity so
      // finishing, moving or voiding one removes the old cached contribution.
      for (let index = 0; index < pinned.length; index += 100) {
        signal.throwIfAborted();
        rows.push(...await listTeamShifts(Number.isFinite(from) ? new Date(from).toISOString() : null, Number.isFinite(until) ? new Date(until).toISOString() : null, undefined, { projectIds: jobs === null ? null : [...jobs], ids: pinned.slice(index, index + 100), signal }));
      }
      signal.throwIfAborted();
      return { rows, from: recentFrom, until, pinned, baseline: cached };
    },
  });
  useEffect(() => {
    if (!active || !recent.data) return;
    const update = recent.data;
    // A newer full snapshot wins over a poll that started against older data.
    if (client.getQueryData(options.queryKey) !== update.baseline) return;
    const updatedAt = client.getQueryState(options.queryKey)?.dataUpdatedAt;
    client.setQueryData(options.queryKey, mergeRecentShifts(update.baseline, update.rows, update.from, update.until, update.pinned), { updatedAt });
    // queryKey is canonical by value; do not re-apply the same poll on renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, client, recent.dataUpdatedAt, scopeKey]);
  return snapshot;
}
