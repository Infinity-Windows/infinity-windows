import { supabase } from "./supabase";
import type { GeoFix } from "./geo";

export interface CostCode {
  id: string;
  code: string;
  label: string;
  description?: string | null;
  active: boolean;
  sort_order?: number;
}

export type BreakType = "lunch" | "rest" | "other";

export const BREAK_TYPES: { type: BreakType; label: string; icon: string }[] = [
  { type: "lunch", label: "Lunch", icon: "🍔" },
  { type: "rest", label: "Rest", icon: "☕" },
  { type: "other", label: "Other", icon: "⏸" },
];

export function breakTypeLabel(t: BreakType | null | undefined): string {
  return BREAK_TYPES.find((b) => b.type === t)?.label ?? "Break";
}

export interface TimeShift {
  id: string;
  profile_id: string;
  project_id: string | null;
  cost_code_id: string | null;
  clock_in_at: string;
  clock_out_at: string | null;
  break_seconds: number;
  break_started_at: string | null;
  break_type?: BreakType | null;
  injured: boolean | null;
  time_confirmed: boolean | null;
  status: "open" | "submitted" | "approved";
  created_at: string;
  clock_in_lat?: number | null;
  clock_in_lng?: number | null;
  clock_out_lat?: number | null;
  clock_out_lng?: number | null;
  projects?: { job_code: string; name: string } | null;
  cost_codes?: { code: string; label: string } | null;
  profiles?: { display_name: string } | null;
}

/** A job the user recently clocked into, for the "recent" quick-pick chips. */
export interface RecentJob {
  projectId: string;
  jobCode: string;
  name: string;
  costCodeId: string | null;
  lastClockInAt: string;
}

const SHIFT_SELECT =
  "*, projects(job_code, name), cost_codes(code, label), profiles(display_name)";

export async function listCostCodes(): Promise<CostCode[]> {
  const { data, error } = await supabase
    .from("cost_codes")
    .select("*")
    .eq("active", true)
    .order("sort_order")
    .order("code");
  if (error) throw error;
  return (data ?? []) as CostCode[];
}

export async function getOpenShift(profileId: string): Promise<TimeShift | null> {
  const { data, error } = await supabase
    .from("time_shifts")
    .select(SHIFT_SELECT)
    .eq("profile_id", profileId)
    .eq("status", "open")
    .is("clock_out_at", null)
    .order("clock_in_at", { ascending: false })
    .maybeSingle();
  if (error) throw error;
  return data as TimeShift | null;
}

export async function listMyShifts(
  profileId: string,
  sinceIso: string,
): Promise<TimeShift[]> {
  const { data, error } = await supabase
    .from("time_shifts")
    .select(SHIFT_SELECT)
    .eq("profile_id", profileId)
    .gte("clock_in_at", sinceIso)
    .order("clock_in_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as TimeShift[];
}

export async function listShiftsToApprove(): Promise<TimeShift[]> {
  const { data, error } = await supabase
    .from("time_shifts")
    .select(SHIFT_SELECT)
    .eq("status", "submitted")
    .order("clock_in_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as TimeShift[];
}

export async function clockIn(
  projectId: string | null,
  costCodeId: string | null,
  geo?: GeoFix,
): Promise<TimeShift> {
  const { data, error } = await supabase.rpc("clock_in", {
    p_project_id: projectId,
    p_cost_code_id: costCodeId,
    p_photo: null,
    p_lat: geo?.lat ?? null,
    p_lng: geo?.lng ?? null,
  });
  if (error) throw error;
  return data as TimeShift;
}

export async function clockOut(
  shiftId: string,
  opts: {
    injured: boolean;
    timeConfirmed: boolean;
    breakSeconds: number;
    geo?: GeoFix;
  },
): Promise<TimeShift> {
  const { data, error } = await supabase.rpc("clock_out", {
    p_shift_id: shiftId,
    p_photo: null,
    p_injured: opts.injured,
    p_time_confirmed: opts.timeConfirmed,
    p_break_seconds: opts.breakSeconds,
    p_lat: opts.geo?.lat ?? null,
    p_lng: opts.geo?.lng ?? null,
  });
  if (error) throw error;
  return data as TimeShift;
}

/**
 * Distinct jobs the user clocked into recently, newest first, for quick-pick
 * chips and the one-tap "resume" button. Carries the last cost code used so
 * resuming restores the full context in one tap.
 */
export async function listRecentJobs(
  profileId: string,
  limit = 5,
): Promise<RecentJob[]> {
  const { data, error } = await supabase
    .from("time_shifts")
    .select("project_id, cost_code_id, clock_in_at, projects(job_code, name)")
    .eq("profile_id", profileId)
    .not("project_id", "is", null)
    .order("clock_in_at", { ascending: false })
    .limit(60);
  if (error) throw error;
  const seen = new Set<string>();
  const out: RecentJob[] = [];
  const rows = (data ?? []) as unknown as Array<{
    project_id: string | null;
    cost_code_id: string | null;
    clock_in_at: string;
    // Supabase types the nested relation as an array; normalize below.
    projects?: { job_code: string; name: string } | { job_code: string; name: string }[] | null;
  }>;
  for (const row of rows) {
    if (!row.project_id || seen.has(row.project_id)) continue;
    seen.add(row.project_id);
    const proj = Array.isArray(row.projects) ? row.projects[0] : row.projects;
    out.push({
      projectId: row.project_id,
      jobCode: proj?.job_code ?? "",
      name: proj?.name ?? "Job",
      costCodeId: row.cost_code_id,
      lastClockInAt: row.clock_in_at,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export async function approveShift(shiftId: string): Promise<void> {
  const { error } = await supabase.rpc("approve_shift", { p_shift_id: shiftId });
  if (error) throw error;
}

/** Server-persisted breaks so a refresh mid-break doesn't lose the timer. */
export async function startBreak(
  shiftId: string,
  breakType: BreakType = "other",
): Promise<TimeShift> {
  const { data, error } = await supabase.rpc("start_break", {
    p_shift_id: shiftId,
    p_break_type: breakType,
  });
  if (error) throw error;
  return data as TimeShift;
}

export async function endBreak(shiftId: string): Promise<TimeShift> {
  const { data, error } = await supabase.rpc("end_break", { p_shift_id: shiftId });
  if (error) throw error;
  return data as TimeShift;
}

/** Effective break seconds including any break currently in progress. */
export function currentBreakSeconds(s: TimeShift, now = Date.now()): number {
  const running = s.break_started_at
    ? Math.max(0, Math.floor((now - new Date(s.break_started_at).getTime()) / 1000))
    : 0;
  return (s.break_seconds ?? 0) + running;
}

/** Live worked seconds for an open shift: wall time minus all break time. */
export function elapsedWorkSeconds(s: TimeShift, now = Date.now()): number {
  const end = s.clock_out_at ? new Date(s.clock_out_at).getTime() : now;
  const gross = Math.max(0, Math.floor((end - new Date(s.clock_in_at).getTime()) / 1000));
  return Math.max(0, gross - currentBreakSeconds(s, now));
}

/** Format seconds as H:MM:SS for the live timer. */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${h}:${pad(m)}:${pad(sec)}`;
}

export function shiftHours(s: TimeShift): number {
  if (!s.clock_out_at) return 0;
  const ms = new Date(s.clock_out_at).getTime() - new Date(s.clock_in_at).getTime();
  return Math.max(0, ms / 3600000 - s.break_seconds / 3600);
}

export function startOfWeekIso(): string {
  const d = new Date();
  const day = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
