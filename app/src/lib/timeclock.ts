import { supabase } from "./supabase";
import type { GeoFix } from "./geo";
import type { JobMode } from "./types";
import { sendPush } from "./permissions/pushServer";
import { isMissingFunction, isMissingTable } from "./schemaErrors";
import { TRAVEL_COST_CODE } from "./farFromJob";
import { isMissingClockInOverload, normalizeNote } from "./timeclockNote";
import type { TimecardExportShift } from "./timecardExport";

export { isMissingClockInOverload, normalizeNote } from "./timeclockNote";

export interface CostCode {
  id: string;
  code: string;
  label: string;
  description?: string | null;
  active: boolean;
  sort_order?: number;
  /**
   * The one general / catch-all code the clock-in picker always folds in as a
   * fallback (standard-tracking-jobs slice 3, 20260973000000). Optional so a
   * database that predates the column reads as "not general".
   */
  is_general?: boolean;
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
  /**
   * The work mode picked at clock-in on a both-mode job (20260970000000).
   * Null on a single-mode job, and on every punch made before that migration.
   */
  job_mode?: JobMode | null;
  /**
   * Wave K, K3: when the app was last brought to the FOREGROUND while this
   * shift was open, and where the phone was if it had already granted
   * location. One point, overwritten each time — this app has no background
   * location and must never grow one.
   */
  last_seen_at?: string | null;
  last_seen_lat?: number | null;
  last_seen_lng?: number | null;
  /**
   * How precise that fix claimed to be, in metres. Stored beside the point so
   * a reader can apply the same "too fuzzy to tell near from far" guard the
   * prompt applies live — a point without its uncertainty would let the
   * supervisor line state a distance the app itself would not act on.
   */
  last_seen_accuracy_m?: number | null;
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
  /**
   * Set only when `clock_in` auto-closed THIS shift because a new one
   * started before it was closed out (Wave T4) — null for a shift the
   * person (or a supervisor) actually closed.
   */
  closed_reason?: string | null;
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

/**
 * The Travel code itself (Wave K, K1). Read from the GLOBAL library rather than
 * the job's pickable subset on purpose: a job that narrowed its subset to
 * install codes must still be switchable to Travel — driving away from a job is
 * something a person can always do, whatever that job's paperwork says.
 * Returns null if a company ever deletes or deactivates it; the caller then
 * simply never offers the switch.
 */
export async function getTravelCostCode(): Promise<CostCode | null> {
  const { data, error } = await supabase
    .from("cost_codes")
    .select("id, code, label, active")
    .eq("code", TRAVEL_COST_CODE)
    .eq("active", true)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as CostCode | null) ?? null;
}

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

/** How many shift rows to ask for at a time; the server may hand back fewer. */
const TEAM_SHIFT_PAGE = 1000;
/**
 * Purely a runaway-loop stop. A server that answered every page full forever
 * would spin this function; 50 pages is far past any real pay period (Forge's
 * whole crew punching every few minutes for two weeks does not reach 50,000
 * rows), so hitting it means something is wrong, not that a company got busy.
 */
const TEAM_SHIFT_MAX_PAGES = 50;

/**
 * Every crew member's shifts within a date window, newest first. Foreman+ only
 * surface (installers never see this in the UI). Powers the team roster, the
 * per-person timecard drill-down, and the payroll exports.
 *
 * PAGED, not capped. This used to ask for one page of 1000 and stop, which was
 * survivable while the screen showed one week and the export carried no
 * overtime. It stopped being survivable when the same array became the Gusto
 * file the office uploads to payroll over a fourteen-day period: every
 * cost-code switch is a close-then-open, so a crew switching codes a few times
 * a day reaches a thousand punches inside a pay period — and because the order
 * is newest-first, the rows a cap drops are the OLDEST ones, silently shorting
 * the first of the two weeks. Nobody would have seen it in the file.
 *
 * `id` is the tiebreaker on the sort so paging is deterministic: two punches
 * clocked in the same second must not be able to swap places between pages and
 * lose one.
 *
 * The stop condition is the EXACT COUNT, asked for once with the first page,
 * rather than "a page came back shorter than we asked for". PostgREST has its
 * own max-rows ceiling, so a short page can mean either the end or the server
 * declining to go further — and reading a server ceiling as "that's all of
 * them" is precisely the shape of the bug this replaces. A count leaves no room
 * for that reading. If a database ever answers without one, the short-page rule
 * is the fallback.
 */
export async function listTeamShifts(
  sinceIso: string,
  untilIso: string,
): Promise<TimeShift[]> {
  const out: TimeShift[] = [];
  let total: number | null = null;
  for (let page = 0; page < TEAM_SHIFT_MAX_PAGES; page++) {
    const from = out.length;
    const { data, error, count } = await supabase
      .from("time_shifts")
      .select(SHIFT_SELECT, page === 0 ? { count: "exact" } : undefined)
      .gte("clock_in_at", sinceIso)
      .lt("clock_in_at", untilIso)
      .neq("status", "voided")
      .order("clock_in_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + TEAM_SHIFT_PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as TimeShift[];
    out.push(...rows);
    if (rows.length === 0) break;
    if (total === null && typeof count === "number") total = count;
    if (total !== null ? out.length >= total : rows.length < TEAM_SHIFT_PAGE) {
      break;
    }
  }
  return out;
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

// ---------------------------------------------------------------------------
// Per-job / per-cost-code time report (standard-tracking-jobs slice 3) — the
// billing basis for service work. The pay-period rollup already sums a person's
// hours; this cuts the SAME shifts the other way, by job AND by the cost code
// charged, so an owner can see "8h Service call + 2h Warranty on this job" and
// bill from it. Pure: it takes an already-fetched TimeShift[] and returns the
// breakdown, so it is tested with fixtures rather than through a network read.
// ---------------------------------------------------------------------------

/** One cost code's hours within one job. */
export interface CostCodeHours {
  /** cost_code_id, or "none" for a shift with no code. */
  costCodeKey: string;
  code: string;
  label: string;
  hours: number;
  shiftCount: number;
}

/** One job's hours, split by cost code. */
export interface JobCostCodeHours {
  /** project_id, or "unassigned" for a shift with no job. */
  jobKey: string;
  jobCode: string;
  jobName: string;
  hours: number;
  shiftCount: number;
  costCodes: CostCodeHours[];
}

export interface JobCostCodeReport {
  jobs: JobCostCodeHours[];
  totalHours: number;
  shiftCount: number;
}

/**
 * Roll a flat list of shifts up by job, then by cost code, summing worked
 * hours. Open (unfinished) shifts contribute zero hours — the same
 * `shiftHours` rule the payroll rollup uses — so a runaway punch never inflates
 * a bill. Jobs and codes are ordered by hours descending, then by code, so the
 * costliest work reads first.
 */
export function summarizeByJobCostCode(shifts: TimeShift[]): JobCostCodeReport {
  const byJob = new Map<string, JobCostCodeHours>();
  const codeMaps = new Map<string, Map<string, CostCodeHours>>();
  let totalHours = 0;

  for (const s of shifts) {
    const jobKey = s.project_id ?? "unassigned";
    let job = byJob.get(jobKey);
    if (!job) {
      job = {
        jobKey,
        jobCode: s.projects?.job_code ?? (s.project_id ? "—" : "No job"),
        jobName: s.projects?.name ?? "",
        hours: 0,
        shiftCount: 0,
        costCodes: [],
      };
      byJob.set(jobKey, job);
      codeMaps.set(jobKey, new Map());
    }

    const codeKey = s.cost_code_id ?? "none";
    const codes = codeMaps.get(jobKey)!;
    let code = codes.get(codeKey);
    if (!code) {
      code = {
        costCodeKey: codeKey,
        code: s.cost_codes?.code ?? (s.cost_code_id ? "—" : "No code"),
        label: s.cost_codes?.label ?? "",
        hours: 0,
        shiftCount: 0,
      };
      codes.set(codeKey, code);
    }

    const h = shiftHours(s);
    job.hours += h;
    job.shiftCount += 1;
    code.hours += h;
    code.shiftCount += 1;
    totalHours += h;
  }

  const jobs = [...byJob.values()].map((job) => ({
    ...job,
    costCodes: [...codeMaps.get(job.jobKey)!.values()].sort(
      (a, b) => b.hours - a.hours || a.code.localeCompare(b.code),
    ),
  }));
  jobs.sort((a, b) => b.hours - a.hours || a.jobCode.localeCompare(b.jobCode));

  return { jobs, totalHours, shiftCount: shifts.length };
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

/**
 * Edits somebody ELSE made to MY punches, newest first (Wave K, K4).
 *
 * The durable half of "your timecard was changed": a push can be swiped away
 * or arrive on a phone that is off, so the same fact also becomes a line in the
 * notifications feed that stays until the person clears it.
 *
 * `edited_by <> me` on purpose — my own corrections are not news to me. Reads
 * as the worker, which the "own shift read" policy added by 20260976000000
 * allows; before that migration this table was supervisor-read-only, so on a
 * database without it the query simply comes back empty and the feed line
 * never appears.
 */
export async function listMyTimecardEdits(
  profileId: string,
  sinceIso: string,
): Promise<ShiftEdit[]> {
  const { data, error } = await supabase
    .from("time_shift_edits")
    .select(
      "id, shift_id, edited_by, field, old_value, new_value, reason, created_at, editor:edited_by(display_name), shift:time_shifts!inner(profile_id)",
    )
    .eq("shift.profile_id", profileId)
    .neq("edited_by", profileId)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(100);
  if (isMissingTableError(error)) return [];
  // A database where the worker cannot read this table yet answers with an
  // empty list rather than an error — the feed line is a courtesy, and a
  // permission gap must never blank the whole notifications page.
  if (error) return [];
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
  // The work mode the worker picked when the job allows BOTH data and tracking
  // (standard-tracking-jobs slice 2). null on a single-mode job — the common
  // case — and the punch takes the exact same path it always has.
  mode?: JobMode | null,
): Promise<TimeShift> {
  const base = {
    p_project_id: projectId,
    p_cost_code_id: costCodeId,
    p_photo: null,
    p_lat: geo?.lat ?? null,
    p_lng: geo?.lng ?? null,
  };
  const cleanMode = mode === "data" || mode === "tracking" ? mode : null;

  if (cleanMode) {
    // Mode-carrying path (migration 20260970000000): note + mode. Fall back the
    // same way the note path does if a database hasn't applied the migration —
    // to note-only, then to a bare punch — so clock-in never breaks over it.
    let res = await supabase.rpc("clock_in", {
      ...base,
      p_note: normalizeNote(note),
      p_mode: cleanMode,
    });
    if (res.error && isMissingClockInOverload(res.error)) {
      res = await supabase.rpc("clock_in", { ...base, p_note: normalizeNote(note) });
      if (res.error && isMissingClockInOverload(res.error)) {
        res = await supabase.rpc("clock_in", base);
      }
    }
    if (res.error) throw res.error;
    return res.data as TimeShift;
  }

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

/**
 * Where this job's clock-ins have actually happened: the coordinates of the
 * most recent shift on the project that carried a GPS fix, or null if none has.
 *
 * Projects hold a text address and no coordinates, so this is the honest
 * reference point for "are you near this job" — it degrades to null (no note)
 * the first time anyone clocks into a brand-new job. Reads across the crew,
 * which the time_shifts read policy allows for any signed-in non-partner.
 */
export async function getJobLastGeo(
  projectId: string,
): Promise<{ lat: number; lng: number } | null> {
  const { data, error } = await supabase
    .from("time_shifts")
    .select("clock_in_lat, clock_in_lng")
    .eq("project_id", projectId)
    .not("clock_in_lat", "is", null)
    .not("clock_in_lng", "is", null)
    .order("clock_in_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const row = data as { clock_in_lat: number | null; clock_in_lng: number | null } | null;
  if (!row || row.clock_in_lat == null || row.clock_in_lng == null) return null;
  return { lat: row.clock_in_lat, lng: row.clock_in_lng };
}

/**
 * Stamp my own open shift with "the app was open, here, just now" (Wave K, K3).
 *
 * Called ONLY when the app comes to the foreground, and only while on the
 * clock — there is no background location in this app and there must not be
 * (see the migration's own header). Coordinates are optional: a foreground
 * visit with location switched off still records the TIME, which is the half
 * of "last seen" a supervisor mostly cares about.
 *
 * The fix's accuracy radius travels with the coordinates. Without it the point
 * would be read back later as if it were exact, and the supervisor's "last
 * seen N mi" line would confidently state a distance derived from a fix the
 * app itself was too unsure of to ask a question about.
 *
 * Never throws at the caller. This runs on every app open and it is a courtesy,
 * not a duty: a database that has not applied the migration yet, or a phone
 * with no signal, simply records nothing.
 */
export async function touchShiftLocation(
  lat?: number | null,
  lng?: number | null,
  accuracyM?: number | null,
): Promise<void> {
  try {
    const { error } = await supabase.rpc("touch_shift_location", {
      p_lat: lat ?? null,
      p_lng: lng ?? null,
      p_accuracy_m: accuracyM ?? null,
    });
    if (error && !isMissingFunction(error)) {
      // Still swallowed — logged nowhere on purpose, because there is no
      // screen this could usefully interrupt.
      return;
    }
  } catch {
    /* offline, or the RPC isn't there yet: nothing to say to anybody */
  }
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

/**
 * Wave T7: the one place a TimeShift[] becomes export rows. CSV, TSV/copy-
 * for-Sheets, and the print/PDF view all trace back to this — previously
 * TeamTimecards.tsx and TimecardPanel.tsx each had their own copy of this
 * exact mapping. Lives here rather than in timecardExport.ts so that module
 * can stay framework-free (no TimeShift/supabase import) per its own header
 * comment. `fallbackName` covers a shift whose `profiles` join hasn't
 * loaded yet.
 */
export function shiftsToExportRows(
  shifts: TimeShift[],
  fallbackName = "Crew",
): TimecardExportShift[] {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return shifts.map((s) => ({
    employee: s.profiles?.display_name ?? fallbackName,
    day: punchDay(s.clock_in_at),
    start: fmt(s.clock_in_at),
    end: s.clock_out_at ? fmt(s.clock_out_at) : "",
    hours: shiftHours(s),
    job: s.projects?.job_code ?? "—",
    costCode: s.cost_codes ? `${s.cost_codes.code} - ${s.cost_codes.label}` : "-",
    status: s.status,
  }));
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

/**
 * The most recently ENDED pay period relative to `anchor` — never the one
 * still running. This is what the worker's "Sign my timecard" card offers:
 * a period that is over has nothing left to add to it, so it is safe to
 * attest to. `sign_my_timecard` also refuses server-side if a client ever
 * sent an in-progress period anyway.
 */
export function previousPayPeriod(anchor: Date = new Date()): WeekRange {
  const current = timecardRange("pay", anchor);
  return timecardRange("pay", addDays(current.start, -1));
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

// ---------------------------------------------------------------------------
// Pay-period sign-off (Wave T8) — layered on top of per-punch approval (Q5):
// the worker signs their own two-Monday-week card once it has ended, a
// supervisor countersigns afterward. `period_start` is always whatever this
// module's own `timecardRange("pay", anchor).startIso` produced — see the
// migration's comment for why the server never re-derives that grid itself.

export interface TimecardPeriod {
  id: string;
  profile_id: string;
  period_start: string;
  employee_signed_at: string | null;
  supervisor_signed_at: string | null;
  supervisor_signed_by: string | null;
  supervisor?: { display_name: string } | null;
}

/** One person's sign-off row for one period, or null if nobody has signed yet. */
export async function getTimecardPeriod(
  profileId: string,
  periodStartIso: string,
): Promise<TimecardPeriod | null> {
  const { data, error } = await supabase
    .from("timecard_periods")
    .select(
      "id, profile_id, period_start, employee_signed_at, supervisor_signed_at, supervisor_signed_by, supervisor:profiles!supervisor_signed_by(display_name)",
    )
    .eq("profile_id", profileId)
    .eq("period_start", periodStartIso)
    .maybeSingle();
  // Not migrated in yet — no sign-off is the honest answer, not an error.
  if (isMissingTable(error, "timecard_periods")) return null;
  if (error) throw error;
  return data as unknown as TimecardPeriod | null;
}

/** The worker's own attestation. Self-service — no reason, no lead gate. */
export async function signMyTimecard(periodStartIso: string): Promise<TimecardPeriod> {
  const { data, error } = await supabase.rpc("sign_my_timecard", {
    p_period_start: periodStartIso,
  });
  if (error) throw error;
  return data as TimecardPeriod;
}

/** Supervisor+ countersigns a period the crew member already signed. */
export async function countersignTimecard(
  profileId: string,
  periodStartIso: string,
): Promise<TimecardPeriod> {
  const { data, error } = await supabase.rpc("countersign_timecard", {
    p_profile_id: profileId,
    p_period_start: periodStartIso,
  });
  if (error) throw error;
  return data as TimecardPeriod;
}
