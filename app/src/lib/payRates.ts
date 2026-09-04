// Wave Z, Z3: what people are actually paid.
//
// Labor cost used to be hours × a hardcoded role table (costing.ts's
// HOURLY_RATE — installer 35, foreman 50, supervisor 60, owner 75). Every
// margin the owner has ever read was priced off those four guesses. This module
// is the real numbers, and the rule for reading them: a rate is a HISTORY, and
// the one that counts for a shift is the one that was in force on the day that
// shift happened. A raise in March must never reprice January.
//
// Reads go through pay_rates' own RLS (owner, or somebody granted "Sees pay
// rates"); writes go through the owner-only set_pay_rate RPC. Both degrade to
// empty on a database that has the app but not yet 20260978000000 — a Costing
// screen with no rates falls back to the role table and says so on the line.

import { supabase } from "./supabase";
import { isMissingTable } from "./schemaErrors";

export interface PayRate {
  id: string;
  profileId: string;
  hourlyCents: number;
  /** The day this rate starts, "YYYY-MM-DD". There is no end date: a rate runs
   * until the next one begins. */
  effectiveFrom: string;
  setBy: string | null;
  createdAt: string;
}

interface PayRateRow {
  id: string;
  profile_id: string;
  hourly_cents: number;
  effective_from: string;
  set_by: string | null;
  created_at: string;
}

const PAY_RATE_COLS = "id, profile_id, hourly_cents, effective_from, set_by, created_at";

function mapRow(row: PayRateRow): PayRate {
  return {
    id: row.id,
    profileId: row.profile_id,
    hourlyCents: row.hourly_cents,
    effectiveFrom: row.effective_from,
    setBy: row.set_by,
    createdAt: row.created_at,
  };
}

// ------------------------------------------------------------------ pure

/**
 * Group rates by person, newest start date FIRST. `rateInEffect` relies on that
 * order, so sorting happens once here rather than on every shift priced.
 *
 * Dates are plain "YYYY-MM-DD" strings, which compare correctly as strings —
 * no Date objects, so no timezone can move a boundary between building the
 * index and reading it.
 */
export function indexPayRates(rates: PayRate[]): Map<string, PayRate[]> {
  const out = new Map<string, PayRate[]>();
  for (const r of rates) {
    const list = out.get(r.profileId);
    if (list) list.push(r);
    else out.set(r.profileId, [r]);
  }
  for (const list of out.values()) {
    list.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : a.effectiveFrom > b.effectiveFrom ? -1 : 0));
  }
  return out;
}

/**
 * The rate in force on `day` ("YYYY-MM-DD"): the newest one that started on or
 * before it. Null when this person had no rate yet on that day — which is a
 * real answer, not a missing one, and is what makes Costing say "estimated".
 *
 * `rates` must be newest-first (indexPayRates). A rate whose start date is in
 * the FUTURE relative to the shift is skipped, which is the whole point of
 * storing history: a raise dated next Monday does not reprice last Friday.
 */
export function rateInEffect(rates: PayRate[] | undefined, day: string): PayRate | null {
  if (!rates || rates.length === 0 || !day) return null;
  for (const r of rates) {
    if (r.effectiveFrom <= day) return r;
  }
  return null;
}

/**
 * The calendar day a timestamp belongs to, in the READER's timezone — the same
 * convention dailyLogs.ts uses for "what happened on this job today". The
 * office is in the company's own timezone, so this is the company day; taking
 * the UTC slice instead would file an evening punch under tomorrow.
 */
export function localDayOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/** "3250" -> "$32.50". Cents in, money out — never a float in between. */
export function formatRate(hourlyCents: number): string {
  const sign = hourlyCents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(hourlyCents));
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * A typed hourly rate ("32.50", "$32.50", " 32 ") as whole cents, or null when
 * it is not a rate at all. Rounds to the cent rather than trusting float
 * arithmetic: 32.55 * 100 is 3254.9999999999995 in IEEE754.
 */
export function parseRateDollars(text: string): number | null {
  const cleaned = text.replace(/[$,\s]/g, "");
  if (!cleaned || !/^\d*\.?\d*$/.test(cleaned) || cleaned === ".") return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

// ------------------------------------------------------------------ data

/** Every rate on file, newest first. Empty for anyone without the pay grant —
 * RLS answers with no rows rather than an error, so the screen just shows none. */
export async function listPayRates(profileId?: string): Promise<PayRate[]> {
  let query = supabase
    .from("pay_rates")
    .select(PAY_RATE_COLS)
    .order("effective_from", { ascending: false });
  if (profileId) query = query.eq("profile_id", profileId);
  const { data, error } = await query;
  if (isMissingTable(error, "pay_rates")) return [];
  if (error) throw error;
  return ((data ?? []) as PayRateRow[]).map(mapRow);
}

/** Owner-only, refused in SQL. `effectiveFrom` defaults to today server-side. */
export async function setPayRate(
  profileId: string,
  hourlyCents: number,
  effectiveFrom?: string,
): Promise<void> {
  const { error } = await supabase.rpc("set_pay_rate", {
    p_profile_id: profileId,
    p_hourly_cents: hourlyCents,
    p_effective_from: effectiveFrom ?? null,
  });
  if (error) throw error;
}
