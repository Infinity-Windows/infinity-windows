// Wave D, D5 (audit hole 7): the 30-day blind spot on read paths that query
// a child table directly by project_id, cutting across every job at once.
// The projects RLS predicate hides a trashed job's own row; it does nothing
// for these, because trash never rewrites project_id anywhere. See the
// live_project_ids() SQL comment (20260960000000) for why this is a
// SECURITY DEFINER RPC rather than a `projects!inner(...)` embed.

import { supabase } from "./supabase";

/**
 * Filters a list of already-fetched rows down to the ones whose project is
 * not currently trashed — one batched RPC call over every distinct
 * project_id already present, never one call per row.
 */
export async function filterToLiveProjects<T extends { project_id: string | null }>(
  rows: T[],
): Promise<T[]> {
  const ids = Array.from(new Set(rows.map((r) => r.project_id).filter((id): id is string => id != null)));
  if (ids.length === 0) return rows;
  const { data, error } = await supabase.rpc("live_project_ids", { p_ids: ids });
  if (error) throw error;
  const live = new Set((data ?? []) as string[]);
  return rows.filter((r) => r.project_id == null || live.has(r.project_id));
}
