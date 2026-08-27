// SESSIONS (CONTEXT.md, spec .scratch/sessions/): the atomic time record —
// one installer, one unit, a start, a stop. This lib is the client face of
// the unit_sessions RPCs plus the pure math the screens share. All writes
// go through security-definer RPCs; the shift/summon transitions happen in
// database triggers and need no client calls at all.

import { supabase } from "../supabase";

export interface UnitSession {
  id: string;
  opening_id: string;
  profile_id: string;
  role: "install" | "helper";
  is_rework: boolean;
  started_at: string;
  ended_at: string | null;
  end_reason:
    | "finish"
    | "block"
    | "break"
    | "clock_out"
    | "handoff"
    | "complete"
    | "auto_closed"
    | null;
  block_reason: string | null;
  block_issue_id: string | null;
  created_at: string;
  /** The mark, joined in only by listProjectSessions (daily logs, L2) — every
   * other reader here already has the opening in hand and has no use for it. */
  opening?: { project_id: string; opening_code: string } | null;
}

function isMissingTableError(e: { code?: string; message?: string } | null): boolean {
  return Boolean(
    e && (e.code === "42P01" || /relation .* does not exist/i.test(e.message ?? "")),
  );
}

/** The four glossary reasons, in the order the Block sheet shows them. */
export const BLOCK_REASONS = [
  "Missing hardware",
  "Wrong glass",
  "Opening not ready",
  "Waiting on equipment",
] as const;

/** The chain's grace: how long a hand-off stays redirectable. */
export const CHAIN_GRACE_MS = 5 * 60 * 1000;

export async function startUnitSession(
  openingId: string,
  role: "install" | "helper" = "install",
): Promise<UnitSession> {
  const { data, error } = await supabase.rpc("start_unit_session", {
    p_opening_id: openingId,
    p_role: role,
  });
  if (error) throw error;
  return data as UnitSession;
}

export async function blockUnit(args: {
  openingId: string;
  reason: string;
  issueId?: string | null;
  nextOpeningId?: string | null;
}): Promise<void> {
  const { error } = await supabase.rpc("block_unit", {
    p_opening_id: args.openingId,
    p_reason: args.reason,
    p_issue_id: args.issueId ?? null,
    p_next_opening_id: args.nextOpeningId ?? null,
  });
  if (error) throw error;
}

export async function reattributeSession(openingId: string): Promise<UnitSession> {
  const { data, error } = await supabase.rpc("reattribute_session", {
    p_opening_id: openingId,
  });
  if (error) throw error;
  return data as UnitSession;
}

/** My open session, if any — the "you're on window N" truth. */
export async function getMyOpenSession(profileId: string): Promise<UnitSession | null> {
  const { data, error } = await supabase
    .from("unit_sessions")
    .select("*")
    .eq("profile_id", profileId)
    .is("ended_at", null)
    .maybeSingle();
  if (isMissingTableError(error)) return null;
  if (error) throw error;
  return (data as UnitSession) ?? null;
}

/**
 * A project's sessions (Dispatch's blocked strip and live cards, and the
 * daily log draft's finished/still-open marks — L2). opening_code rides
 * along in the join so a caller than needs the mark (not just the
 * project-scoping filter) doesn't need a second query.
 */
export async function listProjectSessions(projectId: string): Promise<UnitSession[]> {
  const { data, error } = await supabase
    .from("unit_sessions")
    .select("*, opening:project_openings!inner(project_id, opening_code)")
    .eq("opening.project_id", projectId)
    .order("started_at", { ascending: false })
    .limit(500);
  if (isMissingTableError(error)) return [];
  if (error) throw error;
  return (data ?? []) as unknown as UnitSession[];
}

/** One unit_sessions row, scoped by time instead of by project — just
 * enough for wave C's calendar day panel to tally units finished per job,
 * per day (dayMemory.ts's DayMemorySession). */
export interface RangeSession {
  project_id: string;
  opening_id: string;
  started_at: string;
  end_reason: UnitSession["end_reason"];
}

/**
 * Every session across every job whose started_at falls in [fromIso,
 * toIso) — unlike listProjectSessions (one job, newest 500) this scopes by
 * time, since the day panel needs one date across every job at once.
 * Fetched once per visible month, the same "one range read beats one read
 * per cell" shape dailyLogs.ts's listSessionProjectDaysInRange already
 * uses for the coverage line.
 */
export async function listSessionsInRange(fromIso: string, toIso: string): Promise<RangeSession[]> {
  const { data, error } = await supabase
    .from("unit_sessions")
    .select("opening_id, started_at, end_reason, opening:project_openings!inner(project_id)")
    .gte("started_at", fromIso)
    .lt("started_at", toIso);
  if (isMissingTableError(error)) return [];
  if (error) throw error;
  return ((data ?? []) as unknown as {
    opening_id: string;
    started_at: string;
    end_reason: UnitSession["end_reason"];
    opening: { project_id: string } | null;
  }[])
    .filter((r) => r.opening?.project_id)
    .map((r) => ({
      project_id: r.opening!.project_id,
      opening_id: r.opening_id,
      started_at: r.started_at,
      end_reason: r.end_reason,
    }));
}

// ------------------------------------------------------------- pure bits

/** Minutes of one session, live against `now` when open, 480-capped —
 * the same arithmetic the server uses at finish. */
export function sessionMinutes(
  s: Pick<UnitSession, "started_at" | "ended_at">,
  now: number = Date.now(),
): number {
  const start = Date.parse(s.started_at);
  const end = s.ended_at ? Date.parse(s.ended_at) : now;
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.max(0, Math.min(480, Math.floor((end - start) / 60000)));
}

/** How much of the chain's 5-minute redirect window remains. 0 = locked. */
export function chainGraceRemainingMs(
  sessionStartedAt: string,
  now: number = Date.now(),
): number {
  const start = Date.parse(sessionStartedAt);
  if (Number.isNaN(start)) return 0;
  return Math.max(0, CHAIN_GRACE_MS - (now - start));
}

/**
 * A project's BLOCKED units, derived (nothing stored): the openings whose
 * most recent session ended in a block with no later session. Sessions
 * must be sorted newest-first (listProjectSessions order).
 */
export function blockedUnits(
  sessions: readonly UnitSession[],
): { openingId: string; reason: string | null; issueId: string | null }[] {
  const seen = new Set<string>();
  const out: { openingId: string; reason: string | null; issueId: string | null }[] = [];
  for (const s of sessions) {
    if (seen.has(s.opening_id)) continue;
    seen.add(s.opening_id);
    // Newest session for this opening decides its state.
    if (s.ended_at && s.end_reason === "block") {
      out.push({
        openingId: s.opening_id,
        reason: s.block_reason,
        issueId: s.block_issue_id,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- redo

export interface UnitRedo {
  id: string;
  opening_id: string;
  pressed_by: string;
  reason: string;
  pressed_at: string;
  resolved_at: string | null;
  presser?: { display_name: string | null } | null;
  /** The mark — joined in only by listProjectRedosAll (daily logs, L2). */
  opening?: { project_id: string; opening_code: string } | null;
}

/** The Redo button (CONTEXT.md): any installer, reason required, foreman
 * notified never asked. The original install record stands. */
export async function pressRedo(openingId: string, reason: string): Promise<UnitRedo> {
  const { data, error } = await supabase.rpc("press_redo", {
    p_opening_id: openingId,
    p_reason: reason,
  });
  if (error) throw error;
  return data as UnitRedo;
}

/** A project's OPEN redos — the badge source for lists and Dispatch. */
export async function listOpenRedos(projectId: string): Promise<UnitRedo[]> {
  const { data, error } = await supabase
    .from("unit_redos")
    .select(
      "*, presser:profiles!unit_redos_pressed_by_fkey(display_name), opening:project_openings!inner(project_id)",
    )
    .eq("opening.project_id", projectId)
    .is("resolved_at", null);
  if (isMissingTableError(error)) return [];
  if (error) throw error;
  return (data ?? []) as unknown as UnitRedo[];
}

/**
 * EVERY redo ever pressed on a project, resolved or not (the daily log
 * draft's "redos filed that day" needs a redo pressed and fixed inside the
 * same day just as much as one still open — listOpenRedos would drop it).
 */
export async function listProjectRedosAll(projectId: string): Promise<UnitRedo[]> {
  const { data, error } = await supabase
    .from("unit_redos")
    .select(
      "*, presser:profiles!unit_redos_pressed_by_fkey(display_name), opening:project_openings!inner(project_id, opening_code)",
    )
    .eq("opening.project_id", projectId)
    .order("pressed_at", { ascending: false })
    .limit(500);
  if (isMissingTableError(error)) return [];
  if (error) throw error;
  return (data ?? []) as unknown as UnitRedo[];
}

/**
 * Sessions for a set of openings, newest first — the block-state source
 * for My Work and the next-window picker (blockedUnits expects newest
 * first). One query regardless of how many jobs the openings span.
 */
export async function listSessionsForOpenings(
  openingIds: string[],
): Promise<UnitSession[]> {
  if (openingIds.length === 0) return [];
  const { data, error } = await supabase
    .from("unit_sessions")
    .select("*")
    .in("opening_id", openingIds)
    .order("started_at", { ascending: false });
  if (isMissingTableError(error)) return [];
  if (error) throw error;
  return (data ?? []) as UnitSession[];
}

/** One unit's sessions, oldest first — the history/breakdown source. */
export async function listOpeningSessions(openingId: string): Promise<UnitSession[]> {
  const { data, error } = await supabase
    .from("unit_sessions")
    .select("*")
    .eq("opening_id", openingId)
    .order("started_at");
  if (isMissingTableError(error)) return [];
  if (error) throw error;
  return (data ?? []) as UnitSession[];
}

/**
 * LABOR-MINUTES breakdown (CONTEXT.md): every session (install + helper)
 * plus the unit's flash-run minutes — with rework kept as its own line,
 * separate data by the owner's rule.
 */
export function laborBreakdown(
  sessions: readonly UnitSession[],
  flashMinutes: number | null,
  now: number = Date.now(),
): { installMin: number; helperMin: number; reworkMin: number; flashMin: number; totalMin: number } {
  let installMin = 0;
  let helperMin = 0;
  let reworkMin = 0;
  for (const s of sessions) {
    const m = sessionMinutes(s, now);
    if (s.is_rework) reworkMin += m;
    else if (s.role === "helper") helperMin += m;
    else installMin += m;
  }
  const flashMin = Math.max(0, flashMinutes ?? 0);
  return {
    installMin,
    helperMin,
    reworkMin,
    flashMin,
    totalMin: installMin + helperMin + reworkMin + flashMin,
  };
}

/** Rework rate: units with any redo ever, over units finished. */
export function reworkRate(redoUnitCount: number, finishedUnitCount: number): number | null {
  if (finishedUnitCount <= 0) return null;
  return redoUnitCount / finishedUnitCount;
}
