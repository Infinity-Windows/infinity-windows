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
import { isMissingColumn, isMissingTable } from "./schemaErrors";

export type PayBasis = "hourly" | "salary_monthly";

export interface PayRate {
  id: string;
  profileId: string;
  hourlyCents: number;
  payBasis?: PayBasis;
  monthlyCents?: number | null;
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
  pay_basis?: PayBasis;
  monthly_cents?: number | null;
  effective_from: string;
  set_by: string | null;
  created_at: string;
}

const LEGACY_PAY_RATE_COLS = "id, profile_id, hourly_cents, effective_from, set_by, created_at";
const PAY_RATE_COLS = "id, profile_id, hourly_cents, pay_basis, monthly_cents, effective_from, set_by, created_at";

function mapRow(row: PayRateRow): PayRate {
  return {
    id: row.id,
    profileId: row.profile_id,
    hourlyCents: row.hourly_cents,
    payBasis: row.pay_basis ?? "hourly",
    monthlyCents: row.monthly_cents ?? null,
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

export function formatCompensation(rate: PayRate): string {
  return rate.payBasis === "salary_monthly"
    ? `${formatRate(rate.monthlyCents ?? 0)}/month · Salary`
    : `${formatRate(rate.hourlyCents)}/hr · Hourly`;
}

/** A salary carries forward month by month until another dated rate replaces it. */
export function salaryForMonth(rates: PayRate[] | undefined, month: string): number | null {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  const rate = rateInEffect(rates, `${month}-01`);
  return rate?.payBasis === "salary_monthly" ? rate.monthlyCents ?? null : null;
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
  const rows: PayRateRow[] = [];
  let expected: number | null = null;
  let columns = PAY_RATE_COLS;
  for (let page = 0; page < 1000; page++) {
    let query = supabase.from("pay_rates").select(columns, {count:"exact"})
      .order("effective_from", {ascending:false}).order("id").range(rows.length,rows.length+999);
    if (profileId) query = query.eq("profile_id",profileId);
    const {data,error,count} = await query;
    if (columns === PAY_RATE_COLS && (isMissingColumn(error,"pay_basis") || isMissingColumn(error,"monthly_cents"))) {
      columns = LEGACY_PAY_RATE_COLS;
      continue;
    }
    if (isMissingTable(error,"pay_rates")) return [];
    if (error) throw error;
    if (typeof count !== "number" || (expected !== null && count !== expected)) throw new Error("Pay records changed. Refresh the page.");
    expected = count;
    if (!data?.length && rows.length < expected) throw new Error("The pay history is incomplete. Refresh the page.");
    rows.push(...(data??[]) as unknown as PayRateRow[]);
    if(rows.length >= expected) {
      if(rows.length !== expected || new Set(rows.map(row=>row.id)).size !== expected) throw new Error("Pay records changed. Refresh the page.");
      return rows.map(mapRow);
    }
  }
  throw new Error("The pay history is too large to load completely.");
}

export async function setCompensation(profileId: string, payBasis: PayBasis, amountCents: number, effectiveFrom: string): Promise<void> {
  const {error} = await supabase.rpc("set_compensation", {
    p_profile_id: profileId, p_pay_basis: payBasis, p_amount_cents: amountCents, p_effective_from: effectiveFrom,
  });
  if (error) throw error;
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
