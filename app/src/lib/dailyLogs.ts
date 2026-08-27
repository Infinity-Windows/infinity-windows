// Wave L: the client face of daily_logs. Reads go straight through RLS
// (foreman+ only — Q7, see 20260949000000_daily_logs.sql); every write goes
// through file_daily_log (SECURITY DEFINER) — there is no direct-write path
// to bypass its validation.

import { supabase } from "./supabase";
import { listProjects } from "./api";
import { listTeamShifts, punchDay } from "./timeclock";
import { listProjectRedosAll, listProjectSessions } from "./install/sessions";
import { buildDailyLogDraft, type DailyLogDraft } from "./dailyLogDraft";
import { jobsNeedingLog, localDateISO } from "./dailyLogDay";

export interface DailyLogReflection {
  went_well?: string;
  went_poorly?: string;
  would_have_helped?: string;
  what_worked?: string;
}

export type DayFlow = "smooth" | "fine" | "stuck";

export interface DailyLog {
  id: string;
  project_id: string;
  log_date: string;
  headline: string | null;
  notes: string;
  day_flow: DayFlow | null;
  reflection: DailyLogReflection | null;
  weather: string | null;
  customer_visible: boolean;
  filed_by: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  filer?: { display_name: string | null } | null;
}

// `profiles` named explicitly via `filed_by`: daily_logs points at profiles
// three ways (filed_by, updated_by, customer_visible_by), and a bare
// `profiles(...)` is ambiguous — PostgREST answers a 300 rather than
// guessing (same reason timeclock.ts's SHIFT_SELECT does this).
const LOG_SELECT = "*, filer:profiles!filed_by(display_name)";

function isMissingTableError(e: { code?: string; message?: string } | null): boolean {
  return Boolean(
    e && (e.code === "42P01" || /relation .* does not exist/i.test(e.message ?? "")),
  );
}

/** A job's logs, newest first — the Logs tab's list (L3). Foreman+ only see
 * any rows at all; an installer's identical call comes back empty (RLS). */
export async function listDailyLogs(projectId: string): Promise<DailyLog[]> {
  const { data, error } = await supabase
    .from("daily_logs")
    .select(LOG_SELECT)
    .eq("project_id", projectId)
    .order("log_date", { ascending: false });
  if (isMissingTableError(error)) return [];
  if (error) throw error;
  return (data ?? []) as unknown as DailyLog[];
}

/** One job-day's log, or null if nobody has filed it yet. */
export async function getDailyLog(projectId: string, logDate: string): Promise<DailyLog | null> {
  const { data, error } = await supabase
    .from("daily_logs")
    .select(LOG_SELECT)
    .eq("project_id", projectId)
    .eq("log_date", logDate)
    .maybeSingle();
  if (isMissingTableError(error)) return null;
  if (error) throw error;
  return (data as unknown as DailyLog) ?? null;
}

export interface FileDailyLogInput {
  projectId: string;
  logDate: string;
  headline: string | null;
  notes: string;
  dayFlow: DayFlow | null;
  reflection: DailyLogReflection | null;
  weather: string | null;
}

export async function fileDailyLog(input: FileDailyLogInput): Promise<DailyLog> {
  const { data, error } = await supabase.rpc("file_daily_log", {
    p_project_id: input.projectId,
    p_log_date: input.logDate,
    p_headline: input.headline,
    p_notes: input.notes,
    p_day_flow: input.dayFlow,
    p_reflection: input.reflection,
    p_weather: input.weather,
  });
  if (error) throw error;
  return data as DailyLog;
}

// -------------------------------------------------- L2: the draft's inputs

/** The local calendar day's [start, end) as absolute instants, computed in
 * the caller's OWN timezone (no `Z` suffix — parsed as local time), so the
 * window lines up exactly with logDate's local meaning. */
function localDayBounds(logDate: string): { startIso: string; endIso: string } {
  const start = new Date(`${logDate}T00:00:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

interface DraftShiftRow {
  profile_id: string;
  clock_in_at: string;
  clock_out_at: string | null;
  break_seconds: number;
  status: string;
}

async function listProjectShiftsOnDay(projectId: string, logDate: string): Promise<DraftShiftRow[]> {
  const { startIso, endIso } = localDayBounds(logDate);
  const { data, error } = await supabase
    .from("time_shifts")
    .select("profile_id, clock_in_at, clock_out_at, break_seconds, status")
    .eq("project_id", projectId)
    .gte("clock_in_at", startIso)
    .lt("clock_in_at", endIso)
    .order("clock_in_at");
  if (isMissingTableError(error)) return [];
  if (error) throw error;
  return (data ?? []) as DraftShiftRow[];
}

/**
 * Everything buildDailyLogDraft needs for one job-day, fetched and bucketed
 * to that LOCAL day. Sessions/redos are fetched project-wide (they have no
 * date-range query of their own — see sessions.ts) and filtered here by
 * punchDay, the same local-day convention timecard.ts already uses to
 * bucket a punch; started_at/pressed_at get the identical treatment so a
 * unit worked or a redo pressed near local midnight lands in the same
 * bucket a shift would.
 */
export async function buildDraftForJobDay(projectId: string, logDate: string): Promise<DailyLogDraft> {
  const [shifts, sessions, redos] = await Promise.all([
    listProjectShiftsOnDay(projectId, logDate),
    listProjectSessions(projectId),
    listProjectRedosAll(projectId),
  ]);

  return buildDailyLogDraft({
    shifts: shifts.map((s) => ({
      profile_id: s.profile_id,
      clock_in_at: s.clock_in_at,
      clock_out_at: s.clock_out_at,
      break_seconds: s.break_seconds,
      status: s.status,
    })),
    sessions: sessions
      .filter((s) => punchDay(s.started_at) === logDate)
      .map((s) => ({
        opening_id: s.opening_id,
        opening_code: s.opening?.opening_code ?? "?",
        started_at: s.started_at,
        ended_at: s.ended_at,
        end_reason: s.end_reason,
      })),
    redos: redos
      .filter((r) => punchDay(r.pressed_at) === logDate)
      .map((r) => ({
        opening_id: r.opening_id,
        opening_code: r.opening?.opening_code ?? "?",
        reason: r.reason,
      })),
  });
}

// ------------------------------------------------------ L4: the today chip

export interface JobNeedingLog {
  projectId: string;
  jobCode: string;
  name: string;
}

/** Every project with a unit_sessions row today, project-wide (the chip has
 * to see every job, not one) — minimal columns, just enough to bucket by
 * project and by local day. */
async function listSessionProjectIdsToday(startIso: string, endIso: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("unit_sessions")
    .select("opening:project_openings!inner(project_id)")
    .gte("started_at", startIso)
    .lt("started_at", endIso);
  if (isMissingTableError(error)) return [];
  if (error) throw error;
  return ((data ?? []) as unknown as { opening: { project_id: string } | null }[])
    .map((r) => r.opening?.project_id)
    .filter((id): id is string => Boolean(id));
}

async function listLoggedProjectIdsToday(logDate: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("daily_logs")
    .select("project_id")
    .eq("log_date", logDate);
  if (isMissingTableError(error)) return [];
  if (error) throw error;
  return ((data ?? []) as { project_id: string }[]).map((r) => r.project_id);
}

/**
 * The "Log today · N" chip's data (L4): active jobs worked today (any
 * shift or session, by anyone — Q6's ONE shared log per job means the chip
 * is not scoped to "installers who report to me", a hierarchy this app has
 * no table for) with no daily_logs row yet for today. Foreman+ only surface
 * — the caller (LogTodayChip) gates rendering on role; the underlying
 * shift/session reads are already open to any authenticated role (same as
 * every other crew-wide time read in this app), so there is nothing here
 * for RLS to block the way daily_logs' own SELECT policy blocks reading
 * logs themselves.
 */
export async function jobsNeedingLogToday(): Promise<JobNeedingLog[]> {
  const logDate = localDateISO();
  const { startIso, endIso } = localDayBounds(logDate);

  const [active, teamShifts, sessionProjectIds, loggedProjectIds] = await Promise.all([
    listProjects(),
    listTeamShifts(startIso, endIso),
    listSessionProjectIdsToday(startIso, endIso),
    listLoggedProjectIdsToday(logDate),
  ]);

  const workedProjectIds = [
    ...teamShifts.map((s) => s.project_id).filter((id): id is string => Boolean(id)),
    ...sessionProjectIds,
  ];
  const needIds = new Set(jobsNeedingLog(workedProjectIds, loggedProjectIds));

  return active
    .filter((p) => needIds.has(p.id))
    .map((p) => ({ projectId: p.id, jobCode: p.job_code, name: p.name }));
}
