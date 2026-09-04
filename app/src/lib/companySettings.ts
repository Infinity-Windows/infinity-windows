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
import { isMissingTable } from "./schemaErrors";

export interface CompanySettings {
  id: number;
  /** "17:30:00" as Postgres renders a `time`. */
  evening_nudge_local_time: string;
  evening_nudge_enabled: boolean;
}

const SETTINGS_COLS = "id, evening_nudge_local_time, evening_nudge_enabled";

export async function getCompanySettings(): Promise<CompanySettings | null> {
  const { data, error } = await supabase
    .from("company_settings")
    .select(SETTINGS_COLS)
    .eq("id", 1)
    .maybeSingle();
  if (isMissingTable(error, "company_settings")) return null;
  if (error) throw error;
  return (data as CompanySettings | null) ?? null;
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
