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
  requester?: { display_name: string | null } | null;
}

export interface SummonHelper {
  id: string;
  summon_id: string;
  profile_id: string;
  joined_at: string;
  completed_at: string | null;
  minutes: number | null;
  helper?: { display_name: string | null } | null;
}

function isMissingTableError(e: { code?: string; message?: string } | null): boolean {
  return Boolean(
    e && (e.code === "42P01" || /relation .* does not exist/i.test(e.message ?? "")),
  );
}

const SUMMON_SELECT =
  "*, requester:profiles!summons_requested_by_fkey(display_name)";

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

export async function createSummon(openingId: string, needed: number): Promise<Summon> {
  const { data, error } = await supabase.rpc("create_summon", {
    p_opening_id: openingId,
    p_needed: needed,
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
  helpers: readonly Pick<SummonHelper, "joined_at" | "completed_at" | "minutes">[],
  now: number = Date.now(),
): number {
  let total = 0;
  for (const h of helpers) {
    if (h.minutes != null) {
      total += h.minutes;
    } else if (!h.completed_at) {
      total += Math.max(0, Math.min(480, Math.floor((now - Date.parse(h.joined_at)) / 60000)));
    }
  }
  return total;
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
