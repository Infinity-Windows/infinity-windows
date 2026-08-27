import { supabase } from "./supabase";
import type { GeoFix } from "./geo";
import { sendPush } from "./permissions/pushServer";
import { isMissingClockInOverload, normalizeNote } from "./timeclockNote";

export { isMissingClockInOverload, normalizeNote } from "./timeclockNote";

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
  /**
   * `needs_finish` is a shift the server refused to guess an end for: it ran
   * past the believable maximum, so it carries no `clock_out_at` and no hours
   * until a person supplies the real finish time. See lib/shiftGuard.ts.
   */
  status: "open" | "submitted" | "approved" | "rejected" | "needs_finish" | "voided";
  created_at: string;
  /** Optional free-text note the worker adds at clock-in, for the office. */
  note?: string | null;
  /** "What happened?" when the injured box was ticked at clock-out. */
  injury_note?: string | null;
  clock_in_lat?: number | null;
  clock_in_lng?: number | null;
  clock_out_lat?: number | null;
  clock_out_lng?: number | null;
  approved_by?: string | null;
  approved_at?: string | null;
  edited_by?: string | null;
  edited_at?: string | null;
  edited_note?: string | null;
  rejected_by?: string | null;
  rejected_at?: string | null;
  reject_reason?: string | null;
  /**
   * Void (Wave T3): its own columns, deliberately separate from the
   * edited_by/edited_at/edited_note trio above — a voided-and-later-edited
   * (or edited-and-later-voided) punch must never leave only one note field
   * to say which reason belongs to which action.
   */
  voided_at?: string | null;
  voided_by?: string | null;
  voided_reason?: string | null;
  projects?: { job_code: string; name: string } | null;
  cost_codes?: { code: string; label: string } | null;
  profiles?: { display_name: string } | null;
  /** Who last edited this punch (Wave T2) — "edited by <name>" on the row. */
  editor?: { display_name: string } | null;
  /** Who voided this punch (Wave T3) — "voided by <name>" on the row. */
  voider?: { display_name: string } | null;
}

/** A crew member's rolled-up week, for the team roster on the timecard page. */
export interface TeamWeekSummary {
  profileId: string;
  displayName: string;
  hours: number;
  shiftCount: number;
  submittedCount: number;
  approvedCount: number;
  rejectedCount: number;
  openCount: number;
}

/** A job the user recently clocked into, for the "recent" quick-pick chips. */
export interface RecentJob {
  projectId: string;
  jobCode: string;
  name: string;
  costCodeId: string | null;
  lastClockInAt: string;
}

// `profiles` is named explicitly via the `profile_id` column because a shift
// points at four different people — whose shift it is, plus who approved,
// edited and rejected it. Asking for a bare `profiles(...)` is ambiguous, and
// PostgREST answers a 300 rather than guessing, which took the clock and the
// whole timecard down until the hint was added. `editor` (via `edited_by`)
// and `voider` (via `voided_by`) are the second and third of those four to
// get their own joins, for the row-level "edited by <name>" (T2) and
// "voided by <name>" (T3) lines.
const SHIFT_SELECT =
  "*, projects(job_code, name), cost_codes(code, label), profiles!profile_id(display_name), editor:profiles!edited_by(display_name), voider:profiles!voided_by(display_name)";

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

/**
 * The shift the clock sheet is about: the one running now, or one the app
 * stopped counting and still needs a finish time for.
 *
 * `needs_finish` is included deliberately. It is not "on the clock" — see
 * `isOnTheClock` — but it is unresolved, and the person it belongs to is the
 * one who knows when they actually stopped. Leaving it out of this query would
 * hide the question from the only person who can answer it.
 */
export async function getOpenShift(profileId: string): Promise<TimeShift | null> {
  const { data, error } = await supabase
    .from("time_shifts")
    .select(SHIFT_SELECT)
    .eq("profile_id", profileId)
    .in("status", ["open", "needs_finish"])
    .is("clock_out_at", null)
    .order("clock_in_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as TimeShift | null;
}

/**
 * Genuinely on the clock right now — which gates starting install work and the
 * toolbox nag. A shift awaiting a finish time is the opposite of this: it means
 * the person went home, so it must not let anyone start a window.
 */
export function isOnTheClock(shift: TimeShift | null | undefined): boolean {
  return shift != null && shift.status === "open";
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
    .neq("status", "voided")
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

/**
 * Every crew member's shifts within a date window, newest first. Foreman+ only
 * surface (installers never see this in the UI). Powers the team roster, the
 * per-person timecard drill-down, and the weekly payroll export.
 */
export async function listTeamShifts(
  sinceIso: string,
  untilIso: string,
): Promise<TimeShift[]> {
  const { data, error } = await supabase
    .from("time_shifts")
    .select(SHIFT_SELECT)
    .gte("clock_in_at", sinceIso)
    .lt("clock_in_at", untilIso)
    .neq("status", "voided")
    .order("clock_in_at", { ascending: false })
    .limit(1000);
  if (error) throw error;
  return (data ?? []) as TimeShift[];
}

/**
 * Every shift still without a finish time, for anybody, ignoring the week
 * window on purpose.
 *
 * The week filter is why the 286-hour shift went unseen for twelve days: the
 * timecard screen asks for `clock_in_at` inside the selected week, so a shift
 * punched on 18 July is absent from every week after it — running, unbilled
 * and invisible. A runaway shift has to be visible from whichever week the
 * office happens to be looking at.
 */
export async function listUnfinishedShifts(): Promise<TimeShift[]> {
  const { data, error } = await supabase
    .from("time_shifts")
    .select(SHIFT_SELECT)
    .is("clock_out_at", null)
    .in("status", ["open", "needs_finish"])
    .order("clock_in_at", { ascending: true })
    .limit(200);
  if (error) throw error;
  return (data ?? []) as TimeShift[];
}

/** My own shifts still without a finish time — usually none, sometimes one. */
export async function listMyUnfinishedShifts(profileId: string): Promise<TimeShift[]> {
  const { data, error } = await supabase
    .from("time_shifts")
    .select(SHIFT_SELECT)
    .eq("profile_id", profileId)
    .is("clock_out_at", null)
    .in("status", ["open", "needs_finish"])
    .order("clock_in_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as TimeShift[];
}

/** One person's shifts in a window (self view + lead drill-down). */
export async function listShiftsForProfile(
  profileId: string,
  sinceIso: string,
  untilIso: string,
  /** Managers can ask for voided punches too ("Show removed entries"). */
  includeVoided = false,
): Promise<TimeShift[]> {
  let q = supabase
    .from("time_shifts")
    .select(SHIFT_SELECT)
    .eq("profile_id", profileId)
    .gte("clock_in_at", sinceIso)
    .lt("clock_in_at", untilIso);
  if (!includeVoided) q = q.neq("status", "voided");
  const { data, error } = await q.order("clock_in_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as TimeShift[];
}

/** Roll a flat list of team shifts up into per-person week summaries. */
export function summarizeTeamWeek(shifts: TimeShift[]): TeamWeekSummary[] {
  const byPerson = new Map<string, TeamWeekSummary>();
  for (const s of shifts) {
    let row = byPerson.get(s.profile_id);
    if (!row) {
      row = {
        profileId: s.profile_id,
        displayName: s.profiles?.display_name ?? "Crew",
        hours: 0,
        shiftCount: 0,
        submittedCount: 0,
        approvedCount: 0,
        rejectedCount: 0,
        openCount: 0,
      };
      byPerson.set(s.profile_id, row);
    }
    row.hours += shiftHours(s);
    row.shiftCount += 1;
    if (s.status === "submitted") row.submittedCount += 1;
    else if (s.status === "approved") row.approvedCount += 1;
    else if (s.status === "rejected") row.rejectedCount += 1;
    else if (s.status === "open") row.openCount += 1;
  }
  return [...byPerson.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }),
  );
}

export async function rejectShift(
  shiftId: string,
  reason?: string,
): Promise<void> {
  const { data, error } = await supabase.rpc("reject_shift", {
    p_shift_id: shiftId,
    p_reason: reason ?? null,
  });
  if (error) throw error;
  // Web-push seam: tell the crew member their timecard was sent back, so it
  // reaches them even with the app closed. Same {title,body,tag,url} shape as
  // the local path. Fire-and-forget — never blocks the reject.
  const ownerId = (data as { profile_id?: string } | null)?.profile_id;
  if (ownerId) {
    void sendPush({
      profileIds: [ownerId],
      title: "Timecard needs changes",
      body: reason?.trim() ? reason.trim() : "A supervisor sent your timecard back.",
      tag: `timecard-rejected-${shiftId}`,
      url: "/clock",
    });
  }
}

export interface LeadShiftInput {
  profileId: string;
  projectId: string | null;
  costCodeId: string | null;
  clockInAt: string;
  clockOutAt: string | null;
  breakSeconds: number;
  note?: string | null;
}

/** Lead creates a punch for a crew member (fixing a missed clock-in/out). */
export async function leadAddShift(input: LeadShiftInput): Promise<TimeShift> {
  const { data, error } = await supabase.rpc("lead_add_shift", {
    p_profile_id: input.profileId,
    p_project_id: input.projectId,
    p_cost_code_id: input.costCodeId,
    p_clock_in_at: input.clockInAt,
    p_clock_out_at: input.clockOutAt,
    p_break_seconds: input.breakSeconds,
    p_note: input.note ?? null,
  });
  if (error) throw error;
  return data as TimeShift;
}

export interface LeadShiftPatch {
  projectId?: string | null;
  costCodeId?: string | null;
  clockInAt?: string | null;
  clockOutAt?: string | null;
  breakSeconds?: number | null;
  note?: string | null;
}

/**
 * Supervisor+ adjusts an existing punch (Q3: edit narrowed from foreman+ to
 * supervisor+). Only the provided fields change. Editing an approved shift
 * resets the approval, and re-approves it in the same save when the editor
 * could have approved it themselves (Q4) — both server-enforced by
 * `edit_shift`, not this wrapper.
 */
export async function editShift(
  shiftId: string,
  patch: LeadShiftPatch,
): Promise<TimeShift> {
  const { data, error } = await supabase.rpc("edit_shift", {
    p_shift_id: shiftId,
    p_project_id: patch.projectId ?? null,
    p_cost_code_id: patch.costCodeId ?? null,
    p_clock_in_at: patch.clockInAt ?? null,
    p_clock_out_at: patch.clockOutAt ?? null,
    p_break_seconds: patch.breakSeconds ?? null,
    p_note: patch.note ?? null,
  });
  if (error) throw error;
  return data as TimeShift;
}

/**
 * Supervisor+ takes an approval back — reason required, hours untouched.
 * The punch returns to 'submitted' for normal re-approval.
 */
export async function unapproveShift(
  shiftId: string,
  note: string,
): Promise<TimeShift> {
  const { data, error } = await supabase.rpc("lead_unapprove_shift", {
    p_shift_id: shiftId,
    p_note: note,
  });
  if (error) throw error;
  return data as TimeShift;
}

/**
 * Supervisor+ deletes a punch (Q3: void narrowed from foreman+, same as
 * edit). Server-side this VOIDS, never erases: the shift drops out of every
 * list and total (status 'voided'), while the row, its own voided_at/by/
 * reason columns, and a permanent time_shift_edits entry stay behind — see
 * migration 20260944000000.
 */
export async function voidShift(
  shiftId: string,
  reason: string,
): Promise<TimeShift> {
  const { data, error } = await supabase.rpc("void_shift", {
    p_shift_id: shiftId,
    p_reason: reason,
  });
  if (error) throw error;
  return data as TimeShift;
}

/**
 * Undo for `voidShift` (Wave T3) — the five-second toast's inverse, and
 * what the "Show removed" list's Restore button calls too. Never resurrects
 * the old approval (see the migration's comment): a closed shift comes back
 * 'submitted', an open one comes back 'open'.
 */
export async function restoreShift(shiftId: string): Promise<TimeShift> {
  const { data, error } = await supabase.rpc("restore_shift", {
    p_shift_id: shiftId,
  });
  if (error) throw error;
  return data as TimeShift;
}

/**
 * One changed field of one edit — the append-only trail behind the quick
 * "adjusted" badge. Written only by the lead_edit_shift RPC (which requires
 * the reason); readable by supervisor+ via RLS, so a foreman's own edits are
 * still reviewed by someone above them.
 */
export interface ShiftEdit {
  id: string;
  shift_id: string;
  edited_by: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  reason: string;
  created_at: string;
  editor?: { display_name: string } | null;
}

/**
 * "This table isn't migrated in yet" wears two uniforms: Postgres says 42P01,
 * but PostgREST answers from its schema cache with PGRST205 ("Could not find
 * the table"). Both mean the same honest thing here: no data yet, not a fault.
 * (The general version of this lives in schemaErrors.ts on the tier1 branch;
 * fold this into it when that merges.)
 */
function isMissingTableError(e: { code?: string; message?: string } | null): boolean {
  if (!e) return false;
  if (e.code === "42P01" || e.code === "PGRST205") return true;
  return /could not find the table|relation .+ does not exist/i.test(e.message ?? "");
}

export async function listShiftEdits(shiftId: string): Promise<ShiftEdit[]> {
  const { data, error } = await supabase
    .from("time_shift_edits")
    .select(
      "id, shift_id, edited_by, field, old_value, new_value, reason, created_at, editor:edited_by(display_name)",
    )
    .eq("shift_id", shiftId)
    .order("created_at", { ascending: true });
  // The audit table hasn't been migrated in yet: an empty history is the
  // truthful answer, not an error screen.
  if (isMissingTableError(error)) return [];
  if (error) throw error;
  return (data ?? []) as unknown as ShiftEdit[];
}

/** overtime_rules row: one company default plus per-person overrides. */
export interface OvertimeRuleRow {
  id: string;
  scope: "company" | "person";
  profile_id: string | null;
  weekly_threshold_hours: number | null;
  weekly_ot_multiplier: number;
  daily_threshold_hours: number | null;
  daily_ot_multiplier: number;
  double_time_threshold_hours: number | null;
  double_time_multiplier: number;
}

export async function listOvertimeRules(): Promise<OvertimeRuleRow[]> {
  const { data, error } = await supabase
    .from("overtime_rules")
    .select(
      "id, scope, profile_id, weekly_threshold_hours, weekly_ot_multiplier, daily_threshold_hours, daily_ot_multiplier, double_time_threshold_hours, double_time_multiplier",
    );
  // Rules table not migrated yet — no rules means no OT math, which is
  // exactly what the timecard showed before this feature.
  if (isMissingTableError(error)) return [];
  if (error) throw error;
  return (data ?? []) as OvertimeRuleRow[];
}

export async function clockIn(
  projectId: string | null,
  costCodeId: string | null,
  geo?: GeoFix,
  note?: string | null,
): Promise<TimeShift> {
  const base = {
    p_project_id: projectId,
    p_cost_code_id: costCodeId,
    p_photo: null,
    p_lat: geo?.lat ?? null,
    p_lng: geo?.lng ?? null,
  };
  // Preferred path: persist the worker note (migration 20260723060000).
  let res = await supabase.rpc("clock_in", { ...base, p_note: normalizeNote(note) });
  if (res.error && isMissingClockInOverload(res.error)) {
    // Migration not applied yet — punch in without the note so clock-in works.
    res = await supabase.rpc("clock_in", base);
  }
  if (res.error) throw res.error;
  return res.data as TimeShift;
}

export async function clockOut(
  shiftId: string,
  opts: {
    injured: boolean;
    injuryNote?: string | null;
    timeConfirmed: boolean;
    breakSeconds: number;
    geo?: GeoFix;
  },
): Promise<TimeShift> {
  const { data, error } = await supabase.rpc("clock_out", {
    p_shift_id: shiftId,
    p_photo: null,
    p_injured: opts.injured,
    p_injury_note: opts.injured ? (opts.injuryNote?.trim() || null) : null,
    p_time_confirmed: opts.timeConfirmed,
    p_break_seconds: opts.breakSeconds,
    p_lat: opts.geo?.lat ?? null,
    p_lng: opts.geo?.lng ?? null,
  });
  if (error) throw error;
  return data as TimeShift;
}

/**
 * Close a shift at a finish time a person actually typed.
 *
 * Deliberately separate from `clockOut`, and deliberately without a fallback
 * to the note-less style used elsewhere: if the server does not understand
 * `p_clock_out_at` this must fail loudly, because the only "graceful" thing it
 * could fall back to is stamping `now()` — which is precisely the invented
 * number this whole path exists to prevent.
 */
export async function finishShiftAt(
  shiftId: string,
  finishAtIso: string,
  opts: { injured: boolean; breakSeconds: number },
): Promise<TimeShift> {
  const { data, error } = await supabase.rpc("finish_shift_at", {
    p_shift_id: shiftId,
    p_clock_out_at: finishAtIso,
    p_injured: opts.injured,
    p_break_seconds: opts.breakSeconds,
  });
  if (error) throw error;
  return data as TimeShift;
}

/**
 * Write a runaway shift off to zero hours, because no work was done on it.
 *
 * The other true answer to "when did you finish", and the one `finishShiftAt`
 * cannot express: sometimes the punch was a mistake and there is nothing to
 * pay. The row is kept — closed at its own clock-in moment so it measures zero
 * — with a reason and the name of whoever decided it. Lead-level only.
 */
export async function closeShiftAsNoWork(
  shiftId: string,
  reason?: string | null,
): Promise<TimeShift> {
  const { data, error } = await supabase.rpc("close_shift_as_no_work", {
    p_shift_id: shiftId,
    p_reason: reason?.trim() ? reason.trim() : null,
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
  const { data, error } = await supabase.rpc("approve_shift", { p_shift_id: shiftId });
  if (error) throw error;
  // Web-push seam: let the crew member know their hours were approved (arrives
  // even when the app is closed). Fire-and-forget — never blocks the approval.
  const ownerId = (data as { profile_id?: string } | null)?.profile_id;
  if (ownerId) {
    void sendPush({
      profileIds: [ownerId],
      title: "Timecard approved",
      body: "Your submitted hours were approved.",
      tag: `timecard-approved-${shiftId}`,
      url: "/clock",
    });
  }
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
  return weekRange().startIso;
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/** Monday-anchored week window (start inclusive, end exclusive) + a label. */
export interface WeekRange {
  start: Date;
  end: Date;
  startIso: string;
  endIso: string;
  label: string;
}

export function weekRange(anchor: Date = new Date()): WeekRange {
  const start = new Date(anchor);
  const day = (start.getDay() + 6) % 7; // Monday = 0
  start.setDate(start.getDate() - day);
  start.setHours(0, 0, 0, 0);
  const end = addDays(start, 7);
  const lastDay = addDays(start, 6);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  const label = `${start.toLocaleDateString(undefined, opts)} – ${lastDay.toLocaleDateString(undefined, opts)}`;
  return {
    start,
    end,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    label,
  };
}

export type TimecardRangeMode = "day" | "week" | "pay";

/**
 * Pay periods are two Monday-start weeks on a fixed grid (epoch: Mon
 * 2026-01-05), so every phone lands on the same boundaries with nothing
 * stored. Day/week are the plain single spans.
 */
const PAY_PERIOD_EPOCH = new Date(2026, 0, 5); // Mon Jan 5 2026, local

export function timecardRange(mode: TimecardRangeMode, anchor: Date): WeekRange {
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (mode === "day") {
    const start = new Date(anchor);
    start.setHours(0, 0, 0, 0);
    const end = addDays(start, 1);
    const label = start.toLocaleDateString(undefined, {
      weekday: "long",
      ...opts,
    });
    return { start, end, startIso: start.toISOString(), endIso: end.toISOString(), label };
  }
  if (mode === "pay") {
    const wk = weekRange(anchor);
    const weekIndex = Math.round(
      (wk.start.getTime() - PAY_PERIOD_EPOCH.getTime()) / (7 * 86_400_000),
    );
    const start = addDays(wk.start, weekIndex % 2 === 0 ? 0 : -7);
    const end = addDays(start, 14);
    const lastDay = addDays(start, 13);
    const label = `Pay period ${start.toLocaleDateString(undefined, opts)} – ${lastDay.toLocaleDateString(undefined, opts)}`;
    return { start, end, startIso: start.toISOString(), endIso: end.toISOString(), label };
  }
  return weekRange(anchor);
}

/** Days a timecard range covers, as local punch-day keys (YYYY-MM-DD). */
export function rangeDays(range: WeekRange): string[] {
  const out: string[] = [];
  for (let d = new Date(range.start); d < range.end; d = addDays(d, 1)) {
    out.push(punchDay(d.toISOString()));
  }
  return out;
}

/** Local calendar day (YYYY-MM-DD) a punch belongs to, for day grouping. */
export function punchDay(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
