// Client seam for the AI spend cap. The enforcement itself is entirely
// server-side (see supabase/migrations/…_ai_spend_limits.sql and
// supabase/functions/_shared/spendGuard.ts) — nothing here is a control, and
// nothing here can be bypassed by editing the page. This module only reads the
// meter for the owner's screen and writes the two numbers an owner may change.
//
// The pure pieces (formatting, the reasoning shown next to each limit, the
// projection maths) live here rather than in the component so they are testable
// without a browser or a database.
import { supabase, supabaseConfigured } from "./supabase";
import { costMicros } from "../../../supabase/functions/_shared/spendGuard.ts";
import { formatApiError } from "./errors";

export { costMicros };

export type SpendMinRole = "installer" | "foreman" | "supervisor" | "owner";

export interface AiSpendLimits {
  per_user_daily_calls: number;
  monthly_cap_cents: number;
  content_multiplier: number;
  min_role: SpendMinRole;
  alert_at_pct: number;
  enforced: boolean;
  timezone: string;
  updated_at: string | null;
}

export interface AiSpendMonth {
  usage_month: string;
  calls: number;
  spent_micros: number;
  reserved_micros: number;
  cap_micros: number;
}

export interface AiSpendPerson {
  user_id: string | null;
  display_name: string;
  role: string;
  calls: number;
  cost_micros: number;
  blocked: number;
  calls_today: number;
}

export interface AiSpendFunction {
  function_name: string;
  calls: number;
  cost_micros: number;
}

export interface AiSpendAlert {
  level: "warn" | "cap";
  reserved_micros: number;
  cap_micros: number;
  created_at: string;
}

export interface AiSpendOverview {
  can_edit: boolean;
  limits: AiSpendLimits;
  month: AiSpendMonth;
  people: AiSpendPerson[];
  functions: AiSpendFunction[];
  alerts: AiSpendAlert[];
}

/** Micro-dollars → "$1.37". Anything under a cent reads as "under 1¢" rather
 * than "$0.00", because "$0.00" makes a real cost look like no cost. */
export function formatMicros(micros: number): string {
  const value = Math.max(0, Number(micros) || 0);
  if (value === 0) return "$0.00";
  if (value < 10_000) return "under 1¢";
  return `$${(value / 1_000_000).toFixed(2)}`;
}

/** Whole cents → "$150". Used for the ceiling, which is always a round number. */
export function formatCents(cents: number): string {
  const value = Math.max(0, Number(cents) || 0);
  return value % 100 === 0
    ? `$${value / 100}`
    : `$${(value / 100).toFixed(2)}`;
}

/** How far through the month's budget the company is, 0–100+. */
export function budgetPct(month: Pick<AiSpendMonth, "reserved_micros" | "cap_micros">): number {
  const cap = Number(month.cap_micros) || 0;
  if (cap <= 0) return 0;
  return Math.round((Number(month.reserved_micros) || 0) / cap * 100);
}

/**
 * The one sentence at the top of the screen. Deliberately answers the owner's
 * actual question ("am I about to be surprised?") rather than reporting numbers.
 */
export function budgetHeadline(
  month: Pick<AiSpendMonth, "reserved_micros" | "cap_micros" | "spent_micros">,
  enforced: boolean,
): string {
  const pct = budgetPct(month);
  if (!enforced) {
    return `${formatMicros(month.spent_micros)} spent this month. The cap is switched off, so nothing is being blocked.`;
  }
  if (pct >= 100) {
    return `The monthly ceiling is reached. Crew are still getting answers from the company brain — raise the ceiling below to switch the AI back on.`;
  }
  if (pct >= 80) {
    return `${formatMicros(month.spent_micros)} spent this month — most of the way to the ceiling.`;
  }
  return `${formatMicros(month.spent_micros)} spent this month. Nothing is being blocked.`;
}

/**
 * What a single account could spend in a day at the daily limit, which is the
 * number that actually matters: it is the worst case for a leaked login.
 */
export function worstCasePerUserPerDay(dailyCalls: number): number {
  // 12,000 tokens in and 300 out on Claude — the shape of a real Ask question.
  return Math.max(0, dailyCalls) * costMicros("claude-sonnet-5", 12_000, 300);
}

export async function loadAiSpendOverview(): Promise<AiSpendOverview | null> {
  if (!supabaseConfigured) return null;
  const { data, error } = await supabase.rpc("ai_spend_overview");
  if (error) throw new Error(formatApiError(error));
  return (data ?? null) as AiSpendOverview | null;
}

export interface AiSpendLimitPatch {
  perUserDailyCalls?: number;
  monthlyCapCents?: number;
  minRole?: SpendMinRole;
  enforced?: boolean;
}

/** Owner-only; the database re-checks the caller's role and refuses otherwise. */
export async function saveAiSpendLimits(
  patch: AiSpendLimitPatch,
): Promise<AiSpendOverview> {
  const { data, error } = await supabase.rpc("ai_spend_set_limits", {
    p_per_user_daily_calls: patch.perUserDailyCalls ?? null,
    p_monthly_cap_cents: patch.monthlyCapCents ?? null,
    p_min_role: patch.minRole ?? null,
    p_enforced: patch.enforced ?? null,
  });
  if (error) throw new Error(formatApiError(error));
  return data as AiSpendOverview;
}
