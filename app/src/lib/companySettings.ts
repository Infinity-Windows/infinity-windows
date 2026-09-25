// The one company settings row (Wave K, K2, migration 20260976000000).
//
// Today it holds exactly one thing: when the evening "Still on the job?" nudge
// goes out, and whether it goes out at all. It is a row rather than a constant
// because the hour is the foreman's call — a crew that starts at 5am wants to be
// asked at 3:30pm, and nobody should need a code release to say so.
//
// Reads degrade to null on a database that has not applied the migration yet
// (the house rule for a feature that ships ahead of its migration): the screen
// simply doesn't offer the control. Writes go through the foreman+ RPC — the
// table has no write policy at all.

import { supabase } from "./supabase";
import { isMissingColumn, isMissingTable } from "./schemaErrors";

export interface CompanySettings {
  id: number;
  /** "17:30:00" as Postgres renders a `time`. */
  evening_nudge_local_time: string;
  evening_nudge_enabled: boolean;
  /**
   * Release 1 (crew redesign K-X2, 20261031000000): the owner's master switch
   * for the new design. Off = everyone is on the classic screens at once,
   * whatever they chose. Optional because a database that predates the column
   * answers rows without it, and "unknown" must read as ON (see design.ts).
   */
  new_design_r1_enabled?: boolean;
  /**
   * K1.3 / Q69: the company-local day from which paid time starts at the
   * Start day tap (before the toolbox talk is signed) instead of after it.
   * Null = the rule is off and today's timing applies. One date for everyone;
   * never applied to a shift already recorded.
   */
  paid_time_from_start_day_on?: string | null;
}

const SETTINGS_COLS = "id, evening_nudge_local_time, evening_nudge_enabled";
// The Release 1 columns, asked for first and dropped on a database that has
// not applied 20261031000000 yet — the same "narrow once, never crash" shape
// profiles' optional columns use. The backend deploys as its own workflow and
// has silently failed before; a settings read failing over a column would
// take the design switch AND the evening nudge control down together.
const R1_COLS = ", new_design_r1_enabled, paid_time_from_start_day_on";
let settingsCols = SETTINGS_COLS + R1_COLS;

export async function getCompanySettings(): Promise<CompanySettings | null> {
  let res = await supabase
    .from("company_settings")
    .select(settingsCols)
    .eq("id", 1)
    .maybeSingle();
  if (res.error && settingsCols !== SETTINGS_COLS && isMissingColumn(res.error)) {
    settingsCols = SETTINGS_COLS;
    res = await supabase
      .from("company_settings")
      .select(settingsCols)
      .eq("id", 1)
      .maybeSingle();
  }
  if (isMissingTable(res.error, "company_settings")) return null;
  if (res.error) throw res.error;
  return (res.data as unknown as CompanySettings | null) ?? null;
}

/**
 * Owner only (server-checked): turn a release's new design on or off for
 * everyone at once. `release` is the migration's own vocabulary ("r1").
 */
export async function setNewDesignSwitch(
  release: "r1",
  enabled: boolean,
): Promise<CompanySettings> {
  const { data, error } = await supabase.rpc("set_new_design_switch", {
    p_release: release,
    p_enabled: enabled,
  });
  if (error) throw error;
  return data as CompanySettings;
}

/**
 * Owner only (server-checked): the day the paid-time rule starts, as
 * "YYYY-MM-DD", or null to switch the rule off. Never touches a recorded shift.
 */
export async function setPaidTimeRuleDate(
  onDate: string | null,
): Promise<CompanySettings> {
  const { data, error } = await supabase.rpc("set_paid_time_rule_date", {
    p_on: onDate,
  });
  if (error) throw error;
  return data as CompanySettings;
}

/** Foreman+ (server-checked). `localTime` is "HH:MM" from a time input. */
export async function setEveningNudgeTime(
  localTime: string,
  enabled?: boolean,
): Promise<CompanySettings> {
  const { data, error } = await supabase.rpc("set_evening_nudge_time", {
    p_local_time: localTime,
    p_enabled: enabled ?? null,
  });
  if (error) throw error;
  return data as CompanySettings;
}

/** "17:30:00" → "17:30", the value an `<input type="time">` wants. */
export function toTimeInput(value: string | null | undefined): string {
  if (!value) return "";
  return value.slice(0, 5);
}

/**
 * "17:30" → "5:30 PM", read back to a person. Built off a fixed date so it is
 * only ever formatting a clock face, never converting a timezone.
 */
export function formatLocalTime(value: string | null | undefined): string {
  const hhmm = toTimeInput(value);
  if (!/^\d{2}:\d{2}$/.test(hhmm)) return "—";
  const d = new Date(`2026-01-01T${hhmm}:00`);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
