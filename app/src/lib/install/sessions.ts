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

/** A project's sessions (Dispatch's blocked strip and live cards). */
export async function listProjectSessions(projectId: string): Promise<UnitSession[]> {
  const { data, error } = await supabase
    .from("unit_sessions")
    .select("*, opening:project_openings!inner(project_id)")
    .eq("opening.project_id", projectId)
    .order("started_at", { ascending: false })
    .limit(500);
  if (isMissingTableError(error)) return [];
  if (error) throw error;
  return (data ?? []) as unknown as UnitSession[];
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
