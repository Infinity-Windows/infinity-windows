// Wave L: the client face of daily_logs. Reads go straight through RLS
// (foreman+ only — Q7, see 20260949000000_daily_logs.sql); every write goes
// through file_daily_log (SECURITY DEFINER) — there is no direct-write path
// to bypass its validation.

import { supabase } from "./supabase";
import { isNetworkError } from "./offline/outbox-core";
import { enqueueDailyLog } from "./offline/outbox";
import { listProjects } from "./api";
import { listTeamShifts, punchDay, weekRange } from "./timeclock";
import { listProjectRedosAll, listProjectSessions } from "./install/sessions";
import { buildDailyLogDraft, type DailyLogDraft } from "./dailyLogDraft";
import { jobsNeedingLog, localDateISO } from "./dailyLogDay";
import { coverage, type CoverageSummary, type JobDay } from "./dailyLogCoverage";

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
  customer_visible_at: string | null;
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

/**
 * Every job's logs whose log_date falls in [fromDate, toDate] inclusive —
 * wave C's calendar day panel needs one date across every job, not one
 * job's whole history (listDailyLogs above) or just which project ids
 * logged today (listLoggedProjectIdsToday below). Fetched once per visible
 * month and re-sliced per day by dayMemory.ts's own log_date filter.
 * Foreman+ only see rows at all (RLS, Q7) — same as every other read here.
 */
export async function listDailyLogsForRange(fromDate: string, toDate: string): Promise<DailyLog[]> {
  const { data, error } = await supabase
    .from("daily_logs")
    .select(LOG_SELECT)
    .gte("log_date", fromDate)
    .lte("log_date", toDate);
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

/** What happened to a filing: it reached the server, or it is waiting. */
export interface FiledDailyLog {
  /** The saved row, or null when this is sitting in the outbox instead. */
  log: DailyLog | null;
  /** True when it is queued on this phone rather than done on the server. */
  queued: boolean;
}

/**
 * File (or update) one job-day's log — SERVER FIRST, queue only on no signal.
 *
 * This used to be a bare RPC with no fallback, which meant a log written in a
 * canyon was simply lost: the toast said what the server said, which was
 * nothing, and the words were gone. It now follows the same doctrine as the
 * warehouse writes (lib/warehouse/offlineWrites.ts).
 *
 * The direction of that doctrine matters here more than most places, because
 * file_daily_log genuinely rejects things: notes are required, a future date
 * is refused, and anyone below foreman is turned away. Those are REAL answers
 * and they surface immediately — queueing a refusal means it fails forever in
 * the dead-letter and the person never learns they were wrong. Only a network
 * failure queues.
 */
export async function fileDailyLog(input: FileDailyLogInput): Promise<FiledDailyLog> {
  try {
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
    return { log: data as DailyLog, queued: false };
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    await enqueueDailyLog({
      projectId: input.projectId,
      logDate: input.logDate,
      headline: input.headline,
      notes: input.notes,
      dayFlow: input.dayFlow,
      reflection: input.reflection,
      weather: input.weather,
    });
    return { log: null, queued: true };
  }
}

/** Wave S, S2: supervisor+ shares (or un-shares) one day's log with the
 * builder login granted that job (Q14). Server-enforced (RLS has no direct
 * write path to daily_logs at all — set_log_customer_visible is SECURITY
 * DEFINER and the only writer); this call fails outright for anyone below
 * supervisor rather than silently no-op. */
export async function setLogCustomerVisible(logId: string, visible: boolean): Promise<DailyLog> {
  const { data, error } = await supabase.rpc("set_log_customer_visible", {
    p_log: logId,
    p_visible: visible,
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

/** Every unit_sessions row in range, project-wide (the chip and the
 * coverage line both need every job, not one), reduced to just enough to
 * bucket by project and by local day — shared by jobsNeedingLogToday
 * (which only cares about the project) and weeklyLogCoverage (which needs
 * the day too, since its range spans more than one). */
async function listSessionProjectDaysInRange(
  startIso: string,
  endIso: string,
): Promise<{ projectId: string; logDate: string }[]> {
  const { data, error } = await supabase
    .from("unit_sessions")
    .select("started_at, opening:project_openings!inner(project_id)")
    .gte("started_at", startIso)
    .lt("started_at", endIso);
  if (isMissingTableError(error)) return [];
  if (error) throw error;
  return ((data ?? []) as unknown as { started_at: string; opening: { project_id: string } | null }[])
    .filter((r) => r.opening?.project_id)
    .map((r) => ({ projectId: r.opening!.project_id, logDate: punchDay(r.started_at) }));
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

  const [active, teamShifts, sessionDays, loggedProjectIds] = await Promise.all([
    listProjects(),
    listTeamShifts(startIso, endIso),
    listSessionProjectDaysInRange(startIso, endIso),
    listLoggedProjectIdsToday(logDate),
  ]);

  const workedProjectIds = [
    ...teamShifts.map((s) => s.project_id).filter((id): id is string => Boolean(id)),
    ...sessionDays.map((d) => d.projectId),
  ];
  const needIds = new Set(jobsNeedingLog(workedProjectIds, loggedProjectIds));

  return active
    .filter((p) => needIds.has(p.id))
    .map((p) => ({ projectId: p.id, jobCode: p.job_code, name: p.name }));
}

// --------------------------------------------------- L5: coverage for owners

/**
 * This week's log coverage across every active job (Heartbeat's owner-only
 * line — spec's own example: "Logs: 4 of 6 worked days logged this week").
 * weekRange() is the SAME Monday-based week the payroll grid already uses
 * (timeclock.ts) — one more place this wave reuses an existing day/week
 * convention instead of minting a second one.
 */
export async function weeklyLogCoverage(): Promise<CoverageSummary> {
  const week = weekRange();
  const weekStartDate = localDateISO(week.start);
  const weekEndDate = localDateISO(week.end);

  const [active, teamShifts, sessionDays, logRows] = await Promise.all([
    listProjects(),
    listTeamShifts(week.startIso, week.endIso),
    listSessionProjectDaysInRange(week.startIso, week.endIso),
    supabase
      .from("daily_logs")
      .select("project_id, log_date")
      .gte("log_date", weekStartDate)
      .lt("log_date", weekEndDate)
      .then(({ data, error }) => {
        if (isMissingTableError(error)) return [] as { project_id: string; log_date: string }[];
        if (error) throw error;
        return (data ?? []) as { project_id: string; log_date: string }[];
      }),
  ]);

  const activeIds = new Set(active.map((p) => p.id));
  const workedDays: JobDay[] = [
    ...teamShifts
      .filter((s): s is typeof s & { project_id: string } => Boolean(s.project_id))
      .map((s) => ({ projectId: s.project_id, logDate: punchDay(s.clock_in_at) })),
    ...sessionDays.map((d) => ({ projectId: d.projectId, logDate: d.logDate })),
  ].filter((d) => activeIds.has(d.projectId));
  const loggedDays: JobDay[] = logRows
    .map((r) => ({ projectId: r.project_id, logDate: r.log_date }))
    .filter((d) => activeIds.has(d.projectId));

  return coverage(workedDays, loggedDays);
}
