import { supabase } from "../../lib/supabase";
import type { WorkUnit } from "../../lib/customWork/model";
import type { ActivityRow } from "./activityRows";

export interface HistoricalSession {
  id: string; opening_id: string; profile_id: string; role: string; is_rework: boolean;
  started_at: string; ended_at: string; end_reason: string | null;
  opening: { id: string; project_id: string; opening_code: string; label: string | null };
}

/** Existing RLS remains in force. No service key or business writes. */
export async function readHistoricalLabor(jobIds: string[], from: number, until: number, signal?: AbortSignal): Promise<HistoricalSession[]> {
  if (!jobIds.length || from >= until) return [];
  const result: HistoricalSession[] = [];
  let expected: number | null = null;
  for (let offset = 0; offset < 1000000;) {
    let query = supabase.from("unit_sessions")
      .select("id,opening_id,profile_id,role,is_rework,started_at,ended_at,end_reason,opening:project_openings!inner(id,project_id,opening_code,label)", { count: "exact" })
      .in("opening.project_id", jobIds).is("opening.removed_at", null)
      .not("ended_at", "is", null).order("id").range(offset, offset + 499);
    if (Number.isFinite(from)) query = query.gt("ended_at", new Date(from).toISOString());
    if (Number.isFinite(until)) query = query.lt("started_at", new Date(until).toISOString());
    if (signal) query = query.abortSignal(signal);
    const { data, error, count } = await query;
    if (error) throw error;
    if (count === null || (expected !== null && expected !== count)) throw new Error("Historical records changed while loading. Refresh.");
    expected = count;
    const page = (data ?? []) as unknown as HistoricalSession[];
    result.push(...page); offset += page.length;
    if (offset === count) {
      if (new Set(result.map(row => row.id)).size !== count) throw new Error("Historical records changed while loading. Refresh.");
      return result;
    }
    if (!page.length) throw new Error("Historical records did not load completely.");
  }
  throw new Error("Choose fewer jobs or a shorter date range.");
}

export function historicalRows(sessions: HistoricalSession[], units: WorkUnit[], people: Map<string, string>, from: number, until: number) {
  const byOpening = new Map(units.filter(unit => unit.opening_id).map(unit => [unit.opening_id!, unit]));
  const rows: ActivityRow[] = [];
  for (const session of sessions) {
    const start = Date.parse(session.started_at), end = Date.parse(session.ended_at);
    const seconds = (Math.min(end, until) - Math.max(start, from)) / 1000;
    if (!Number.isFinite(seconds) || seconds <= 0 || end <= start || !session.opening) continue;
    const unit = byOpening.get(session.opening_id);
    const sameJobUnit = unit?.project_id === session.opening.project_id ? unit : undefined;
    rows.push({ id: `unit_sessions:${session.id}`, sourceTable: "unit_sessions", openingId: session.opening_id,
      jobId: session.opening.project_id, job: session.opening.project_id,
      activity: session.role === "helper" ? "Helper" : "Install", scope: "Specific",
      personId: session.profile_id, person: people.get(session.profile_id) ?? session.profile_id,
      unitId: sameJobUnit?.id ?? `opening:${session.opening_id}`, unit: sameJobUnit?.label ?? session.opening.opening_code,
      unitRecord: sameJobUnit, openingCode: session.opening.opening_code,
      floor: sameJobUnit?.facts.story?.trim() || "Unknown", category: null, subtype: null,
      seconds, started: session.started_at, ended: session.ended_at, revision: 0,
      outcome: session.is_rework ? "rework" : session.end_reason === "auto_closed" ? "Review: auto-closed" : session.end_reason ?? "Not recorded",
    });
  }
  return rows;
}

/** Conservative custom-first preview: hold out whole historical visits that
 * overlap another source for the same person. Never assert they are duplicates. */
export function reconcileHistorical(custom: ActivityRow[], historical: ActivityRow[]) {
  const held: ActivityRow[] = [], accepted: ActivityRow[] = [];
  for (const row of historical) {
    const overlaps = custom.some(other => other.personId === row.personId && Date.parse(other.started) < Date.parse(row.ended) && Date.parse(row.started) < Date.parse(other.ended));
    (overlaps ? held : accepted).push(row);
  }
  return { rows: [...custom, ...accepted], held };
}
