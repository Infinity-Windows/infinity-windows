// Wave S: the client face of the STG Windows & Doors (builder/partner) view.
// Every read here goes through a SECURITY DEFINER projection RPC
// (20260952000000_stg_projection_rpcs.sql) — there is no direct table
// query anywhere in this file, on purpose (THE WALL, S1: "no partner-facing
// view queries a crew table directly from the client"). Reads degrade to an
// empty/neutral shape if the RPC isn't live yet (isMissingFunction), the
// same ship-ahead-of-migration pattern the rest of the app uses — but the
// REAL boundary is server-side regardless: a missing function just means an
// empty screen, never a wider one.
import { useQuery } from "@tanstack/react-query";
import { supabase } from "./supabase";
import { isMissingFunction } from "./schemaErrors";

export interface StgJob {
  id: string;
  name: string;
  job_code: string;
  status: string;
  progress_percent: number;
  window_start: string | null;
  window_end: string | null;
}

export type StgCalendarKind = "window" | "delivery" | "worked";

export interface StgCalendarEntry {
  project_id: string;
  kind: StgCalendarKind;
  on_date: string | null;
  from_date: string | null;
  to_date: string | null;
  label: string | null;
}

export interface StgDayLog {
  headline: string | null;
  notes: string;
  day_flow: "smooth" | "fine" | "stuck" | null;
}

export interface StgDayPayload {
  worked: boolean;
  crew_names: string[];
  total_hours: number;
  units_finished: number;
  log: StgDayLog | null;
}

export async function stgJobList(): Promise<StgJob[]> {
  const { data, error } = await supabase.rpc("stg_job_list");
  if (isMissingFunction(error)) return [];
  if (error) throw error;
  return (data ?? []) as StgJob[];
}

export async function stgCalendar(from: string, to: string): Promise<StgCalendarEntry[]> {
  const { data, error } = await supabase.rpc("stg_calendar", { p_from: from, p_to: to });
  if (isMissingFunction(error)) return [];
  if (error) throw error;
  return (data ?? []) as StgCalendarEntry[];
}

const EMPTY_DAY: StgDayPayload = {
  worked: false,
  crew_names: [],
  total_hours: 0,
  units_finished: 0,
  log: null,
};

export async function stgDay(projectId: string, date: string): Promise<StgDayPayload> {
  const { data, error } = await supabase.rpc("stg_day", {
    p_project: projectId,
    p_date: date,
  });
  if (isMissingFunction(error)) return EMPTY_DAY;
  if (error) throw error;
  return data as StgDayPayload;
}

/**
 * "Am I a partner?" — the router redirect (S4) and the day-to-day /stg
 * screens all key off this, never off `profiles.is_partner` directly: that
 * column is invisible to a partner reading their own row once THE WALL
 * lands (is_partner_user()'s own comment explains why), so this RPC is the
 * only way a partner's own session can answer the question. Fails to
 * `false` on error, so a transient network hiccup never bounces a signed-in
 * CREW member (the much larger, more frequent case) out of their own app —
 * react-query's default retry then resolves it. The one-sided risk this
 * accepts is a partner briefly seeing crew chrome during that same hiccup;
 * that costs them nothing real, because every crew table stays walled off
 * server-side (S1) regardless of what this client-side flag says — this
 * hook decides which SHELL renders, not what data anyone can reach.
 */
export function useIsPartnerUser() {
  return useQuery({
    queryKey: ["isPartnerUser"],
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase.rpc("is_partner_user");
      if (error) return false;
      return Boolean(data);
    },
  });
}
