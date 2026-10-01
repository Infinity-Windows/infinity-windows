// Jobs Overview (replaces Heartbeat): a supervisor/owner's compact read of
// every active job. See outputs/Heartbeat-Proposal-2026-10-01/PROPOSAL.md and
// outputs/Jobs-Overview-2026-10-01/REVIEW-FINDINGS.md — this file is the
// corrected data layer after Codex's pre-release review (findings 1-7).
//
// Every read in this file is its OWN strict query: no reuse of
// listAssignments / listSessionsInRange / listDailyLogsForRange /
// listGreenLightItems, because each of those has a silent schema or local
// fallback that would read as "no work" or "no concerns" when the real
// answer is "could not read this". A missing table, a missing function, or a
// row count PostgREST will not confirm is UNAVAILABLE here, never zero.
//
// Data integrity:
//  - Opening-based progress: project_scope_counts, strictly paginated.
//  - Custom-work progress: custom_work_units.facts.installation_complete,
//    counted ONLY for units with no opening_id (an opening-linked unit's
//    progress already lives in the scope count above).
//  - No QC source is read; a row never implies QC acceptance.
//  - Recorded activity: unit_sessions (opening work, correctly scoped per
//    project via the inner join), custom_work_sessions, and dated
//    crew_work_records with a non-"assigned" outcome. Never a unit/opening
//    edit timestamp, and a daily log's EDIT time never counts as today's
//    work — only its log_date (what day the report is about).
//  - "Meaningful changes" never counts sessions as installed-opening counts:
//    helper/stage sessions and duplicates don't establish a distinct
//    installed unit, and that category is omitted entirely rather than
//    guessed at.

import { supabase } from "./supabase";
import type { Project } from "./types";
import { KIND_LABELS, type Issue, type IssueKind } from "./issues";
import { addDaysISO, agendaDayLabel } from "./schedule/dates";
import { describeDuration } from "./shiftGuard";
import { todayLocalDay } from "./credentials";

// ---------------------------------------------------------------- consts

/** How far back "recorded activity" looks for a last-touched timestamp. */
const ACTIVITY_LOOKBACK_DAYS = 14;
/** How far ahead a published/in_progress assignment still counts as "upcoming". */
const UPCOMING_WINDOW_DAYS = 7;
/** A schedule edit under this age-past-publish is noise, not a reported change. */
const SCHEDULE_EDIT_THRESHOLD_MS = 60_000;
/** Strict pagination page size for every batched table read in this file. */
const PAGE_SIZE = 500;
/** Readiness RPC concurrency cap — only called for jobs planned today or in
 * the next 7 days, so this is a small batch, not a company-wide fan-out. */
const READINESS_CONCURRENCY = 4;

// ---------------------------------------------------------------- types

export interface JobOverviewScope {
  /** False when project_scope_counts could not be read — never assume zero. */
  available: boolean;
  openings: number;
  installed: number;
}

export interface JobOverviewCustomWork {
  /** False when custom_work_units could not be read. */
  available: boolean;
  /** Units with no opening_id — openings already carry their own progress. */
  total: number;
  completed: number;
}

export type ConcernKind = "issue" | "readiness" | "statusUnknown";
export type ConcernSeverity = "emergency" | "urgent" | "normal" | "info";

export interface JobOverviewConcern {
  kind: ConcernKind;
  /** The underlying issue kind, only when kind === "issue". */
  issueKind?: IssueKind;
  severity: ConcernSeverity;
  /** Plain English label; the parent localizes from the structured fields
   * below rather than trusting this string in Spanish. */
  label: string;
  note: string | null;
  /** "Unassigned" only when the record truly carries no assignee. A failed
   * name lookup on a real assignee is never reported as Unassigned. */
  assignedToName: string | null;
  /** The raw assignee id, when the concern is an issue with one recorded —
   * present even if the name lookup failed, so the parent can still link it. */
  assignedToId?: string;
  ageLabel: string | null;
  /** The issue's own created_at, when this concern came from an issue. */
  createdAt?: string;
  /** Open readiness-item count, when this concern is a readiness concern. */
  readinessCount?: number;
  /** Exact deep link: /issues?issue=<id> for an issue concern (the Issues
   * screen resolves it regardless of open/resolved status). */
  href: string;
  exactLink: boolean;
}

export interface JobOverviewPlan {
  crewNames: string[];
  note: string | null;
}

export interface JobOverviewNextStep {
  /** English fallback label; the parent should prefer dateISO + its own copy. */
  label: string;
  dateISO: string;
  crewNames?: string[];
}

export interface JobOverviewActivity {
  atISO: string;
  source: "opening" | "customWork" | "dailyLog" | "crewReport";
}

export interface JobOverviewRow {
  id: string;
  name: string;
  jobCode: string;
  href: string;
  /** True for a not-yet-active job surfaced only because of published work
   * in the next 7 days, and only once its own project row confirms it is
   * actually active and not deleted. */
  isUpcoming: boolean;
  scope: JobOverviewScope | null;
  customWork: JobOverviewCustomWork | null;
  today: JobOverviewPlan | null;
  nextStep: JobOverviewNextStep | null;
  /** The top-ranked concern (back-compat single field). */
  concern: JobOverviewConcern | null;
  /** Every open concern for this job, ranked, for an expanded detail view. */
  concerns?: JobOverviewConcern[];
  lastActivity: JobOverviewActivity | null;
  needsAttention: boolean;
  issuesAvailable?: boolean;
  scheduleAvailable?: boolean;
  activityAvailable?: boolean;
  readinessAvailable?: boolean;
}

export type JobsOverviewChangeKind =
  | "issueNew"
  | "issueResolved"
  | "schedulePublished"
  | "scheduleChanged"
  | "dailyLog";

export interface JobsOverviewChange {
  id: string;
  projectId: string;
  jobLabel: string;
  /** English fallback; the parent localizes from kind/issueKind/headline. */
  text: string;
  atISO: string;
  href: string;
  kind?: JobsOverviewChangeKind;
  issueKind?: IssueKind;
  dateISO?: string;
  headline?: string;
}

export interface JobsOverviewSourceAvailability {
  scope: boolean;
  issues: boolean;
  schedule: boolean;
  customWork: boolean;
  dailyLogs: boolean;
  sessions: boolean;
  readiness: boolean;
}

export interface JobsOverviewSnapshot {
  generatedAt: string;
  rows: JobOverviewRow[];
  changes: JobsOverviewChange[];
  sources: JobsOverviewSourceAvailability;
  /** Short, factual, untranslated notes about what this view could not
   * verify — the parent renders its own translated copy around these. */
  scopeGaps: string[];
}

// ------------------------------------------------------------ pure logic

/** Tier an open issue ranks at: urgent/emergency first, a known blocker
 * next (whatever its urgency), everything else last. Readiness's own tier
 * (2) sits between — see buildConcerns. */
function issueRank(issue: Issue): number {
  if (issue.urgency === "emergency" || issue.urgency === "urgent") return 0;
  if (issue.kind === "blocker") return 1;
  return 3;
}

/** The single best-ranked open issue, oldest-first within a tier. Exported
 * for the narrower "just the issues" case; buildConcern/buildConcerns below
 * are what actually decide a job's displayed concern. */
export function pickMainIssue(issues: Issue[]): Issue | null {
  const open = issues.filter((i) => i.status === "open");
  if (open.length === 0) return null;
  return [...open].sort(
    (a, b) => issueRank(a) - issueRank(b) || a.created_at.localeCompare(b.created_at),
  )[0];
}

/** A concern earns "Needs attention" when it's more than a routine open
 * issue: urgent/emergency, a blocker at any tier, or an applicable open
 * readiness item. "Status unknown" never does — it's a followup note, not a
 * block (proposal: inactivity alone is not a blocker). */
export function isAttentionWorthy(concern: JobOverviewConcern | null): boolean {
  if (!concern) return false;
  if (concern.kind === "statusUnknown") return false;
  if (concern.kind === "readiness") return true;
  return concern.severity !== "normal" || concern.issueKind === "blocker";
}

function ageLabel(fromISO: string, nowMs: number): string {
  const ms = nowMs - Date.parse(fromISO);
  if (!Number.isFinite(ms) || ms < 0) return "";
  return `${describeDuration(ms / 1000)} ago`;
}

function issueConcern(issue: Issue, nowMs: number, names: Map<string, string>, namesOk: boolean): JobOverviewConcern {
  const assignedId = issue.assigned_to ?? undefined;
  const assignedToName = !assignedId
    ? "Unassigned"
    : namesOk
      ? names.get(assignedId) ?? "Assigned (name unavailable)"
      : "Assigned (name unavailable)";
  return {
    kind: "issue",
    issueKind: issue.kind,
    severity: issue.urgency,
    label: KIND_LABELS[issue.kind] ?? issue.kind,
    note: issue.note,
    assignedToName,
    assignedToId: assignedId,
    ageLabel: ageLabel(issue.created_at, nowMs),
    createdAt: issue.created_at,
    href: `/issues?issue=${issue.id}`,
    exactLink: true,
  };
}

function readinessConcernOf(openCount: number, projectId: string): JobOverviewConcern {
  return {
    kind: "readiness",
    severity: "normal",
    label: `Readiness: ${openCount} item${openCount === 1 ? "" : "s"} open`,
    note: null,
    assignedToName: null,
    ageLabel: null,
    readinessCount: openCount,
    href: `/projects/${projectId}?tab=overview`,
    exactLink: false,
  };
}

function statusUnknownConcern(): JobOverviewConcern {
  return {
    kind: "statusUnknown",
    severity: "info",
    label: "Status unknown today",
    note: null,
    assignedToName: null,
    ageLabel: null,
    href: "",
    exactLink: false,
  };
}

/**
 * Every open concern for a job, ranked: urgent/emergency issues, then a
 * known blocker (any urgency), then an applicable open readiness item, then
 * ordinary open issues. A routine issue never hides a blocker or an
 * applicable readiness item — all are returned, ranked, never thrown away.
 */
export function buildConcerns(args: {
  issues: Issue[];
  projectId: string;
  nowMs: number;
  names: Map<string, string>;
  namesOk: boolean;
  readinessOpenCount: number | null;
  /** Only an "applicable" job (work today or in the next 7 days) may ever
   * surface a readiness concern — an unscheduled job's open checklist is not
   * alert noise. */
  readinessApplicable: boolean;
}): JobOverviewConcern[] {
  const { issues, projectId, nowMs, names, namesOk, readinessOpenCount, readinessApplicable } = args;
  const open = issues.filter((i) => i.status === "open");
  const entries: { concern: JobOverviewConcern; rank: number; tiebreak: string }[] = open.map((i) => ({
    concern: issueConcern(i, nowMs, names, namesOk),
    rank: issueRank(i),
    tiebreak: i.created_at,
  }));
  if (readinessApplicable && readinessOpenCount != null && readinessOpenCount > 0) {
    entries.push({ concern: readinessConcernOf(readinessOpenCount, projectId), rank: 2, tiebreak: "" });
  }
  entries.sort((a, b) => a.rank - b.rank || a.tiebreak.localeCompare(b.tiebreak));
  return entries.map((e) => e.concern);
}

/**
 * The single top concern (back-compat). Falls to "status unknown today"
 * only when work was published for today, nothing is recorded yet, AND —
 * when a start time was given — that time has actually passed. Never an
 * early warning ahead of the scheduled start.
 */
export function buildConcern(args: {
  issues: Issue[];
  projectId: string;
  nowMs: number;
  names: Map<string, string>;
  namesOk?: boolean;
  readinessOpenCount: number | null;
  readinessApplicable?: boolean;
  publishedToday: boolean;
  hasActivityToday: boolean;
  pastScheduledStart?: boolean;
}): JobOverviewConcern | null {
  const concerns = buildConcerns({
    issues: args.issues,
    projectId: args.projectId,
    nowMs: args.nowMs,
    names: args.names,
    namesOk: args.namesOk ?? true,
    readinessOpenCount: args.readinessOpenCount,
    readinessApplicable: args.readinessApplicable ?? args.publishedToday,
  });
  if (concerns.length > 0) return concerns[0];
  const pastStart = args.pastScheduledStart ?? true;
  if (args.publishedToday && !args.hasActivityToday && pastStart) return statusUnknownConcern();
  return null;
}

/** Needs-attention rows first, then jobs with a published plan today, then
 * everyone else — each group keeping the order it arrived in. */
export function sortJobRows(rows: JobOverviewRow[]): JobOverviewRow[] {
  const tier = (r: JobOverviewRow): number => {
    if (r.needsAttention) return 0;
    if (r.today) return 1;
    return 2;
  };
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => tier(a.r) - tier(b.r) || a.i - b.i)
    .map(({ r }) => r);
}

/** Units with no opening_id — an opening-linked unit's progress already
 * lives in project_scope_counts, so counting it again here would double it. */
export function customWorkProgress(
  units: { project_id: string | null; opening_id: string | null; facts: { installation_complete?: string } }[],
  projectId: string,
): { total: number; completed: number } {
  const rows = units.filter((u) => u.project_id === projectId && !u.opening_id);
  const completed = rows.filter((u) => u.facts?.installation_complete === "Yes").length;
  return { total: rows.length, completed };
}

export interface StrictAssignment {
  id: string;
  project_id: string;
  kind: string;
  start_date: string;
  end_date: string;
  start_time: string | null;
  status: string;
  note: string | null;
  published_at: string | null;
  updated_at: string;
  created_at: string;
  members: { profile_id: string; role: string; display_name: string | null }[];
}

/** True for a row this file will ever show as "scheduled" — published, or
 * in_progress with actual publication evidence. Draft and canceled rows are
 * already excluded at the fetch, but every pure function re-checks this too
 * so it's provably true of what reaches the screen, not just of today's
 * query. */
function isScheduledEvidence(a: StrictAssignment): boolean {
  return a.status === "published" || (a.status === "in_progress" && !!a.published_at);
}

/** Published (or in_progress with publication evidence) crew for one job on
 * one day — names only, never a headcount guess. */
export function planFor(assignments: StrictAssignment[], projectId: string, dayISO: string): JobOverviewPlan | null {
  const matches = assignments.filter(
    (a) => a.project_id === projectId && a.kind === "install" && isScheduledEvidence(a) && a.start_date <= dayISO && a.end_date >= dayISO,
  );
  if (matches.length === 0) return null;
  const names = new Set<string>();
  const notes: string[] = [];
  for (const a of matches) {
    for (const m of a.members) names.add(m.display_name?.trim() || "Unnamed crew member");
    if (a.note?.trim()) notes.push(a.note.trim());
  }
  return { crewNames: [...names], note: notes.length > 0 ? notes.join(" · ") : null };
}

/** The earliest start_time among a job's assignments covering `dayISO`, if
 * every matching assignment carries one. Null means "no time given" — never
 * treated as midnight. */
export function earliestStartTime(assignments: StrictAssignment[], projectId: string, dayISO: string): string | null {
  const matches = assignments.filter(
    (a) => a.project_id === projectId && a.kind === "install" && isScheduledEvidence(a) && a.start_date <= dayISO && a.end_date >= dayISO,
  );
  const times = matches.map((a) => a.start_time).filter((t): t is string => !!t);
  if (times.length === 0) return null;
  return times.sort()[0];
}

/** Has a given start_time (HH:MM[:SS]) on `dayISO` already passed `nowMs`? */
export function hasPassedStartTime(dayISO: string, startTime: string | null, nowMs: number): boolean {
  if (!startTime) return true;
  const [h = 0, m = 0, s = 0] = startTime.split(":").map((n) => Number(n) || 0);
  const t = new Date(`${dayISO}T00:00:00`);
  t.setHours(h, m, s, 0);
  return nowMs >= t.getTime();
}

/**
 * The next planned day after `todayISO`, honoring an ONGOING multi-day
 * assignment that already covers tomorrow (next day = max(start_date,
 * tomorrow), not just a later start_date). Only published/in_progress rows
 * ever reach this (filtered at the fetch), never draft/canceled. Never
 * invents an owner or a task — only a date and crew the schedule carries.
 */
export function nextStepFor(assignments: StrictAssignment[], projectId: string, todayISO: string): JobOverviewNextStep | null {
  const tomorrowISO = addDaysISO(todayISO, 1);
  const candidates = assignments
    .filter((a) => a.project_id === projectId && a.kind === "install" && isScheduledEvidence(a) && a.end_date >= tomorrowISO)
    .map((a) => ({ a, nextDay: a.start_date > tomorrowISO ? a.start_date : tomorrowISO }))
    .sort((x, y) => x.nextDay.localeCompare(y.nextDay));
  if (candidates.length === 0) return null;
  const { a, nextDay } = candidates[0];
  const crewNames = [...new Set(a.members.map((m) => m.display_name?.trim() || "Unnamed crew member"))];
  return { label: `Crew scheduled ${agendaDayLabel(nextDay)}`, dateISO: nextDay, crewNames };
}

interface UnitSessionRow {
  id: string;
  started_at: string;
  ended_at: string | null;
  opening_id: string;
  end_reason: string | null;
  role: string;
  project_id: string;
}

interface CustomSessionRow {
  id: string;
  project_id: string | null;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
}

interface CrewRecordRow {
  id: string;
  project_id: string;
  unit_id: string;
  filed_by: string | null;
  work_date: string;
  stage: string;
  outcome: string;
  whole_complete: boolean;
  description: string;
  created_at: string;
}

interface DailyLogRow {
  id: string;
  project_id: string;
  log_date: string;
  headline: string | null;
  created_at: string;
  updated_at: string;
}

function localDayOf(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Latest of the four recorded-fact kinds this file reads, each scoped to
 * ONE project — the bug this corrects (finding 1) was reading every
 * project's sessions into every job's "latest activity". A daily log
 * contributes its FILED time (created_at), never an edit (updated_at), so
 * editing yesterday's log never reads as today's work. */
export function latestActivity(args: {
  sessions: UnitSessionRow[];
  customSessions: CustomSessionRow[];
  crewRecords: CrewRecordRow[];
  dailyLogs: DailyLogRow[];
  projectId: string;
}): JobOverviewActivity | null {
  let best: JobOverviewActivity | null = null;
  const consider = (atISO: string | null | undefined, source: JobOverviewActivity["source"]) => {
    if (!atISO) return;
    if (!best || Date.parse(atISO) > Date.parse(best.atISO)) best = { atISO, source };
  };
  for (const s of args.sessions) {
    if (s.project_id !== args.projectId) continue;
    consider(s.ended_at ?? s.started_at, "opening");
  }
  for (const s of args.customSessions) {
    if (s.project_id !== args.projectId) continue;
    consider(s.ended_at ?? s.started_at, "customWork");
  }
  for (const r of args.crewRecords) {
    if (r.project_id !== args.projectId) continue;
    consider(r.created_at, "crewReport");
  }
  for (const log of args.dailyLogs) {
    if (log.project_id !== args.projectId) continue;
    consider(log.created_at, "dailyLog");
  }
  return best;
}

/**
 * Was there any recorded activity on `projectId` on `dayISO`? A session
 * counts if it STARTED or ENDED that day (one that started yesterday and
 * finished today is today's activity too). A crew report counts by its own
 * `work_date`, never by when it was typed. A daily log counts by its
 * `log_date` — the day the report is ABOUT — never by an edit timestamp.
 * Scheduled crew (attendance) is deliberately not one of these signals.
 */
export function hasActivityOn(args: {
  sessions: UnitSessionRow[];
  customSessions: CustomSessionRow[];
  crewRecords: CrewRecordRow[];
  dailyLogs: DailyLogRow[];
  projectId: string;
  dayISO: string;
}): boolean {
  const onDay = (iso: string | null) => (iso ? localDayOf(iso) === args.dayISO : false);
  if (args.sessions.some((s) => s.project_id === args.projectId && (onDay(s.started_at) || onDay(s.ended_at)))) return true;
  if (args.customSessions.some((s) => s.project_id === args.projectId && (onDay(s.started_at) || onDay(s.ended_at)))) return true;
  if (args.crewRecords.some((r) => r.project_id === args.projectId && r.work_date === args.dayISO)) return true;
  if (args.dailyLogs.some((l) => l.project_id === args.projectId && l.log_date === args.dayISO)) return true;
  return false;
}

// ------------------------------------------------------------- fetching

/** Strict batched pagination: every page must report a stable total row
 * count, and any error (including a missing table/function) makes the whole
 * read UNAVAILABLE rather than a false "zero rows" success. */
async function paginateStrict<T>(
  fetchPage: (from: number, to: number) => Promise<{ data: T[] | null; error: unknown; count: number | null }>,
): Promise<{ rows: T[]; ok: boolean }> {
  const result: T[] = [];
  let expected: number | null = null;
  for (let from = 0; from < 2_000_000; from += PAGE_SIZE) {
    const { data, error, count } = await fetchPage(from, from + PAGE_SIZE - 1);
    if (error) return { rows: [], ok: false };
    if (count == null) return { rows: [], ok: false };
    if (expected !== null && count !== expected) return { rows: [], ok: false };
    expected = count;
    const got = data ?? [];
    result.push(...got);
    if (from + got.length >= count) return { rows: result, ok: true };
    if (got.length === 0) return { rows: [], ok: false };
  }
  return { rows: [], ok: false };
}

const SCOPE_COLS =
  "project_id, openings, installed, windows, doors, door_sliders, door_french, door_bifold, door_swing, door_other, unknown_units";

interface ScopeRow {
  project_id: string;
  openings: number;
  installed: number;
}

async function fetchScopeCounts(projectIds: string[]): Promise<{ rows: ScopeRow[]; ok: boolean }> {
  if (projectIds.length === 0) return { rows: [], ok: true };
  return paginateStrict<ScopeRow>((from, to) =>
    supabase
      .from("project_scope_counts")
      .select(SCOPE_COLS, { count: "exact" })
      .in("project_id", projectIds)
      .order("project_id").range(from, to) as unknown as Promise<{ data: ScopeRow[] | null; error: unknown; count: number | null }>,
  );
}

async function fetchCustomWorkUnits(
  projectIds: string[],
): Promise<{ rows: { id: string; project_id: string | null; opening_id: string | null; facts: { installation_complete?: string } }[]; ok: boolean }> {
  if (projectIds.length === 0) return { rows: [], ok: true };
  type Row = { id: string; project_id: string | null; opening_id: string | null; facts: { installation_complete?: string } };
  return paginateStrict<Row>((from, to) =>
    supabase
      .from("custom_work_units")
      .select("id, project_id, opening_id, facts", { count: "exact" })
      .in("project_id", projectIds)
      .order("id").range(from, to) as unknown as Promise<{ data: Row[] | null; error: unknown; count: number | null }>,
  );
}

async function fetchCustomWorkSessions(projectIds: string[], sinceISO: string): Promise<{ rows: CustomSessionRow[]; ok: boolean }> {
  if (projectIds.length === 0) return { rows: [], ok: true };
  return paginateStrict<CustomSessionRow>((from, to) =>
    supabase
      .from("custom_work_sessions")
      .select("id, project_id, started_at, ended_at, outcome", { count: "exact" })
      .in("project_id", projectIds)
      .or(`started_at.gte.${sinceISO},ended_at.gte.${sinceISO}`)
      .order("id").range(from, to) as unknown as Promise<{ data: CustomSessionRow[] | null; error: unknown; count: number | null }>,
  );
}

/** unit_sessions, correctly scoped per project via the inner join to
 * project_openings — the exact bug finding 1 named (every job's sessions
 * were being read into every other job's "latest activity"). */
async function fetchUnitSessions(projectIds: string[], sinceISO: string): Promise<{ rows: UnitSessionRow[]; ok: boolean }> {
  if (projectIds.length === 0) return { rows: [], ok: true };
  type RawRow = {
    id: string;
    started_at: string;
    ended_at: string | null;
    opening_id: string;
    end_reason: string | null;
    role: string;
    opening: { project_id: string } | null;
  };
  const result = await paginateStrict<RawRow>((from, to) =>
    supabase
      .from("unit_sessions")
      .select("id, started_at, ended_at, opening_id, end_reason, role, opening:project_openings!inner(project_id)", { count: "exact" })
      .in("opening.project_id", projectIds)
      .or(`started_at.gte.${sinceISO},ended_at.gte.${sinceISO}`)
      .order("id").range(from, to) as unknown as Promise<{ data: RawRow[] | null; error: unknown; count: number | null }>,
  );
  if (!result.ok) return { rows: [], ok: false };
  return {
    ok: true,
    rows: result.rows
      .filter((r) => r.opening?.project_id)
      .map((r) => ({
        id: r.id,
        started_at: r.started_at,
        ended_at: r.ended_at,
        opening_id: r.opening_id,
        end_reason: r.end_reason,
        role: r.role,
        project_id: r.opening!.project_id,
      })),
  };
}

/** Dated manual crew reports, non-"assigned" outcomes only (an "assigned"
 * row records an assignment, not reported work). */
async function fetchCrewRecords(projectIds: string[], sinceDayISO: string): Promise<{ rows: CrewRecordRow[]; ok: boolean }> {
  if (projectIds.length === 0) return { rows: [], ok: true };
  return paginateStrict<CrewRecordRow>((from, to) =>
    supabase
      .from("crew_work_records")
      .select("id, project_id, unit_id, filed_by, work_date, stage, outcome, whole_complete, description, created_at", { count: "exact" })
      .in("project_id", projectIds)
      .neq("outcome", "assigned")
      .gte("work_date", sinceDayISO)
      .order("id").range(from, to) as unknown as Promise<{ data: CrewRecordRow[] | null; error: unknown; count: number | null }>,
  );
}

async function fetchDailyLogs(projectIds: string[], sinceDayISO: string): Promise<{ rows: DailyLogRow[]; ok: boolean }> {
  if (projectIds.length === 0) return { rows: [], ok: true };
  return paginateStrict<DailyLogRow>((from, to) =>
    supabase
      .from("daily_logs")
      .select("id, project_id, log_date, headline, created_at, updated_at", { count: "exact" })
      .in("project_id", projectIds)
      .gte("log_date", sinceDayISO)
      .order("id").range(from, to) as unknown as Promise<{ data: DailyLogRow[] | null; error: unknown; count: number | null }>,
  );
}

/**
 * Published/in_progress assignments touching [fromISO, toISO], company-wide
 * but date-bounded to a 7-day window with explicit columns — never a
 * draft, never canceled, and never a client-local fallback. Company-wide
 * (not project-scoped) on purpose: this is also how an as-yet-inactive
 * job's published work is discovered in the first place.
 */
async function fetchAssignments(fromISO: string, toISO: string): Promise<{ rows: StrictAssignment[]; ok: boolean }> {
  type RawRow = {
    id: string;
    project_id: string | null;
    kind: string | null;
    start_date: string;
    end_date: string;
    start_time: string | null;
    status: string;
    note: string | null;
    published_at: string | null;
    updated_at: string;
    created_at: string;
    schedule_assignment_members: { profile_id: string; role: string; profiles: { display_name: string | null } | null }[] | null;
  };
  const result = await paginateStrict<RawRow>((from, to) =>
    supabase
      .from("schedule_assignments")
      .select(
        "id, project_id, kind, start_date, end_date, start_time, status, note, published_at, updated_at, created_at, schedule_assignment_members(profile_id, role, profiles(display_name))",
        { count: "exact" },
      )
      .in("status", ["published", "in_progress"])
      .lte("start_date", toISO)
      .gte("end_date", fromISO)
      .order("id").range(from, to) as unknown as Promise<{ data: RawRow[] | null; error: unknown; count: number | null }>,
  );
  if (!result.ok) return { rows: [], ok: false };
  return {
    ok: true,
    rows: result.rows
      .filter((r): r is RawRow & { project_id: string } => !!r.project_id)
      .map((r) => ({
        id: r.id,
        project_id: r.project_id,
        kind: r.kind ?? "install",
        start_date: r.start_date,
        end_date: r.end_date,
        start_time: r.start_time,
        status: r.status,
        note: r.note,
        published_at: r.published_at,
        updated_at: r.updated_at,
        created_at: r.created_at,
        members: (r.schedule_assignment_members ?? []).map((m) => ({
          profile_id: m.profile_id,
          role: m.role,
          display_name: m.profiles?.display_name ?? null,
        })),
      })),
  };
}

/** Upcoming jobs a published assignment names that are not already in the
 * active set — added only once their own project row confirms "active" and
 * "not deleted" (never a completed/canceled job resurrected from a stale
 * assignment). */
async function fetchUpcomingProjects(ids: string[]): Promise<{ rows: Pick<Project, "id" | "job_code" | "name">[]; ok: boolean }> {
  if (ids.length === 0) return { rows: [], ok: true };
  const { data, error } = await supabase.from("projects").select("id, job_code, name, status, deleted_at").in("id", ids);
  if (error) return { rows: [], ok: false };
  const rows = ((data ?? []) as { id: string; job_code: string; name: string | null; status: string; deleted_at: string | null }[])
    .filter((p) => p.status === "active" && p.deleted_at == null)
    .map((p) => ({ id: p.id, job_code: p.job_code, name: p.name ?? p.job_code }));
  return { rows, ok: true };
}

async function fetchAssigneeNames(ids: string[]): Promise<{ names: Map<string, string>; ok: boolean }> {
  const unique = [...new Set(ids)];
  const names = new Map<string, string>();
  if (unique.length === 0) return { names, ok: true };
  const { data, error } = await supabase.from("profiles").select("id, display_name").in("id", unique);
  if (error) return { names, ok: false };
  for (const row of (data ?? []) as { id: string; display_name: string | null }[]) {
    if (row.display_name) names.set(row.id, row.display_name);
  }
  return { names, ok: true };
}

interface ReadinessItem {
  answered: boolean;
}

/** Strict readiness read: any error (including a missing function) is
 * unavailable for that job, never "no open items". */
async function fetchReadinessFor(projectId: string): Promise<{ id: string; openCount: number | null; ok: boolean }> {
  const { data, error } = await supabase.rpc("green_light_items", { p_project_id: projectId });
  if (error) return { id: projectId, openCount: null, ok: false };
  const items = (data ?? []) as ReadinessItem[];
  return { id: projectId, openCount: items.filter((i) => !i.answered).length, ok: true };
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < items.length) {
      const current = idx++;
      results[current] = await fn(items[current]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function localMidnightISO(daysAgo: number, now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString();
}

// ----------------------------------------------------------------- main

/**
 * The Jobs Overview read. Scope is the caller's active/not-deleted projects
 * plus any job with a published/in_progress assignment in the next
 * UPCOMING_WINDOW_DAYS days that this read can independently confirm is
 * itself active and not deleted. Every source is fetched strictly — a
 * schema gap, a missing RPC, or an unstable page count is reported as
 * unavailable in `sources` (and per-row where the brief calls for it),
 * never silently treated as "nothing is wrong".
 */
export async function getJobsOverview(projects: Project[]): Promise<JobsOverviewSnapshot> {
  const nowMs = Date.now();
  const todayISO = todayLocalDay();
  const horizonEndISO = addDaysISO(todayISO, UPCOMING_WINDOW_DAYS);
  const activityStartISO = localMidnightISO(ACTIVITY_LOOKBACK_DAYS);
  const activityStartDay = addDaysISO(todayISO, -ACTIVITY_LOOKBACK_DAYS);
  const yesterdayStartISO = localMidnightISO(1);

  const activeSet = new Set(projects.map((p) => p.id));
  const scopeGaps: string[] = [];

  const assignmentsOut = await fetchAssignments(todayISO, horizonEndISO);
  const assignments = assignmentsOut.rows;
  const scheduleOk = assignmentsOut.ok;

  const published = assignments.filter((a) => a.kind === "install" && isScheduledEvidence(a));
  const upcomingCandidateIds = [...new Set(published.map((a) => a.project_id).filter((id) => !activeSet.has(id)))];
  const upcoming = await fetchUpcomingProjects(upcomingCandidateIds);
  if (!upcoming.ok && upcomingCandidateIds.length > 0) {
    scopeGaps.push("Upcoming jobs from the published schedule could not be verified and were left out.");
  }

  const allJobs: { id: string; name: string; jobCode: string; isUpcoming: boolean }[] = [
    ...projects.map((p) => ({ id: p.id, name: p.name || p.job_code, jobCode: p.job_code, isUpcoming: false })),
    ...upcoming.rows.map((p) => ({ id: p.id, name: p.name, jobCode: p.job_code, isUpcoming: true })),
  ];
  const jobIds = allJobs.map((j) => j.id);

  const [scopeOut, unitsOut, sessionsOut, customSessionsOut, crewRecordsOut, dailyLogsOut, issuesOut] = await Promise.all([
    fetchScopeCounts(jobIds),
    fetchCustomWorkUnits(jobIds),
    fetchUnitSessions(jobIds, activityStartISO),
    fetchCustomWorkSessions(jobIds, activityStartISO),
    fetchCrewRecords(jobIds, activityStartDay),
    fetchDailyLogs(jobIds, activityStartDay),
    jobIds.length ? paginateStrict<Issue>((from, to) => supabase.rpc("list_issues", undefined, { count: "exact" }).in("project_id", jobIds).order("id").range(from, to) as unknown as Promise<{ data: Issue[] | null; error: unknown; count: number | null }>) : Promise.resolve({ rows: [] as Issue[], ok: true }),
  ]);
  const issues = issuesOut.rows;
  const issuesOk = issuesOut.ok;
  const scopeOk = scopeOut.ok;
  const customWorkOk = unitsOut.ok;
  const sessionsOk = sessionsOut.ok && crewRecordsOut.ok && customSessionsOut.ok;
  const dailyLogsOk = dailyLogsOut.ok;
  const activityOk = sessionsOut.ok && customSessionsOut.ok && crewRecordsOut.ok && dailyLogsOut.ok;

  const scopeCounts = new Map(scopeOut.rows.map((r) => [r.project_id, r]));

  // Readiness is only meaningful for a job with work today or in the next 7
  // days — fetching it for a job nobody is about to touch would just be
  // alert noise (finding 4), and reading it for every job would also be a
  // company-wide fan-out this file is trying to avoid.
  const relevantForReadiness = jobIds.filter((id) =>
    assignments.some((a) => a.project_id === id && a.kind === "install" && isScheduledEvidence(a)),
  );
  const readinessResults = await mapWithConcurrency(relevantForReadiness, READINESS_CONCURRENCY, fetchReadinessFor);
  const readinessById = new Map(readinessResults.map((r) => [r.id, r]));
  const readinessOk = scheduleOk && readinessResults.every((r) => r.ok);

  const issuesByProject = new Map<string, Issue[]>();
  for (const i of issues) {
    if (!i.project_id) continue;
    const list = issuesByProject.get(i.project_id) ?? [];
    list.push(i);
    issuesByProject.set(i.project_id, list);
  }
  const assigneeIds = issues.map((i) => i.assigned_to).filter((id): id is string => !!id);
  const { names, ok: namesOk } = await fetchAssigneeNames(assigneeIds);
  if (!namesOk) scopeGaps.push("Assignee names could not be read; assigned issues show as 'name unavailable'.");

  const rows: JobOverviewRow[] = allJobs.map((job) => {
    const scopeRow = scopeCounts.get(job.id);
    const scope: JobOverviewScope | null = scopeRow
      ? { available: true, openings: scopeRow.openings, installed: scopeRow.installed }
      : scopeOk
        ? null
        : { available: false, openings: 0, installed: 0 };

    const cw = customWorkProgress(unitsOut.rows, job.id);
    const customWork: JobOverviewCustomWork | null =
      cw.total > 0 ? { available: customWorkOk, total: cw.total, completed: cw.completed } : customWorkOk ? null : { available: false, total: 0, completed: 0 };

    const today = planFor(assignments, job.id, todayISO);
    const nextStep = nextStepFor(assignments, job.id, todayISO);
    const activity = latestActivity({
      sessions: sessionsOut.rows,
      customSessions: customSessionsOut.rows,
      crewRecords: crewRecordsOut.rows,
      dailyLogs: dailyLogsOut.rows,
      projectId: job.id,
    });
    const activeToday = hasActivityOn({
      sessions: sessionsOut.rows,
      customSessions: customSessionsOut.rows,
      crewRecords: crewRecordsOut.rows,
      dailyLogs: dailyLogsOut.rows,
      projectId: job.id,
      dayISO: todayISO,
    });

    const readiness = readinessById.get(job.id);
    const readinessApplicable = relevantForReadiness.includes(job.id);
    const startTime = earliestStartTime(assignments, job.id, todayISO);
    const pastStart = hasPassedStartTime(todayISO, startTime, nowMs);

    const concerns = buildConcerns({
      issues: issuesByProject.get(job.id) ?? [],
      projectId: job.id,
      nowMs,
      names,
      namesOk,
      readinessOpenCount: readiness?.openCount ?? null,
      readinessApplicable,
    });
    const concern =
      concerns.length > 0 ? concerns[0] : !!today && !activeToday && pastStart ? statusUnknownConcern() : null;

    return {
      id: job.id,
      name: job.name,
      jobCode: job.jobCode,
      href: `/projects/${job.id}`,
      isUpcoming: job.isUpcoming,
      scope,
      customWork,
      today,
      nextStep,
      concern,
      concerns,
      lastActivity: activity,
      needsAttention: isAttentionWorthy(concern),
      issuesAvailable: issuesOk,
      scheduleAvailable: scheduleOk,
      activityAvailable: activityOk,
      readinessAvailable: scheduleOk && (readinessApplicable ? (readiness?.ok ?? false) : true),
    };
  });

  const changes = buildMeaningfulChanges({
    issues,
    assignments,
    dailyLogs: dailyLogsOut.rows,
    jobsById: new Map(allJobs.map((j) => [j.id, j])),
    sinceISO: yesterdayStartISO,
  });

  return {
    generatedAt: new Date(nowMs).toISOString(),
    rows: sortJobRows(rows),
    changes,
    sources: {
      scope: scopeOk,
      issues: issuesOk,
      schedule: scheduleOk,
      customWork: customWorkOk,
      dailyLogs: dailyLogsOk,
      sessions: sessionsOk,
      readiness: readinessOk,
    },
    scopeGaps,
  };
}

// ----------------------------------------------------- meaningful changes

/**
 * Grouped, sourced, dated — every line links to its source and carries a
 * REAL recorded timestamp (never Date.now() standing in for one). Custom
 * and opening completion counts are deliberately absent: neither source
 * here can establish a distinct installed-unit count or an installation
 * timestamp (finding 7) — that category is omitted, not guessed at.
 */
export function buildMeaningfulChanges(args: {
  issues: Issue[];
  assignments: StrictAssignment[];
  dailyLogs: DailyLogRow[];
  jobsById: Map<string, { name: string; jobCode: string }>;
  sinceISO: string;
}): JobsOverviewChange[] {
  const { issues, assignments, dailyLogs, jobsById, sinceISO } = args;
  const since = Date.parse(sinceISO);
  const out: JobsOverviewChange[] = [];
  const jobLabel = (id: string) => {
    const j = jobsById.get(id);
    return j ? j.name || j.jobCode : id;
  };

  for (const i of issues) {
    if (!i.project_id || !jobsById.has(i.project_id)) continue;
    if (Date.parse(i.created_at) >= since) {
      out.push({
        id: `issue-new-${i.id}`,
        projectId: i.project_id,
        jobLabel: jobLabel(i.project_id),
        text: `New ${i.urgency !== "normal" ? `${i.urgency} ` : ""}issue reported — ${KIND_LABELS[i.kind] ?? i.kind}`,
        atISO: i.created_at,
        href: `/issues?issue=${i.id}`,
        kind: "issueNew",
        issueKind: i.kind,
      });
    }
    if (i.status === "resolved" && i.resolved_at && Date.parse(i.resolved_at) >= since) {
      out.push({
        id: `issue-resolved-${i.id}`,
        projectId: i.project_id,
        jobLabel: jobLabel(i.project_id),
        text: `Issue resolved — ${KIND_LABELS[i.kind] ?? i.kind}`,
        atISO: i.resolved_at,
        href: `/issues?issue=${i.id}`,
        kind: "issueResolved",
        issueKind: i.kind,
      });
    }
  }

  for (const a of assignments) {
    if (!jobsById.has(a.project_id) || !isScheduledEvidence(a)) continue;
    if (a.published_at && Date.parse(a.published_at) >= since) {
      out.push({
        id: `assignment-published-${a.id}`,
        projectId: a.project_id,
        jobLabel: jobLabel(a.project_id),
        text: `Crew plan published for ${agendaDayLabel(a.start_date)}`,
        atISO: a.published_at,
        href: `/projects/${a.project_id}?tab=dispatch`,
        kind: "schedulePublished",
        dateISO: a.start_date,
      });
    } else if (
      a.published_at &&
      Date.parse(a.updated_at) >= since &&
      Date.parse(a.updated_at) - Date.parse(a.published_at) > SCHEDULE_EDIT_THRESHOLD_MS
    ) {
      out.push({
        id: `assignment-changed-${a.id}`,
        projectId: a.project_id,
        jobLabel: jobLabel(a.project_id),
        text: `Crew plan edited for ${agendaDayLabel(a.start_date)}`,
        atISO: a.updated_at,
        href: `/projects/${a.project_id}?tab=dispatch`,
        kind: "scheduleChanged",
        dateISO: a.start_date,
      });
    }
  }

  for (const log of dailyLogs) {
    if (!jobsById.has(log.project_id)) continue;
    if (Date.parse(log.created_at) >= since) {
      out.push({
        id: `log-${log.id}`,
        projectId: log.project_id,
        jobLabel: jobLabel(log.project_id),
        text: `Daily log filed for ${log.log_date}${log.headline ? ` — ${log.headline}` : ""}`,
        atISO: log.created_at,
        href: `/projects/${log.project_id}?tab=logs`,
        kind: "dailyLog",
        dateISO: log.log_date,
        headline: log.headline ?? undefined,
      });
    }
  }

  return out.sort((a, b) => Date.parse(b.atISO) - Date.parse(a.atISO));
}
