// Summon (owner, 2026-08-14): call up to 8 helpers onto a heavy window.
// Answering clocks the helper on (their own timer row, like flashing) and
// pays 10 points instantly; Complete stamps their minutes; the window's
// true cost is lead time + every helper's time. Reads are open; every
// write goes through a security-definer RPC.

import { supabase } from "../supabase";

export interface Summon {
  id: string;
  project_id: string;
  opening_id: string;
  requested_by: string;
  needed: number;
  status: "open" | "covered" | "closed";
  created_at: string;
  closed_at: string | null;
  /** When the hands are needed. Null = "now" (pre-ETA summons). */
  needed_at?: string | null;
  /** Optional plain-words why ("second story, no elevator"). */
  note?: string | null;
  requester?: { display_name: string | null } | null;
  /** Embedded for the landing strip — absent on older reads, so optional. */
  project?: { job_code: string | null } | null;
  opening?: { opening_code: string | null } | null;
  helpers?: Pick<SummonHelper, "profile_id" | "completed_at" | "canceled_at">[] | null;
}

export interface SummonHelper {
  id: string;
  summon_id: string;
  profile_id: string;
  joined_at: string;
  completed_at: string | null;
  /** Backed out ("Can't make it") — seat reopened, points reversed. */
  canceled_at?: string | null;
  minutes: number | null;
  helper?: { display_name: string | null } | null;
}

function isMissingTableError(e: { code?: string; message?: string } | null): boolean {
  return Boolean(
    e && (e.code === "42P01" || /relation .* does not exist/i.test(e.message ?? "")),
  );
}

const SUMMON_SELECT =
  "*, requester:profiles!summons_requested_by_fkey(display_name), project:projects(job_code), opening:project_openings(opening_code), helpers:summon_helpers(profile_id, completed_at, canceled_at)";

/** Live (open/covered) summons on a job — Dispatch indicator + the sheet. */
export async function listLiveSummons(projectId: string): Promise<Summon[]> {
  const { data, error } = await supabase
    .from("summons")
    .select(SUMMON_SELECT)
    .eq("project_id", projectId)
    .in("status", ["open", "covered"])
    .order("created_at");
  if (isMissingTableError(error)) return [];
  if (error) throw error;
  return (data ?? []) as unknown as Summon[];
}

/**
 * Every live summon on every job — the landing pages' call-for-hands strip
 * (owner ask, 2026-08-18): a live summon should find helpers where they
 * already are, My Work and Home, not only on the window's own sheet. One
 * read, no filter beyond "live": a call for hands is never quietly hidden.
 */
export async function listAllLiveSummons(): Promise<Summon[]> {
  const { data, error } = await supabase
    .from("summons")
    .select(SUMMON_SELECT)
    .in("status", ["open", "covered"])
    .order("created_at");
  if (isMissingTableError(error)) return [];
  if (error) throw error;
  return (data ?? []) as unknown as Summon[];
}

export async function listSummonHelpers(summonId: string): Promise<SummonHelper[]> {
  const { data, error } = await supabase
    .from("summon_helpers")
    .select("*, helper:profiles!summon_helpers_profile_id_fkey(display_name)")
    .eq("summon_id", summonId)
    .order("joined_at");
  if (isMissingTableError(error)) return [];
  if (error) throw error;
  return (data ?? []) as unknown as SummonHelper[];
}

export async function createSummon(
  openingId: string,
  needed: number,
  leadMinutes?: number | null,
  note?: string | null,
): Promise<Summon> {
  const { data, error } = await supabase.rpc("create_summon", {
    p_opening_id: openingId,
    p_needed: needed,
    p_lead_minutes: leadMinutes ?? null,
    p_note: note?.trim() || null,
  });
  if (error) throw error;
  return data as Summon;
}

export async function answerSummon(summonId: string): Promise<SummonHelper> {
  const { data, error } = await supabase.rpc("answer_summon", {
    p_summon_id: summonId,
  });
  if (error) throw error;
  return data as SummonHelper;
}

export async function completeSummonHelp(summonId: string): Promise<SummonHelper> {
  const { data, error } = await supabase.rpc("complete_summon_help", {
    p_summon_id: summonId,
  });
  if (error) throw error;
  return data as SummonHelper;
}

/** Back out of a summon you answered — seat reopens, points reverse. */
export async function cancelSummonHelp(summonId: string): Promise<SummonHelper> {
  const { data, error } = await supabase.rpc("cancel_summon_help", {
    p_summon_id: summonId,
  });
  if (error) throw error;
  return data as SummonHelper;
}

export async function closeSummon(summonId: string): Promise<Summon> {
  const { data, error } = await supabase.rpc("close_summon", {
    p_summon_id: summonId,
  });
  if (error) throw error;
  return data as Summon;
}

// ------------------------------------------------------------- pure bits

/** Helper man-minutes on a summon: completed rows as stamped, open rows
 * live against `now` — the number the window's true cost breakdown shows. */
export function summonHelperMinutes(
  helpers: readonly Pick<SummonHelper, "joined_at" | "completed_at" | "minutes" | "canceled_at">[],
  now: number = Date.now(),
): number {
  let total = 0;
  for (const h of helpers) {
    if (h.canceled_at) {
      continue; // backed out — their 0 minutes stay out of the total
    }
    if (h.minutes != null) {
      total += h.minutes;
    } else if (!h.completed_at) {
      total += Math.max(0, Math.min(480, Math.floor((now - Date.parse(h.joined_at)) / 60000)));
    }
  }
  return total;
}

/**
 * The countdown every viewer reads on a timed summon: "by 1:05 PM · 22 min"
 * while it's ahead, "needed NOW" once the time has passed, null for an
 * untimed summon (the pre-ETA "come when you can").
 */
export function summonEtaLine(
  neededAt: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!neededAt) return null;
  const at = Date.parse(neededAt);
  if (Number.isNaN(at)) return null;
  const when = new Date(at).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  const minsLeft = Math.round((at - now) / 60_000);
  if (minsLeft <= 0) return "needed NOW";
  return `by ${when} · ${minsLeft} min`;
}

/**
 * The landing strip's one-line story for a live summon: who needs hands, how
 * many, where — in the crew's words. `mine` flips the voice ("You called
 * for…") so your own summon reads as confirmation, not as somebody else's
 * emergency.
 */
export function summonStripLine(
  s: Pick<Summon, "needed" | "status" | "requester" | "project" | "opening" | "needed_at">,
  mine: boolean,
  now: number = Date.now(),
): string {
  const hands = `${s.needed} ${s.needed === 1 ? "hand" : "hands"}`;
  const head = mine
    ? `You called for ${hands}`
    : `${s.requester?.display_name ?? "Someone"} needs ${hands}`;
  const where = [
    s.project?.job_code ?? null,
    s.opening?.opening_code ? `#${s.opening.opening_code}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  let base = where ? `${head} — ${where}` : head;
  const eta = summonEtaLine(s.needed_at, now);
  if (eta) base = `${base} · ${eta}`;
  return s.status === "covered" ? `${base} (covered)` : base;
}

/**
 * Has this viewer answered this summon and not backed out? Drives the strip
 * row ("You answered — on the way" instead of an Answer pill) so a person
 * who already committed is never re-asked (owner report, 2026-08-19).
 */
export function iAnswered(
  s: Pick<Summon, "helpers">,
  myProfileId: string | null | undefined,
): boolean {
  if (!myProfileId) return false;
  return (s.helpers ?? []).some(
    (h) => h.profile_id === myProfileId && !h.canceled_at,
  );
}

/**
 * Owner rule: anything bigger than 4040 (4'0" × 4'0") likely needs a
 * summon — the install-start prompt fires when EITHER side beats 48".
 * Declinable by design (owner pick).
 */
export function sizeSuggestsSummon(
  widthIn: number | null | undefined,
  heightIn: number | null | undefined,
): boolean {
  return (widthIn ?? 0) > 48 || (heightIn ?? 0) > 48;
}
