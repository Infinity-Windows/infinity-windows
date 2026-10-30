import { documentationEvidence } from "./documentationEvidence";
import { supabase } from "../../lib/supabase";
import { reportingActivity } from "./activityLabels";
import { readPhaseLabor } from "./phaseLabor";
import type { WorkUnit } from "../../lib/customWork/model";
import type { ActivityRow } from "./activityRows";

export interface HistoricalSession {
  sourceTable?: "opening_phases"; savedMinutes?: number | null; reviewReason?: string;
  id: string; opening_id: string; profile_id: string; role: string; is_rework: boolean;
  started_at: string; ended_at: string; end_reason: string | null;
  opening: { id: string; project_id: string; opening_code: string; label: string | null };
}

/** Existing RLS remains in force. No service key or business writes. */
export async function readHistoricalLabor(jobIds: string[], from: number, until: number, signal?: AbortSignal, includePhases=false): Promise<HistoricalSession[]> {
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
      return includePhases ? [...result,...await readPhaseLabor(jobIds,from,until,signal)] : result;
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
    const isPhase=session.sourceTable === "opening_phases";
    const seconds = isPhase ? Number.isFinite(session.savedMinutes) ? Math.max(0,session.savedMinutes!)*60 : 0 : (Math.min(end, until) - Math.max(start, from)) / 1000;
    if (!session.opening) continue;
    const invalidInterval = !Number.isFinite(seconds) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start;
    const unit = byOpening.get(session.opening_id);
    const sameJobUnit = unit?.project_id === session.opening.project_id ? unit : undefined;
    rows.push({ id: `${session.sourceTable ?? "unit_sessions"}:${session.id}`, sourceTable: session.sourceTable ?? "unit_sessions", openingId: session.opening_id,
      jobId: session.opening.project_id, job: session.opening.project_id,
      activity: isPhase ? "Flashing" : session.role === "helper" ? "Helper" : "Install", scope: "Specific",
      personId: session.profile_id, person: people.get(session.profile_id) ?? session.profile_id,
      unitId: sameJobUnit?.id ?? `opening:${session.opening_id}`, unit: sameJobUnit?.label ?? session.opening.opening_code,
      unitRecord: sameJobUnit, openingCode: session.opening.opening_code,
      floor: sameJobUnit?.facts.story?.trim() || "Unknown", category: null, subtype: null,
      seconds: invalidInterval ? 0 : seconds, started: session.started_at, ended: session.ended_at, revision: 0,
      reviewReason: session.reviewReason ?? (invalidInterval ? "Invalid timer duration or interval" : undefined) ?? (isPhase && (start<from || end>until) ? "Phase crosses date boundary; saved minutes cannot be precisely apportioned" : undefined),
      outcome: session.is_rework ? "rework" : isPhase ? "Submitted phase · saved whole minutes" : session.end_reason === "auto_closed" ? "Review: auto-closed" : session.end_reason ?? "Not recorded",
    });
  }
  return rows;
}

/** Keep uncertain positive time out of totals without claiming window overlap
 * proves duplication. Phases are aggregate minutes, not continuous intervals. */
export function reconcileHistorical(custom: ActivityRow[], historical: ActivityRow[]) {
  const held: ActivityRow[] = [], accepted: ActivityRow[] = [];
  const seen = new Set<string>();
  for (const row of [...custom, ...historical]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const start = Date.parse(row.started), end = Date.parse(row.ended);
    const documentation = documentationEvidence(row);
    const problem = documentation ? `After-the-fact documentation - timecard ${documentation.id}: "${documentation.note}". Work date, duration and actual worker require confirmation${row.reviewReason ? `; ${row.reviewReason}` : ""}` : row.reviewReason || (!Number.isFinite(row.seconds) || row.seconds < 0 || !Number.isFinite(start) || !Number.isFinite(end) || end <= start
      ? "Invalid timer duration or interval" : row.sourceTable === "opening_phases" && row.seconds >= 480 * 60
        ? "Saved phase time reaches the 480-minute cap; actual duration needs review"
        : row.outcome === "Review: auto-closed" ? "Auto-closed timer; actual end needs review" : undefined);
    if (problem) {
      held.push({...row, reviewKind: "timer", reviewReason: `Timer problem · ${problem}`});
      continue;
    }
    // Zero saved minutes retain completion/source evidence but cannot consume time.
    const overlaps = row.seconds > 0 && row.personId ? accepted.filter(other => other.seconds > 0 && other.personId === row.personId && Date.parse(other.started) < end && start < Date.parse(other.ended)) : [];
    const duplicate = overlaps.find(other => row.sourceTable !== "opening_phases" && other.sourceTable !== "opening_phases" && !!row.openingId && row.openingId === other.openingId && !!row.jobId && row.jobId === other.jobId && reportingActivity(row.activity) === reportingActivity(other.activity) && start === Date.parse(other.started) && end === Date.parse(other.ended) && row.seconds === other.seconds && row.outcome === other.outcome);
    if (duplicate) held.push({...row, reviewKind: "duplicate", reviewRelatedIds: [duplicate.id], reviewReason: `Confirmed duplicate time · identical person, opening, activity, interval and duration to ${duplicate.id}`});
    else if (overlaps.length) held.push({...row, reviewKind: "overlap", reviewRelatedIds: overlaps.map(other => other.id), reviewReason: `Uncertain overlap with ${overlaps.map(other => other.id).join(", ")} · excluded pending review${row.sourceTable === "opening_phases" || overlaps.some(other => other.sourceTable === "opening_phases") ? "; saved phase minutes cannot be located precisely within the submission window" : ""}`});
    else accepted.push(row);
  }
  return { rows: accepted, held };
}
