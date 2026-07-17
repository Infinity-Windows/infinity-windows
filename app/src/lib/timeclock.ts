import { supabase } from "./supabase";

export interface CostCode {
  id: string;
  code: string;
  label: string;
  active: boolean;
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
  injured: boolean | null;
  time_confirmed: boolean | null;
  status: "open" | "submitted" | "approved";
  created_at: string;
  projects?: { job_code: string; name: string } | null;
  cost_codes?: { code: string; label: string } | null;
  profiles?: { display_name: string } | null;
}

const SHIFT_SELECT =
  "*, projects(job_code, name), cost_codes(code, label), profiles(display_name)";

export async function listCostCodes(): Promise<CostCode[]> {
  const { data, error } = await supabase
    .from("cost_codes")
    .select("*")
    .eq("active", true)
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
): Promise<TimeShift> {
  const { data, error } = await supabase.rpc("clock_in", {
    p_project_id: projectId,
    p_cost_code_id: costCodeId,
    p_photo: null,
  });
  if (error) throw error;
  return data as TimeShift;
}

export async function clockOut(
  shiftId: string,
  opts: { injured: boolean; timeConfirmed: boolean; breakSeconds: number },
): Promise<TimeShift> {
  const { data, error } = await supabase.rpc("clock_out", {
    p_shift_id: shiftId,
    p_photo: null,
    p_injured: opts.injured,
    p_time_confirmed: opts.timeConfirmed,
    p_break_seconds: opts.breakSeconds,
  });
  if (error) throw error;
  return data as TimeShift;
}

export async function approveShift(shiftId: string): Promise<void> {
  const { error } = await supabase.rpc("approve_shift", { p_shift_id: shiftId });
  if (error) throw error;
}

/** Server-persisted breaks so a refresh mid-break doesn't lose the timer. */
export async function startBreak(shiftId: string): Promise<TimeShift> {
  const { data, error } = await supabase.rpc("start_break", { p_shift_id: shiftId });
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
